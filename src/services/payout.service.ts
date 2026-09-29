import { Prisma, WithdrawalStatus, PayoutAttemptStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { isRetryableTransactionConflict } from '../utils/prisma-retry.util';
import { deriveSenderBatchId } from '../utils/payout-attempt.util';

// Same bound as withdrawal.service.ts's SERIALIZABLE retry loop — kept
// separate rather than shared/imported, since this constant is small and
// each call site owns its own retry ceiling.
const MAX_SERIALIZATION_RETRIES = 3;

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
 * Classifies a P2002 raised during initializeSendPayout() by inspecting
 * Prisma's own error metadata for the violated constraint/index name.
 *
 * HONEST LIMITATION, stated plainly rather than assumed away: this project
 * cannot exercise a real P2002 from this exact schema without a live
 * PostgreSQL connection, which this task is not permitted to make. Prisma's
 * `PrismaClientKnownRequestError.meta` shape for a Postgres unique
 * violation is documented to carry the violated constraint identification,
 * but its EXACT representation (a bare string, a single-element array, or a
 * field-name array) has not been empirically re-verified against this
 * specific schema+driver-adapter combination the way isRetryableTransactionConflict's
 * shapes were in Batch 2A. This function is therefore deliberately
 * conservative: it checks every representation it reasonably expects
 * `meta.target` to take, and if NONE of them clearly match either known
 * constraint, it returns `null` — meaning "not classified" — and the
 * caller MUST treat that as an unknown error and propagate it unmodified,
 * never silently retry or silently convert it to a business error. See the
 * P1 final report's "Limitations" section for the concrete follow-up this
 * implies once a real DEV concurrency test (§12 of the design) can observe
 * the actual shape.
 */
function classifyInitializationConflict(error: unknown): InitializationConflict {
	if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;

	const target = (error.meta as { target?: unknown } | undefined)?.target;
	const candidates: string[] = [];
	if (typeof target === 'string') candidates.push(target);
	else if (Array.isArray(target)) candidates.push(...target.filter((t): t is string => typeof t === 'string'));

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
