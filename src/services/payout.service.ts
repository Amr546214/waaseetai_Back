import { Prisma, WithdrawalStatus, PayoutAttemptStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { isRetryableTransactionConflict } from '../utils/prisma-retry.util';
import { deriveSenderBatchId } from '../utils/payout-attempt.util';
import { paypalService, type CreatePayoutParams, type PaypalPayoutCreateResult } from './paypal.service';
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
				await tx.withdrawal.updateMany({
					where: { id: attempt.withdrawalId, status: WithdrawalStatus.PROCESSING },
					data: { status: WithdrawalStatus.APPROVED }
				});
				return attempt;
			}

			// count === 0: the attempt was already terminal (or doesn't exist).
			// Read the current state to distinguish a safe no-op from a real error.
			const current = await tx.payoutAttempt.findUnique({ where: { id: attemptId } });
			if (!current) throw new AppError('محاولة التحويل غير موجودة', 404);
			// Already FAILED (duplicate) or already COMPLETED (must never be
			// downgraded) — both are safe no-ops; return the row unchanged.
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
				await tx.withdrawal.updateMany({
					where: { id: attempt.withdrawalId, status: WithdrawalStatus.PROCESSING },
					data: { status: WithdrawalStatus.COMPLETED }
				});
				return attempt;
			}

			const current = await tx.payoutAttempt.findUnique({ where: { id: attemptId } });
			if (!current) throw new AppError('محاولة التحويل غير موجودة', 404);
			if (current.status === PayoutAttemptStatus.COMPLETED) {
				// Duplicate completion — safe no-op.
				return current;
			}
			// current.status === FAILED — do not resurrect it.
			throw new AppError('لا يمكن تعليم محاولة تحويل فاشلة كمكتملة — يجب أن تبدأ محاولة جديدة', 409);
		});
	}
}

export const payoutService = new PayoutService();
