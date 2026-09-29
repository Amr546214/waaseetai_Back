import { Prisma, WithdrawalStatus, PayoutAttemptStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { isRetryableTransactionConflict } from '../utils/prisma-retry.util';
import { deriveSenderBatchId } from '../utils/payout-attempt.util';
import {
	paypalService,
	type CreatePayoutParams,
	type PaypalPayoutCreateResult,
	type PaypalPayoutItemResult
} from './paypal.service';
import { logger } from '../config/logger';

// Same bound as withdrawal.service.ts's SERIALIZABLE retry loop — kept
// separate rather than shared/imported, since this constant is small and
// each call site owns its own retry ceiling.
const MAX_SERIALIZATION_RETRIES = 3;

// Payout P2-C: sendPayout()'s own local, pre-initializeSendPayout()
// validation — see sendPayout()'s own comment for why checking these
// specific fields here is safe. Kept identical in spirit to
// paypal.service.ts's own recipientEmail check (createPayout() re-validates
// independently too — this is deliberate defense-in-depth, not trust that
// one makes the other redundant).
const PAYOUT_RECIPIENT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUPPORTED_PAYOUT_METHOD = 'paypal';
const SUPPORTED_PAYOUT_CURRENCY = 'USD';
const SUPPORTED_PAYOUT_PROVIDER = 'PAYPAL';

// Payout P3-C: PayPal's documented Payouts idempotency guarantee for a given
// sender_batch_id is bounded to roughly the last 30 days — recoverPayoutBySenderBatch()
// itself has no timestamp context (see its own doc comment) and relies
// entirely on ITS caller to enforce this. This is that caller. Measured
// against the durable PayoutAttempt.createdAt ONLY — never
// Withdrawal.updatedAt, never any request-supplied timestamp. Boundary rule
// (deliberately conservative, chosen and documented per this task's own
// instruction): age >= 30 days => do NOT resubmit. An attempt created
// exactly 30 days ago is treated as already outside the safe window, not
// inside it — the safe side of an ambiguous boundary.
const SENDER_BATCH_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Payout P3-C: the outcome of one reconcilePayoutAttempt() call. Every
 * member is a RESULT, never a thrown exception, except for a genuinely
 * missing attemptId/withdrawal (a caller error, not a reconciliation
 * finding) — see reconcilePayoutAttempt()'s own doc comment.
 *
 *  - COMPLETED / FAILED / REVERSED: a real (or already-idempotent) terminal
 *    local state, backed by authoritative PayPal item-level evidence.
 *  - STILL_PROCESSING: PayPal itself reports the item is still in flight
 *    (PENDING) — no local transition of any kind.
 *  - ACTION_REQUIRED: PayPal reports UNCLAIMED — the recipient, not this
 *    system, must act next; provider notification is explicitly out of
 *    P3-C's scope.
 *  - ADMIN_REVIEW: ONHOLD, BLOCKED, any local-validation ineligibility, any
 *    identifier contradiction/correlation failure, or any other anomaly
 *    that must never be resolved automatically.
 *  - RECOVERY_WINDOW_EXPIRED: a PENDING attempt with no payoutBatchId whose
 *    createdAt is already outside PayPal's documented safe resubmission
 *    window — recovery is deliberately never attempted.
 *  - UNKNOWN: the PayPal transport itself could not prove anything (see
 *    paypal.service.ts's own UNKNOWN semantics) — never treated as failure
 *    or success.
 */
export type ReconciliationOutcome =
	| 'COMPLETED'
	| 'FAILED'
	| 'REVERSED'
	| 'STILL_PROCESSING'
	| 'ACTION_REQUIRED'
	| 'ADMIN_REVIEW'
	| 'RECOVERY_WINDOW_EXPIRED'
	| 'UNKNOWN';

/** Never exposes recipient email, raw PayPal body, debug_id, access token, or arbitrary PayPal reason text — `message` is always one of this file's own fixed, pre-written strings. */
export interface ReconcilePayoutAttemptResult {
	outcome: ReconciliationOutcome;
	attemptId: string;
	withdrawalId: string;
	message: string;
	/**
	 * Post-adversarial-review addition: the PayoutAttempt's ACTUAL local
	 * status at the moment this result is returned (after any real
	 * transition this call itself performed — otherwise unchanged from
	 * before the call). Exists specifically so an outcome like
	 * STILL_PROCESSING can never be misread as "the DB row is in
	 * PROCESSING" when it may genuinely still be PENDING (a PayPal item
	 * report of PENDING/UNCLAIMED/ONHOLD/BLOCKED never promotes PENDING to
	 * PROCESSING — only initializeSendPayout()/markAttemptAccepted() may
	 * ever do that). A caller that needs to know the true local state must
	 * read this field, never infer it from `outcome` alone.
	 */
	localStatus: PayoutAttemptStatus;
}

export type SendPayoutResult =
  | { outcome: 'ACCEPTED'; withdrawalId: string; payoutAttemptId: string; payoutBatchId: string; message: string }
  | { outcome: 'UNKNOWN'; withdrawalId: string; payoutAttemptId: string; message: string }
  | { outcome: 'DEFINITELY_REJECTED'; withdrawalId: string; payoutAttemptId: string; message: string };

/**
 * Postgres unique-index/constraint names this transaction can hit, exactly
 * as Prisma itself names them for this schema (confirmed offline via
 * `prisma migrate diff --from-empty --to-schema=prisma/schema.prisma
 * --script`, never against a live database):
 *
 *  - "active_attempt_unique"                          — the Issue-2 partial
 *    unique index (at most one PENDING/PROCESSING PayoutAttempt per
 *    withdrawal). A P2002 here means a real, correct business conflict:
 *    another attempt is already active. Must NOT be retried.
 *
 *  - "payout_attempts_withdrawalId_attemptNumber_key"  — the Issue-3
 *    attempt-history constraint.
 *  - "payout_attempts_senderBatchId_key"               — since
 *    senderBatchId is a pure function of (withdrawalId, attemptNumber),
 *    a genuine attemptNumber-allocation race can legitimately hit EITHER
 *    of these two for the same underlying reason. Both mean: two
 *    concurrent initializations computed the same next attemptNumber:
 *    retry the WHOLE transaction so it recomputes a fresh number.
 */
const ACTIVE_ATTEMPT_CONSTRAINT = 'active_attempt_unique';
const ATTEMPT_NUMBER_RACE_CONSTRAINTS = new Set([
	'payout_attempts_withdrawalId_attemptNumber_key',
	'payout_attempts_senderBatchId_key'
]);

type InitializationConflict = 'ACTIVE_ATTEMPT_EXISTS' | 'ATTEMPT_NUMBER_RACE' | null;

/**
 * Extracts every string that could identify the violated constraint/index
 * or column(s) from a P2002's metadata, across the TWO shapes now confirmed
 * (Payout P1.1 follow-up — see classifyInitializationConflict()'s own
 * comment for the empirical finding that prompted this):
 *
 *  1. The "standard" documented Prisma shape: `error.meta.target`, a bare
 *     string or an array of strings (index name and/or column names,
 *     depending on Prisma version/connector).
 *
 *  2. The shape CONFIRMED on a real DEV Postgres run with this project's
 *     exact Prisma 7.8.0 + @prisma/adapter-pg combination: `meta.target` is
 *     `undefined` for a driver-adapter-surfaced unique violation; the
 *     identification lives instead at `meta.driverAdapterError.cause`. Two
 *     independent signals are pulled from there:
 *       - the constraint/index NAME, parsed out of Postgres's own stable,
 *         long-documented error wording — `duplicate key value violates
 *         unique constraint "<name>"` — confirmed verbatim in the real
 *         error observed for both `active_attempt_unique` and
 *         `payout_attempts_senderBatchId_key`. This is the precise signal:
 *         once extracted, it matches the SAME known-constraint-name checks
 *         below exactly like `meta.target` already did for shape 1.
 *       - `cause.constraint.fields`, the raw column-name array (Postgres
 *         quotes each entry, e.g. `'"senderBatchId"'`; quotes are stripped)
 *         — a secondary fallback signal, feeding the SAME pre-existing
 *         field-name heuristic already used for shape 1's field-array case.
 *
 * Both shapes' candidates are pooled together; nothing here decides
 * classification — that stays entirely in classifyInitializationConflict(),
 * unchanged. If neither shape yields a recognizable candidate (a malformed/
 * missing meta, or a P2002 unrelated to this transaction's own known
 * constraints), this simply returns an empty array, and the caller's
 * existing safe fallback (never guess, never blindly retry) applies exactly
 * as before.
 */
function extractConflictCandidates(error: Prisma.PrismaClientKnownRequestError): string[] {
	const candidates: string[] = [];

	const target = (error.meta as { target?: unknown } | undefined)?.target;
	if (typeof target === 'string') candidates.push(target);
	else if (Array.isArray(target)) candidates.push(...target.filter((t): t is string => typeof t === 'string'));

	const driverCause = (error.meta as { driverAdapterError?: { cause?: unknown } } | undefined)?.driverAdapterError?.cause;
	if (driverCause && typeof driverCause === 'object') {
		const cause = driverCause as { originalMessage?: unknown; constraint?: { fields?: unknown } };
		if (typeof cause.originalMessage === 'string') {
			const nameMatch = cause.originalMessage.match(/unique constraint "([^"]+)"/);
			if (nameMatch) candidates.push(nameMatch[1]);
		}
		if (cause.constraint && typeof cause.constraint === 'object' && Array.isArray(cause.constraint.fields)) {
			candidates.push(...cause.constraint.fields
				.filter((f): f is string => typeof f === 'string')
				.map(f => f.replace(/^"|"$/g, '')));
		}
	}

	return candidates;
}

/**
 * Classifies a P2002 raised during initializeSendPayout() by inspecting
 * Prisma's own error metadata for the violated constraint/index name.
 *
 * EMPIRICAL FINDING (Payout P1.1 — supersedes the original "honest
 * limitation" this comment used to document): a real DEV Postgres
 * concurrency run surfaced a genuine P2002 from two concurrent
 * initializeSendPayout() calls, and confirmed that with this project's
 * exact Prisma 7.8.0 + @prisma/adapter-pg combination, `error.meta.target`
 * is NOT populated at all — the violated-constraint identification instead
 * lives under `error.meta.driverAdapterError.cause` (see
 * extractConflictCandidates() above for exactly how both this shape and the
 * originally-assumed `meta.target` shape are read). This function's own
 * classification logic is UNCHANGED by that fix — it still only recognizes
 * the specific known constraint names/field-name patterns below and returns
 * `null` (unclassified) for everything else; only the SOURCE the candidate
 * strings are pulled from was corrected. The caller still MUST treat a
 * `null` result as an unknown error and propagate it unmodified, never
 * silently retry or silently convert it to a business error — that safe
 * fallback is deliberately preserved, not weakened, by this fix.
 */
function classifyInitializationConflict(error: unknown): InitializationConflict {
	if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;

	const candidates = extractConflictCandidates(error);

	if (candidates.includes(ACTIVE_ATTEMPT_CONSTRAINT)) return 'ACTIVE_ATTEMPT_EXISTS';
	if (candidates.some(c => ATTEMPT_NUMBER_RACE_CONSTRAINTS.has(c))) return 'ATTEMPT_NUMBER_RACE';

	// Field-name fallback: some Prisma/driver combinations report the
	// column list instead of (or alongside) the index name. `withdrawalId`
	// alone (no `attemptNumber`) can only come from the partial index,
	// since the composite constraint always includes both fields.
	if (candidates.includes('withdrawalId') && !candidates.includes('attemptNumber') && !candidates.includes('senderBatchId')) {
		return 'ACTIVE_ATTEMPT_EXISTS';
	}
	if (candidates.includes('attemptNumber') || candidates.includes('senderBatchId')) {
		return 'ATTEMPT_NUMBER_RACE';
	}

	return null;
}

export class PayoutService {
	/**
	 * Local state-machine primitive only — makes NO external call. Creates a
	 * durable PayoutAttempt row and transitions the Withdrawal to PROCESSING,
	 * both inside one SERIALIZABLE transaction, so that if the process
	 * crashes immediately after this commits (before any future external
	 * call P2 will make), the withdrawal is already correctly reserved and
	 * unavailable for a second attempt — see the approved design's Issue 5
	 * (crash-safety ordering) and Issue 2 (the DB backstop this relies on).
	 */
	async initializeSendPayout(withdrawalId: string): Promise<{ id: string; withdrawalId: string; attemptNumber: number; senderBatchId: string; status: PayoutAttemptStatus }> {
		for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
			try {
				return await prisma.$transaction(async tx => {
					const withdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
					if (!withdrawal) throw new AppError('طلب السحب غير موجود', 404);
					if (withdrawal.status !== WithdrawalStatus.APPROVED) {
						throw new AppError('طلب السحب يجب أن يكون معتمداً قبل بدء التحويل', 409);
					}

					// Fast-path pre-check — an optimization only, saving a doomed
					// INSERT in the common case. The real guarantee is the
					// active_attempt_unique partial index below; this check
					// racing and missing is exactly what that index exists to
					// catch instead.
					const existingActive = await tx.payoutAttempt.findFirst({
						where: { withdrawalId, status: { in: [PayoutAttemptStatus.PENDING, PayoutAttemptStatus.PROCESSING] } },
						select: { id: true }
					});
					if (existingActive) {
						throw new AppError('يوجد بالفعل تحويل نشط لهذا الطلب', 409);
					}

					const priorAttemptCount = await tx.payoutAttempt.count({ where: { withdrawalId } });
					const attemptNumber = priorAttemptCount + 1;
					const senderBatchId = deriveSenderBatchId(withdrawalId, attemptNumber);

					// This INSERT is protected by BOTH @@unique([withdrawalId, attemptNumber])
					// and @@unique([senderBatchId]) — either alone would already stop a
					// genuine attemptNumber race; both exist because they're derived
					// from the same two inputs and a race could legitimately surface
					// as either one, depending on which index Postgres checks first.
					const payoutAttempt = await tx.payoutAttempt.create({
						data: { withdrawalId, provider: 'PAYPAL', attemptNumber, senderBatchId, status: PayoutAttemptStatus.PENDING }
					});

					// CRITICAL (per the approved design): this update MUST return
					// count === 1. If the Withdrawal's status changed out from under
					// us between the read above and this write (e.g. concurrently
					// rejected), the ENTIRE transaction — including the PayoutAttempt
					// just created above — rolls back. There must never be an orphan
					// PayoutAttempt left behind when this Withdrawal transition fails.
					const transition = await tx.withdrawal.updateMany({
						where: { id: withdrawalId, status: WithdrawalStatus.APPROVED },
						data: { status: WithdrawalStatus.PROCESSING }
					});
					if (transition.count !== 1) {
						throw new AppError('تعذر تحويل حالة طلب السحب — قد تكون تغيّرت في نفس اللحظة', 409);
					}

					return payoutAttempt;
				}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
			} catch (error) {
				if (isRetryableTransactionConflict(error) && attempt < MAX_SERIALIZATION_RETRIES) continue;

				const conflict = classifyInitializationConflict(error);
				if (conflict === 'ATTEMPT_NUMBER_RACE' && attempt < MAX_SERIALIZATION_RETRIES) continue;
				if (conflict === 'ACTIVE_ATTEMPT_EXISTS') {
					throw new AppError('يوجد بالفعل تحويل نشط لهذا الطلب', 409);
				}

				// Unknown P2002, unknown DB error, exhausted retries, or a plain
				// AppError from inside the transaction — all propagate unmodified.
				// Nothing here is ever silently swallowed.
				throw error;
			}
		}
		// Unreachable in practice — the loop above always returns or throws on
		// its final attempt — kept only to satisfy TypeScript's control-flow
		// analysis, matching withdrawal.service.ts's identical precedent.
		throw new AppError('تعذر بدء التحويل بعد عدة محاولات متزامنة، حاول مرة أخرى', 409);
	}

	/**
	 * Payout P2-C: the ONE orchestration entry point that actually sends a
	 * previously-approved withdrawal's money via PayPal. Deliberately kept as
	 * a SEPARATE admin action from withdrawal.service.ts's approve() —
	 * approving only means "this provider is entitled to this money"; it says
	 * nothing about actually moving it. Combining the two would remove an
	 * admin's ability to approve now and send later, and would tangle two
	 * very differently-shaped operations (a pure local decision vs. a real
	 * external side effect) into one. This method must never be called from,
	 * or merged into, approve()/reject(), and vice versa.
	 *
	 * ── Local validation BEFORE initializeSendPayout() — why this is SAFE ──
	 * method/paypalEmail/amount/currency are all IMMUTABLE on a Withdrawal
	 * row once created (confirmed by inspection of every write path in
	 * withdrawal.service.ts: createForProvider() sets them once; approve()/
	 * reject() only ever touch status/reviewedById/adminNote/rejectionReason
	 * — never these four columns). Reading them here via a plain,
	 * non-transactional findUnique() therefore carries ZERO staleness risk,
	 * unlike `status`, which IS actively mutated by approve()/reject()/
	 * initializeSendPayout() itself and MUST stay decided exclusively inside
	 * initializeSendPayout()'s own SERIALIZABLE transaction. This pre-check
	 * makes no status-transition DECISION at all — it only cheaply rejects,
	 * with zero side effect, a withdrawal that could never legitimately be
	 * paid out via PayPal regardless of its current status, sparing it an
	 * unnecessary APPROVED -> PROCESSING flip (and a wasted PayoutAttempt
	 * row) for a condition that will never change. The authoritative "is
	 * this APPROVED right now, and can I safely claim it" decision remains
	 * entirely inside initializeSendPayout(): if status changed between this
	 * read and that call (a genuinely concurrent second admin action),
	 * initializeSendPayout() still correctly rejects with 409, exactly as it
	 * already does today — this pre-check cannot weaken or bypass that.
	 */
	async sendPayout(withdrawalId: string): Promise<SendPayoutResult> {
		const withdrawal = await prisma.withdrawal.findUnique({
			where: { id: withdrawalId },
			select: { id: true, method: true, amount: true, currency: true, paypalEmail: true }
		});
		if (!withdrawal) {
			throw new AppError('طلب السحب غير موجود', 404);
		}
		if (withdrawal.method !== SUPPORTED_PAYOUT_METHOD) {
			throw new AppError('طلب السحب ليس عبر PayPal — لا يمكن إرساله عبر بوابة PayPal', 400);
		}
		if (!withdrawal.paypalEmail || !PAYOUT_RECIPIENT_EMAIL_PATTERN.test(withdrawal.paypalEmail)) {
			throw new AppError('لا يوجد بريد PayPal صالح مسجل لهذا الطلب', 400);
		}
		if (typeof withdrawal.amount !== 'number' || !Number.isFinite(withdrawal.amount) || withdrawal.amount <= 0) {
			throw new AppError('مبلغ طلب السحب غير صالح للتحويل', 400);
		}
		if (withdrawal.currency !== SUPPORTED_PAYOUT_CURRENCY) {
			throw new AppError('عملة طلب السحب غير مدعومة لتحويلات PayPal (المدعوم: USD فقط)', 400);
		}

		// Durable local reservation BEFORE any external call. Unchanged P1
		// primitive: re-validates status===APPROVED and active-attempt
		// exclusivity atomically, inside its own SERIALIZABLE transaction —
		// see this method's own doc comment above.
		const payoutAttempt = await this.initializeSendPayout(withdrawalId);

		// Exactly ONE PayPal call — no loop, no retry. recipientEmail/amount
		// come ONLY from the immutable withdrawal row read above (never a live
		// ProviderProfile lookup, never User.email, never anything from an
		// HTTP request body — this method takes no such parameter at all).
		// senderBatchId/senderItemId come ONLY from the PayoutAttempt
		// initializeSendPayout() just created.
		const createPayoutParams: CreatePayoutParams = {
			senderBatchId: payoutAttempt.senderBatchId,
			senderItemId: payoutAttempt.id,
			recipientEmail: withdrawal.paypalEmail,
			amount: withdrawal.amount
		};

		let result: PaypalPayoutCreateResult;
		try {
			result = await paypalService.createPayout(createPayoutParams);
		} catch (error) {
			// Exception safety: createPayout()'s own contract is to RETURN a
			// classified result, never throw, for anything it can classify — an
			// unexpected throw here is itself just another unclassified,
			// ambiguous outcome. Never assume failure: fold it into the exact
			// same UNKNOWN handling below, with no separate/duplicated logic.
			logger.warn(`sendPayout: createPayout() threw unexpectedly for PayoutAttempt ${payoutAttempt.id} (withdrawal ${withdrawalId}) — treating as UNKNOWN, no state change: ${error instanceof Error ? error.message : String(error)}`);
			result = { outcome: 'UNKNOWN', reason: 'غير متوقع أثناء الاتصال ببوابة PayPal' };
		}

		if (result.outcome === 'ACCEPTED') {
			try {
				await this.markAttemptAccepted(payoutAttempt.id, result.payoutBatchId);
			} catch (error) {
				// PayPal has DEFINITELY accepted this payout (a real
				// payoutBatchId is in hand) but recording that locally just
				// failed. NEVER retry PayPal here — the external payout may
				// already exist, and a second call could double-pay. NEVER
				// create a new attempt. NEVER mark this attempt FAILED (it did
				// not fail — the opposite happened and we simply couldn't
				// record it). NEVER return the Withdrawal to APPROVED (letting
				// an admin re-click "send" must not be able to fire a second
				// real PayPal payout for money that may already be in flight).
				//
				// Durable state left behind: this failed update's own
				// transaction rolled back, so PayoutAttempt stays PENDING and
				// Withdrawal stays PROCESSING — and critically,
				// payoutAttempt.senderBatchId is ALREADY durably committed
				// (from initializeSendPayout(), before this ever ran). That
				// senderBatchId remains a valid, sufficient key for a future P3
				// reconciliation process to look this exact batch up directly
				// against PayPal's own API later — so payoutBatchId not being
				// persisted here is a genuine P3 reconciliation requirement,
				// not silent, unrecoverable data loss. Logged here (server-side
				// only, never in the client response) specifically so that
				// requirement has an out-of-band paper trail even without a
				// dedicated reconciliation system existing yet.
				logger.error(
					`sendPayout: markAttemptAccepted() failed AFTER PayPal ACCEPTED — PayoutAttempt ${payoutAttempt.id}, senderBatchId=${payoutAttempt.senderBatchId}, payoutBatchId=${result.payoutBatchId}, withdrawal=${withdrawalId}. payoutBatchId could NOT be persisted; P3 reconciliation must look this batch up via senderBatchId. Underlying error: ${error instanceof Error ? error.message : String(error)}`
				);
				throw new AppError(
					'تم قبول التحويل من PayPal لكن تعذر تسجيله محلياً — الحالة محفوظة وتتطلب مراجعة يدوية، لا تكرر الإرسال',
					500
				);
			}
			return {
				outcome: 'ACCEPTED',
				withdrawalId,
				payoutAttemptId: payoutAttempt.id,
				payoutBatchId: result.payoutBatchId,
				message: 'تم إرسال طلب التحويل إلى PayPal بنجاح وهو الآن قيد المعالجة'
			};
		}

		if (result.outcome === 'UNKNOWN') {
			// Do NOTHING to the state machine — PayoutAttempt stays PENDING,
			// Withdrawal stays PROCESSING. No markAttemptDefinitelyFailed(), no
			// markAttemptCompleted(), no reopening to APPROVED, no new attempt.
			// The raw PayPal reason is deliberately never included in this
			// response.
			return {
				outcome: 'UNKNOWN',
				withdrawalId,
				payoutAttemptId: payoutAttempt.id,
				message: 'نتيجة التحويل غير مؤكدة من PayPal — الطلب قيد المراجعة اليدوية ولن تتم إعادة المحاولة تلقائياً'
			};
		}

		// result.outcome === 'DEFINITELY_REJECTED': P2-B's current
		// implementation has NO runtime path that produces this outcome
		// (confirmed: zero `outcome: 'DEFINITELY_REJECTED'` returns anywhere in
		// paypal.service.ts as of this writing) — this branch exists ONLY so
		// the union stays exhaustively handled here, so a FUTURE, separately
		// audited P2-B version that does add a genuine DEFINITELY_REJECTED
		// path is already wired up correctly without another P2-C change. No
		// new rejection classifier of any kind is introduced in this file.
		// (This method's explicit `Promise<SendPayoutResult>` return type is
		// itself the exhaustiveness guard: if PaypalPayoutCreateResult ever
		// gains a fourth outcome member without a corresponding branch here,
		// `result` would no longer be narrowed to DEFINITELY_REJECTED at this
		// point and `result.reason`/`tsc --noEmit` would fail to compile.)
		await this.markAttemptDefinitelyFailed(payoutAttempt.id, result.reason);
		return {
			outcome: 'DEFINITELY_REJECTED',
			withdrawalId,
			payoutAttemptId: payoutAttempt.id,
			message: 'تم رفض طلب التحويل من PayPal بشكل نهائي'
		};
	}

	/**
	 * PENDING -> PROCESSING. Called once a future external call (P2) has
	 * synchronously confirmed acceptance. Purely local — this method does
	 * not itself determine PayPal truth, it only records information the
	 * caller already has.
	 */
	async markAttemptAccepted(attemptId: string, payoutBatchId?: string) {
		return prisma.$transaction(async tx => {
			const transition = await tx.payoutAttempt.updateMany({
				where: { id: attemptId, status: PayoutAttemptStatus.PENDING },
				data: { status: PayoutAttemptStatus.PROCESSING, ...(payoutBatchId ? { payoutBatchId } : {}) }
			});
			if (transition.count !== 1) {
				const current = await tx.payoutAttempt.findUnique({ where: { id: attemptId } });
				if (!current) throw new AppError('محاولة التحويل غير موجودة', 404);
				throw new AppError(`لا يمكن تأكيد القبول — حالة المحاولة الحالية (${current.status}) ليست بانتظار القبول`, 409);
			}
			return tx.payoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });
		});
	}

	/**
	 * PENDING/PROCESSING -> FAILED, and Withdrawal PROCESSING -> APPROVED,
	 * atomically. Terminal for this attempt — the approved design is explicit
	 * that a retry is always a NEW PayoutAttempt row (see initializeSendPayout),
	 * never a status change on this one.
	 *
	 * Idempotency (per the approved design's Issue 7):
	 *  - a duplicate failure call (attempt already FAILED) is a safe no-op
	 *  - failure must NEVER downgrade an attempt that already reached
	 *    COMPLETED — also a safe no-op, the completed state is preserved
	 *  - only PENDING/PROCESSING -> FAILED is a real transition; anything
	 *    else here is a no-op, not an error, since "this is already resolved"
	 *    is an entirely legitimate reason for this to be called twice (e.g. a
	 *    duplicate webhook delivery arriving after a prior definitive failure)
	 */
	async markAttemptDefinitelyFailed(attemptId: string, failureReason: string) {
		return prisma.$transaction(async tx => {
			const transition = await tx.payoutAttempt.updateMany({
				where: { id: attemptId, status: { in: [PayoutAttemptStatus.PENDING, PayoutAttemptStatus.PROCESSING] } },
				data: { status: PayoutAttemptStatus.FAILED, failureReason }
			});

			if (transition.count === 1) {
				const attempt = await tx.payoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });
				// Payout P3-C hardening: verified, not left unchecked as before —
				// see markAttemptReversed()'s identical pattern/reasoning. P3-C now
				// calls this primitive based on external PayPal truth, so a silent
				// half-transition (PayoutAttempt FAILED while its Withdrawal stays
				// PROCESSING, never reopened to APPROVED) is no longer an
				// acceptable pre-existing quirk — it would strand the withdrawal
				// unable to ever be sent again. If the Withdrawal cannot transition,
				// the WHOLE transaction rolls back, including the PayoutAttempt
				// write above.
				const withdrawalTransition = await tx.withdrawal.updateMany({
					where: { id: attempt.withdrawalId, status: WithdrawalStatus.PROCESSING },
					data: { status: WithdrawalStatus.APPROVED }
				});
				if (withdrawalTransition.count !== 1) {
					throw new AppError('تعذر تسجيل فشل التحويل — حالة طلب السحب لا تتطابق مع حالة المحاولة (تعارض في البيانات يتطلب مراجعة يدوية)', 409);
				}
				return attempt;
			}

			// count === 0: the attempt was already terminal (or doesn't exist).
			// Read the current state to distinguish a safe no-op from a real error.
			const current = await tx.payoutAttempt.findUnique({ where: { id: attemptId } });
			if (!current) throw new AppError('محاولة التحويل غير موجودة', 404);
			// Already FAILED (duplicate), already COMPLETED, or (Payout P3-A)
			// already REVERSED — all three must never be downgraded to FAILED by
			// this method; every one is a safe no-op, returning the row
			// unchanged.
			return current;
		});
	}

	/**
	 * PENDING/PROCESSING -> COMPLETED, and Withdrawal PROCESSING -> COMPLETED,
	 * atomically. Authoritative — callers (future P2/P3) must only invoke this
	 * with genuinely authoritative evidence (a verified webhook or a
	 * reconciliation lookup); this method itself performs no verification of
	 * that evidence, per this batch's explicit scope.
	 *
	 * Idempotency (per the approved design's Issue 7):
	 *  - a duplicate completion call (attempt already COMPLETED) is a safe no-op
	 *  - a completion call for an attempt that's already FAILED is explicitly
	 *    NOT allowed to resurrect it — the approved design states a FAILED
	 *    attempt is terminal and a retry is always a new attempt row, so
	 *    "authoritative success arriving after we already recorded failure"
	 *    was not established as a possible case. Per the design's own
	 *    instruction ("otherwise reject/no-op and document it"), this
	 *    implementation REJECTS (throws) rather than silently no-ops, since a
	 *    completion signal contradicting our own FAILED record is a genuinely
	 *    anomalous, money-relevant mismatch that deserves visibility — a
	 *    silent no-op would hide it from whoever needs to investigate.
	 */
	async markAttemptCompleted(attemptId: string, options: { payoutItemId?: string; rawResponse?: Prisma.InputJsonValue } = {}) {
		return prisma.$transaction(async tx => {
			const transition = await tx.payoutAttempt.updateMany({
				where: { id: attemptId, status: { in: [PayoutAttemptStatus.PENDING, PayoutAttemptStatus.PROCESSING] } },
				data: {
					status: PayoutAttemptStatus.COMPLETED,
					completedAt: new Date(),
					...(options.payoutItemId ? { payoutItemId: options.payoutItemId } : {}),
					...(options.rawResponse !== undefined ? { rawResponse: options.rawResponse } : {})
				}
			});

			if (transition.count === 1) {
				const attempt = await tx.payoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });
				// Payout P3-C hardening: verified, not left unchecked as before —
				// see markAttemptReversed()'s identical pattern/reasoning. P3-C now
				// calls this primitive based on external PayPal truth, so a silent
				// half-transition (PayoutAttempt COMPLETED while its Withdrawal
				// never reaches COMPLETED) is no longer an acceptable pre-existing
				// quirk. If the Withdrawal cannot transition, the WHOLE transaction
				// rolls back, including the PayoutAttempt write above.
				const withdrawalTransition = await tx.withdrawal.updateMany({
					where: { id: attempt.withdrawalId, status: WithdrawalStatus.PROCESSING },
					data: { status: WithdrawalStatus.COMPLETED }
				});
				if (withdrawalTransition.count !== 1) {
					throw new AppError('تعذر تسجيل اكتمال التحويل — حالة طلب السحب لا تتطابق مع حالة المحاولة (تعارض في البيانات يتطلب مراجعة يدوية)', 409);
				}
				return attempt;
			}

			const current = await tx.payoutAttempt.findUnique({ where: { id: attemptId } });
			if (!current) throw new AppError('محاولة التحويل غير موجودة', 404);
			if (current.status === PayoutAttemptStatus.COMPLETED) {
				// Duplicate completion — safe no-op.
				return current;
			}
			// current.status === FAILED, or (Payout P3-A) REVERSED — neither may
			// ever be resurrected into COMPLETED by this method. REVERSED in
			// particular must stay reachable ONLY via markAttemptReversed()'s own
			// COMPLETED -> REVERSED transition below — never re-completed here.
			throw new AppError('لا يمكن تعليم محاولة تحويل فاشلة كمكتملة — يجب أن تبدأ محاولة جديدة', 409);
		});
	}

	/**
	 * Payout P3-A: COMPLETED -> REVERSED, and Withdrawal COMPLETED ->
	 * REVERSED, atomically. The ONE deliberate, narrow exception to every
	 * other primitive's rule that COMPLETED is permanently final —
	 * markAttemptCompleted()'s and markAttemptDefinitelyFailed()'s own
	 * guards above are completely untouched and still refuse this in every
	 * other direction; no other primitive may ever move a row out of
	 * COMPLETED.
	 *
	 * Represents PayPal reporting, AFTER a payout already succeeded, that
	 * the money was subsequently returned/refunded/reversed — see
	 * WithdrawalStatus.REVERSED/PayoutAttemptStatus.REVERSED/
	 * PayoutAttempt.paypalTerminalStatus's own schema comments for the full
	 * reasoning. This is fundamentally NOT the same fact as
	 * markAttemptDefinitelyFailed()'s FAILED (money never left at all): that
	 * safely reopens the Withdrawal to APPROVED because a retry is a
	 * legitimate next step; a reversal must NEVER do that, because real
	 * money already moved once and an automatic reopen risks a genuine
	 * second real payout for funds that may or may not have actually been
	 * recovered.
	 *
	 * STATE RECORDING ONLY, per this batch's explicit scope: this method
	 * performs no wallet/balance accounting whatsoever — it does not credit,
	 * debit, or otherwise adjust anything beyond PayoutAttempt.status/
	 * paypalTerminalStatus and Withdrawal.status. How (or whether) a
	 * provider's balance is ever adjusted for returned money is a decision
	 * for a later phase, not invented here. It also never creates a new
	 * PayoutAttempt and never calls initializeSendPayout() — a reversal is
	 * recorded against the EXISTING attempt that actually completed, never
	 * a fresh one.
	 *
	 * Idempotency: a duplicate reversal call (attempt already REVERSED, AND
	 * its Withdrawal already REVERSED too) is a safe no-op, mirroring
	 * markAttemptCompleted()'s/markAttemptDefinitelyFailed()'s own
	 * established duplicate-call conventions. PENDING/PROCESSING/FAILED are
	 * never valid sources for this transition — reachable ONLY from
	 * COMPLETED, since a reversal is only a meaningful concept for a payout
	 * that actually succeeded first.
	 *
	 * Atomicity (financial-invariant hardening): unlike
	 * markAttemptCompleted()/markAttemptDefinitelyFailed() above — which
	 * both leave their own Withdrawal-side conditional update unverified,
	 * an established (if imperfect) pre-existing pattern this method
	 * deliberately does NOT copy here — this NEW primitive explicitly
	 * verifies the Withdrawal transition's own result count. If the
	 * PayoutAttempt genuinely was COMPLETED but its Withdrawal was NOT (a
	 * real data-integrity anomaly, since markAttemptCompleted() always
	 * moves both together), this throws and the WHOLE transaction rolls
	 * back — the PayoutAttempt's COMPLETED -> REVERSED write above is
	 * undone with it. After this method successfully returns, both
	 * PayoutAttempt.status === REVERSED and Withdrawal.status === REVERSED
	 * are guaranteed true together, or neither transition ever committed.
	 */
	async markAttemptReversed(attemptId: string, paypalTerminalStatus: string) {
		return prisma.$transaction(async tx => {
			const transition = await tx.payoutAttempt.updateMany({
				where: { id: attemptId, status: PayoutAttemptStatus.COMPLETED },
				data: { status: PayoutAttemptStatus.REVERSED, paypalTerminalStatus }
			});

			if (transition.count === 1) {
				const attempt = await tx.payoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });
				const withdrawalTransition = await tx.withdrawal.updateMany({
					where: { id: attempt.withdrawalId, status: WithdrawalStatus.COMPLETED },
					data: { status: WithdrawalStatus.REVERSED }
				});
				if (withdrawalTransition.count !== 1) {
					// The PayoutAttempt really was COMPLETED, but its own
					// Withdrawal was not — this should be unreachable under
					// normal operation (markAttemptCompleted() always moves both
					// together), so this is a genuine data-integrity anomaly, not
					// a business-as-usual conflict. Throwing here rolls back the
					// ENTIRE transaction, including the PayoutAttempt update
					// above — it must never be left REVERSED by itself while its
					// Withdrawal stays COMPLETED (or anything else).
					throw new AppError('تعذر تسجيل استرجاع التحويل — حالة طلب السحب لا تتطابق مع حالة المحاولة (تعارض في البيانات يتطلب مراجعة يدوية)', 409);
				}
				return attempt;
			}

			// count === 0: either already REVERSED (a safe no-op — e.g. a
			// redelivered webhook reporting the same reversal twice) or never
			// reached COMPLETED at all (PENDING/PROCESSING/FAILED), which is a
			// genuine caller error — a reversal is only meaningful for a payout
			// that actually succeeded.
			const current = await tx.payoutAttempt.findUnique({ where: { id: attemptId } });
			if (!current) throw new AppError('محاولة التحويل غير موجودة', 404);
			if (current.status === PayoutAttemptStatus.REVERSED) {
				// A duplicate reversal signal is ONLY a valid no-op if the
				// Withdrawal already agrees — REVERSED attempt + a Withdrawal
				// that is NOT REVERSED is itself the same data-integrity anomaly
				// as above (just discovered via the idempotent-call path instead
				// of the first-call path), and must never be silently accepted
				// as a successful no-op.
				const withdrawal = await tx.withdrawal.findUnique({ where: { id: current.withdrawalId } });
				if (withdrawal?.status !== WithdrawalStatus.REVERSED) {
					throw new AppError('حالة غير متسقة: محاولة التحويل مسجّلة كمسترجعة لكن طلب السحب ليس كذلك — يتطلب مراجعة يدوية', 409);
				}
				return current;
			}
			throw new AppError(`لا يمكن تسجيل استرجاع التحويل — حالة المحاولة الحالية (${current.status}) لم تكن مكتملة`, 409);
		});
	}

	/**
	 * Payout P3-C: sets PayoutAttempt.payoutItemId ONLY when it is currently
	 * null. Never overwrites an existing value, even with the identical
	 * value's own write path (that's the idempotent no-op case below, not a
	 * write at all). Respects the column's own @unique DB constraint —
	 * genuinely never lets two different attempts end up racing to claim the
	 * SAME payoutItemId (classified CONFLICT, never silently resolved).
	 * Never creates a new attempt, never touches `status`.
	 *
	 * Real-PostgreSQL concurrency (adversarially re-verified, not just
	 * mock-tested): no explicit isolationLevel is set here, matching every
	 * other single-row conditional-update primitive in this class
	 * (markAttemptAccepted/Completed/DefinitelyFailed/Reversed) — this is
	 * safe, not an oversight. A single `UPDATE ... WHERE id = $1 AND
	 * "payoutItemId" IS NULL` is atomic under Postgres regardless of
	 * isolation level: row-level locking during the UPDATE itself guarantees
	 * two concurrent writers targeting the SAME row can never both match —
	 * whichever executes second re-evaluates its WHERE clause against the
	 * now-committed row and correctly sees `payoutItemId` no longer NULL
	 * (count 0). The follow-up `findUnique` inside the same transaction, run
	 * under Postgres's default READ COMMITTED, takes a fresh per-statement
	 * snapshot, so it correctly observes the winner's just-committed value —
	 * never a stale read. For two DIFFERENT attempts racing to claim the
	 * SAME payoutItemId value (a different scenario — different rows, so no
	 * row-level lock serializes them against each other), the column's own
	 * @unique index is Postgres's actual enforcement mechanism, surfaced
	 * here as the caught P2002 below. SERIALIZABLE is deliberately NOT used
	 * — it exists elsewhere in this file only where a multi-row aggregate
	 * read (balance computation) needs snapshot isolation, which does not
	 * apply to this single-row conditional write.
	 */
	private async persistPayoutItemId(attemptId: string, payoutItemId: string): Promise<'SET' | 'ALREADY_SET_SAME' | 'CONFLICT'> {
		try {
			return await prisma.$transaction(async tx => {
				const result = await tx.payoutAttempt.updateMany({
					where: { id: attemptId, payoutItemId: null },
					data: { payoutItemId }
				});
				if (result.count === 1) return 'SET';

				const current = await tx.payoutAttempt.findUnique({ where: { id: attemptId }, select: { payoutItemId: true } });
				if (!current) throw new AppError('محاولة التحويل غير موجودة', 404);
				if (current.payoutItemId === payoutItemId) return 'ALREADY_SET_SAME';
				// A different payoutItemId is already durably recorded — never
				// overwritten, never silently resolved.
				return 'CONFLICT';
			});
		} catch (error) {
			// A genuinely concurrent racer claiming the SAME payoutItemId first
			// can surface as the column's own @unique constraint violation
			// instead of our conditional WHERE simply matching zero rows —
			// classified the same way: CONFLICT, never retried/overwritten.
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'CONFLICT';
			throw error;
		}
	}

	/**
	 * Payout P3-C: sets PayoutAttempt.payoutBatchId ONLY when it is currently
	 * null — the safe persistence primitive for a payoutBatchId recovered via
	 * recoverPayoutBySenderBatch(). Deliberately does NOT touch `status` at
	 * all (see reconcilePayoutAttempt()'s own STEP 8/9 comment: identity
	 * recovery must never, by itself, promote PENDING -> PROCESSING — that
	 * would misuse markAttemptAccepted()'s own semantics for a fact
	 * recovery never actually established).
	 */
	private async persistRecoveredPayoutBatchId(attemptId: string, payoutBatchId: string): Promise<'SET' | 'ALREADY_SET_SAME' | 'CONFLICT'> {
		try {
			return await prisma.$transaction(async tx => {
				const result = await tx.payoutAttempt.updateMany({
					where: { id: attemptId, payoutBatchId: null },
					data: { payoutBatchId }
				});
				if (result.count === 1) return 'SET';

				const current = await tx.payoutAttempt.findUnique({ where: { id: attemptId }, select: { payoutBatchId: true } });
				if (!current) throw new AppError('محاولة التحويل غير موجودة', 404);
				if (current.payoutBatchId === payoutBatchId) return 'ALREADY_SET_SAME';
				return 'CONFLICT';
			});
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'CONFLICT';
			throw error;
		}
	}

	/**
	 * Payout P3-C — CORE SAFETY RULE: exact item correlation, and ONLY exact
	 * item correlation, using the strongest identifier available:
	 *
	 *  - If PayoutAttempt.payoutItemId is already known: require EXACTLY ONE
	 *    returned item whose payoutItemId matches it AND whose own
	 *    payoutBatchId matches the attempt's payoutBatchId (defense in depth
	 *    — paypal.service.ts's own getPayoutBatch() already refuses to
	 *    return a FOUND result with any item/batch id contradiction, but
	 *    this is never trusted silently across the module boundary).
	 *  - Otherwise: require EXACTLY ONE returned item whose senderItemId
	 *    equals PayoutAttempt.id (the owner decision established back in
	 *    P2-C: sender_item_id IS the PayoutAttempt's own id).
	 *
	 * Zero matches or MORE than one match are BOTH treated as "cannot prove
	 * correlation" — null. Never items[0]. Never "only item in the array."
	 * Never matched by batch id alone, transaction status, or array
	 * position. Absence of proof is absence of proof, not a fallback
	 * opportunity.
	 */
	private correlatePayoutItem(
		attempt: { id: string; payoutItemId: string | null; payoutBatchId: string | null },
		items: PaypalPayoutItemResult[]
	): PaypalPayoutItemResult | null {
		if (attempt.payoutItemId) {
			const matches = items.filter(item => item.payoutItemId === attempt.payoutItemId && item.payoutBatchId === attempt.payoutBatchId);
			return matches.length === 1 ? matches[0] : null;
		}
		const matches = items.filter(item => item.senderItemId === attempt.id);
		return matches.length === 1 ? matches[0] : null;
	}

	/**
	 * Payout P3-C: the ONE reconciliation entry point. Loads a PayoutAttempt
	 * and its Withdrawal, validates local integrity, resolves a
	 * payoutBatchId (recovering it via senderBatchId if genuinely missing
	 * and safely within PayPal's documented window), calls
	 * getPayoutBatch(), correlates the EXACT item belonging to this attempt,
	 * and maps that item's transaction_status to the local state machine —
	 * calling ONLY the existing, now-atomically-hardened
	 * markAttemptCompleted()/markAttemptDefinitelyFailed()/
	 * markAttemptReversed() primitives, never inventing a new write path.
	 *
	 * CORE SAFETY RULE: a financial state transition happens ONLY when the
	 * exact PayPal item belonging to this exact attempt has been proven via
	 * correlatePayoutItem() above. If correlation cannot be proven — for any
	 * reason — this returns ADMIN_REVIEW and makes ZERO financial state
	 * changes. The same applies to every ambiguous/unproven PayPal transport
	 * outcome (UNKNOWN) and every local-validation failure.
	 *
	 * Only a genuinely missing attemptId is a thrown 404 (a caller error,
	 * not a reconciliation finding) — every other outcome, including every
	 * local-validation failure, is a returned ReconcilePayoutAttemptResult.
	 *
	 * NEVER, anywhere in this method: creates a WalletTransaction, debits or
	 * credits provider balance, creates or mutates an Escrow, creates a new
	 * Withdrawal, creates a new PayoutAttempt, or calls sendPayout()/
	 * initializeSendPayout(). This method records external truth only.
	 */
	async reconcilePayoutAttempt(attemptId: string): Promise<ReconcilePayoutAttemptResult> {
		const attempt = await prisma.payoutAttempt.findUnique({ where: { id: attemptId } });
		if (!attempt) throw new AppError('محاولة التحويل غير موجودة', 404);

		const withdrawal = await prisma.withdrawal.findUnique({ where: { id: attempt.withdrawalId } });
		if (!withdrawal) throw new AppError('طلب السحب غير موجود', 404);

		const withdrawalId = withdrawal.id;
		// Post-adversarial-review: adminReview() (and every other return point
		// below) always reports the ATTEMPT'S OWN current status via
		// localStatus, defaulting to its status as read at the top of this
		// call — accurate for every early return, since none of them mutate
		// anything before returning.
		const adminReview = (message: string, localStatus: PayoutAttemptStatus = attempt.status): ReconcilePayoutAttemptResult =>
			({ outcome: 'ADMIN_REVIEW', attemptId, withdrawalId, message, localStatus });

		// ── Local integrity validation — BEFORE any PayPal call ──
		if (attempt.provider !== SUPPORTED_PAYOUT_PROVIDER) {
			return adminReview('مزود الدفع لهذه المحاولة غير مدعوم للمطابقة التلقائية');
		}
		if (!attempt.senderBatchId) {
			return adminReview('لا يوجد معرف دفعة مرسل (senderBatchId) لهذه المحاولة');
		}
		if (withdrawal.method !== SUPPORTED_PAYOUT_METHOD) {
			return adminReview('طلب السحب ليس عبر PayPal — لا يمكن مطابقته تلقائياً');
		}
		if (withdrawal.currency !== SUPPORTED_PAYOUT_CURRENCY) {
			return adminReview('عملة طلب السحب غير مدعومة لمطابقة تحويلات PayPal');
		}
		if (!withdrawal.paypalEmail || !PAYOUT_RECIPIENT_EMAIL_PATTERN.test(withdrawal.paypalEmail)) {
			return adminReview('لا يوجد بريد PayPal صالح مسجل لهذا الطلب');
		}
		if (typeof withdrawal.amount !== 'number' || !Number.isFinite(withdrawal.amount) || withdrawal.amount <= 0) {
			return adminReview('مبلغ طلب السحب غير صالح للمطابقة');
		}

		// ── Local terminal-state guards — never resurrected by reconciliation ──
		// Deliberately short-circuit with ZERO PayPal call: these two states
		// are already financially terminal LOCALLY, and this method's own
		// terminal-guard invariant (never resurrect FAILED/REVERSED) makes any
		// fresh PayPal check pointless — there is no transition it could ever
		// justify from here. The message is explicit that no fresh check
		// occurred, so this is never mistaken for a freshly-confirmed result.
		if (attempt.status === PayoutAttemptStatus.FAILED) {
			return { outcome: 'FAILED', attemptId, withdrawalId, message: 'محاولة التحويل فاشلة بالفعل محلياً — لم يتم إجراء تحقق جديد لدى PayPal', localStatus: attempt.status };
		}
		if (attempt.status === PayoutAttemptStatus.REVERSED) {
			return { outcome: 'REVERSED', attemptId, withdrawalId, message: 'تم استرجاع هذا التحويل بالفعل محلياً — لم يتم إجراء تحقق جديد لدى PayPal', localStatus: attempt.status };
		}
		// Remaining eligible states: PENDING, PROCESSING, COMPLETED (COMPLETED
		// must still flow through below — it's the ONLY state a later
		// RETURNED/REFUNDED/REVERSED report can legitimately transition out of).

		let payoutBatchId = attempt.payoutBatchId;

		// ── STEP 8: missing payoutBatchId recovery ──
		if (!payoutBatchId) {
			if (attempt.status !== PayoutAttemptStatus.PENDING) {
				// PROCESSING/COMPLETED without a payoutBatchId should be
				// unreachable under normal operation (markAttemptAccepted()/
				// markAttemptCompleted() both always set it) — a genuine
				// data-integrity anomaly, not a case recovery was ever
				// designed for.
				return adminReview('حالة غير متسقة: محاولة غير معلّقة بدون معرف دفعة PayPal');
			}

			const ageMs = Date.now() - attempt.createdAt.getTime();
			// Post-adversarial-review: a NEGATIVE age (attempt.createdAt in the
			// future — clock skew or corrupted data) must never silently be
			// treated as "safely within the window" merely because it fails the
			// `>= 30 days` check. A future-dated createdAt is itself a
			// data-integrity anomaly and is conservatively treated the same as
			// an anomaly requiring manual review — zero PayPal recovery POST.
			if (ageMs < 0) {
				return adminReview('انحراف زمني: تاريخ إنشاء المحاولة في المستقبل — تعارض في البيانات يتطلب مراجعة يدوية قبل أي محاولة استرجاع');
			}
			if (ageMs >= SENDER_BATCH_RECOVERY_WINDOW_MS) {
				return { outcome: 'RECOVERY_WINDOW_EXPIRED', attemptId, withdrawalId, message: 'تجاوزت المحاولة النافذة الزمنية الآمنة لإعادة إرسال طلب التحويل — تتطلب مراجعة يدوية', localStatus: attempt.status };
			}

			const recovery = await paypalService.recoverPayoutBySenderBatch({
				senderBatchId: attempt.senderBatchId,
				senderItemId: attempt.id,
				recipientEmail: withdrawal.paypalEmail,
				amount: withdrawal.amount
			});

			if (recovery.outcome === 'UNKNOWN') {
				return { outcome: 'UNKNOWN', attemptId, withdrawalId, message: 'تعذر التحقق من حالة التحويل لدى PayPal — لم يتغير أي شيء', localStatus: attempt.status };
			}

			// RECOVERED is identity ONLY — never treated as acceptance/success.
			// Persisted via the dedicated, status-untouching primitive, never
			// markAttemptAccepted().
			const persisted = await this.persistRecoveredPayoutBatchId(attempt.id, recovery.payoutBatchId);
			if (persisted === 'CONFLICT') {
				return adminReview('تعارض في معرف دفعة PayPal المسترجع مع قيمة مختلفة مسجلة مسبقاً — يتطلب مراجعة يدوية');
			}
			payoutBatchId = recovery.payoutBatchId;
		}

		// ── GET the batch and correlate the EXACT item ──
		const batchResult = await paypalService.getPayoutBatch(payoutBatchId);
		if (batchResult.outcome === 'UNKNOWN') {
			return { outcome: 'UNKNOWN', attemptId, withdrawalId, message: 'تعذر الحصول على حالة دفعة التحويل من PayPal — لم يتغير أي شيء', localStatus: attempt.status };
		}

		const item = this.correlatePayoutItem(
			{ id: attempt.id, payoutItemId: attempt.payoutItemId, payoutBatchId },
			batchResult.batch.items
		);
		if (!item) {
			return adminReview('تعذر إثبات مطابقة دقيقة لعنصر التحويل الخاص بهذه المحاولة — يتطلب مراجعة يدوية');
		}

		// Persist a newly-discovered payoutItemId as soon as correlation is
		// proven, regardless of the item's own transaction_status — future
		// reconciliation runs (and P3-D's webhook correlation) benefit from
		// the strongest identifier being durably recorded as early as safely
		// possible.
		if (item.payoutItemId && !attempt.payoutItemId) {
			const persisted = await this.persistPayoutItemId(attempt.id, item.payoutItemId);
			if (persisted === 'CONFLICT') {
				return adminReview('تعارض في معرف عنصر التحويل (payoutItemId) مع قيمة مختلفة مسجلة مسبقاً — يتطلب مراجعة يدوية');
			}
		}

		// ── STEP 7 guard, post-adversarial-review hardening: a COMPLETED
		// attempt may ONLY ever move to REVERSED (via RETURNED/REFUNDED/
		// REVERSED) or stay COMPLETED (SUCCESS is idempotent). Every other
		// signal — FAILED/PENDING/UNCLAIMED/ONHOLD/BLOCKED/unknown — is a
		// genuine CONTRADICTION (PayPal is reporting something inconsistent
		// with a payout this system durably recorded as already succeeded),
		// NOT a normal "ignore and report clean" case. The DB was already
		// safe (no primitive is ever called for these), but the REPORTED
		// result must not mask that contradiction behind a plain COMPLETED —
		// it goes through the SAME adminReview() path as every other anomaly,
		// with localStatus correctly showing COMPLETED (the true, unchanged
		// DB state) alongside the ADMIN_REVIEW outcome that flags the
		// contradiction itself.
		const isReversalClass = item.transactionStatus === 'RETURNED' || item.transactionStatus === 'REFUNDED' || item.transactionStatus === 'REVERSED';
		if (attempt.status === PayoutAttemptStatus.COMPLETED && item.transactionStatus !== 'SUCCESS' && !isReversalClass) {
			return adminReview(
				'تناقض: المحاولة مكتملة بالفعل محلياً لكن PayPal أبلغت عن حالة غير حاسمة أو متعارضة لنفس العنصر — لم يتم أي تغيير ويتطلب مراجعة يدوية',
				PayoutAttemptStatus.COMPLETED
			);
		}

		// ── STEP 6: status mapping for the EXACT correlated item only ──
		switch (item.transactionStatus) {
			case 'PENDING':
				// Do NOT blindly promote PENDING -> PROCESSING merely because a
				// GET succeeded — only initializeSendPayout()/markAttemptAccepted()
				// may ever establish PROCESSING. localStatus reports the
				// attempt's REAL unchanged status (PENDING or PROCESSING,
				// whichever it already was) — STILL_PROCESSING must never be
				// misread as "the DB row is in PROCESSING."
				return { outcome: 'STILL_PROCESSING', attemptId, withdrawalId, message: 'التحويل ما زال قيد المعالجة لدى PayPal', localStatus: attempt.status };

			case 'SUCCESS':
				return this.applyReconciliationCompletion(attempt.id, item.payoutItemId, withdrawalId, attempt.status);

			case 'FAILED':
				return this.applyReconciliationFailure(attempt.id, withdrawalId, attempt.status);

			case 'UNCLAIMED':
				return { outcome: 'ACTION_REQUIRED', attemptId, withdrawalId, message: 'بانتظار استلام المستفيد للتحويل — لم يتغير أي شيء محلياً', localStatus: attempt.status };

			case 'ONHOLD':
				return adminReview('التحويل قيد المراجعة من قبل PayPal — يتطلب مراجعة يدوية');

			case 'BLOCKED':
				// Conservative first cut, per explicit instruction: never
				// automatically reopen the Withdrawal here unless officially-
				// verified semantics prove funds definitely never moved — that
				// proof does not exist in this project yet.
				return adminReview('التحويل محظور من قبل PayPal — يتطلب مراجعة يدوية قبل أي إجراء');

			case 'RETURNED':
			case 'REFUNDED':
			case 'REVERSED':
				return this.applyReconciliationReversal(attempt.id, attempt.status, withdrawalId, item.transactionStatus);

			default:
				// Unknown/missing transaction status — ZERO financial state
				// changes, never guessed.
				return { outcome: 'UNKNOWN', attemptId, withdrawalId, message: 'حالة عنصر التحويل من PayPal غير معروفة — لم يتغير أي شيء', localStatus: attempt.status };
		}
	}

	/** SUCCESS mapping: markAttemptCompleted() already handles idempotency and terminal-guard rejection on its own; anomalies are surfaced as ADMIN_REVIEW, never an uncaught exception from reconcilePayoutAttempt(). */
	private async applyReconciliationCompletion(attemptId: string, payoutItemId: string | undefined, withdrawalId: string, statusBeforeThisCall: PayoutAttemptStatus): Promise<ReconcilePayoutAttemptResult> {
		try {
			await this.markAttemptCompleted(attemptId, { payoutItemId });
			return { outcome: 'COMPLETED', attemptId, withdrawalId, message: 'تم تأكيد اكتمال التحويل من PayPal', localStatus: PayoutAttemptStatus.COMPLETED };
		} catch (error) {
			if (error instanceof AppError) {
				// The transition never committed (see markAttemptCompleted()'s
				// own atomicity guard) — localStatus is whatever it was BEFORE
				// this call, never falsely reported as COMPLETED.
				return { outcome: 'ADMIN_REVIEW', attemptId, withdrawalId, message: 'تعذر تسجيل اكتمال التحويل محلياً — يتطلب مراجعة يدوية', localStatus: statusBeforeThisCall };
			}
			throw error;
		}
	}

	/** FAILED mapping: only ever reached for the documented "payment failed / funds not deducted" semantic — markAttemptDefinitelyFailed() re-opens the Withdrawal to APPROVED as usual. */
	private async applyReconciliationFailure(attemptId: string, withdrawalId: string, statusBeforeThisCall: PayoutAttemptStatus): Promise<ReconcilePayoutAttemptResult> {
		try {
			await this.markAttemptDefinitelyFailed(attemptId, 'PayPal: FAILED (funds not deducted)');
			return { outcome: 'FAILED', attemptId, withdrawalId, message: 'فشل التحويل لدى PayPal ولم يتم خصم أي مبلغ', localStatus: PayoutAttemptStatus.FAILED };
		} catch (error) {
			if (error instanceof AppError) {
				return { outcome: 'ADMIN_REVIEW', attemptId, withdrawalId, message: 'تعذر تسجيل فشل التحويل محلياً — يتطلب مراجعة يدوية', localStatus: statusBeforeThisCall };
			}
			throw error;
		}
	}

	/**
	 * RETURNED/REFUNDED/REVERSED mapping: financially safe ONLY when the
	 * local attempt is already COMPLETED (money genuinely moved once,
	 * durably recorded). If PayPal reports a reversal-class status while the
	 * local attempt is still PENDING/PROCESSING, this NEVER manufactures an
	 * intermediate SUCCESS to justify calling markAttemptReversed() — that
	 * would let a PROCESSING attempt skip straight to REVERSED without ever
	 * having durably recorded the success in between, corrupting the
	 * attempt's own history. Instead: ADMIN_REVIEW, zero transition.
	 */
	private async applyReconciliationReversal(attemptId: string, currentStatus: PayoutAttemptStatus, withdrawalId: string, paypalTerminalStatus: string): Promise<ReconcilePayoutAttemptResult> {
		if (currentStatus !== PayoutAttemptStatus.COMPLETED) {
			return {
				outcome: 'ADMIN_REVIEW', attemptId, withdrawalId, localStatus: currentStatus,
				message: 'أبلغت PayPal عن استرجاع للتحويل لكن المحاولة المحلية لم تكن مكتملة بعد — يتطلب مراجعة يدوية ولن يتم تسجيل نجاح وهمي'
			};
		}
		try {
			await this.markAttemptReversed(attemptId, paypalTerminalStatus);
			return { outcome: 'REVERSED', attemptId, withdrawalId, message: 'تم استرجاع التحويل من قبل PayPal بعد اكتماله سابقاً', localStatus: PayoutAttemptStatus.REVERSED };
		} catch (error) {
			if (error instanceof AppError) {
				return { outcome: 'ADMIN_REVIEW', attemptId, withdrawalId, message: 'تعذر تسجيل استرجاع التحويل محلياً — يتطلب مراجعة يدوية', localStatus: PayoutAttemptStatus.COMPLETED };
			}
			throw error;
		}
	}
}

export const payoutService = new PayoutService();
