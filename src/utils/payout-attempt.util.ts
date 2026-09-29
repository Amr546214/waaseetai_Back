/**
 * Deterministic sender_batch_id derivation for a PayoutAttempt — Payout P1.
 *
 * Required properties (from the approved payout-architecture design):
 *  - stable for the SAME PayoutAttempt (an HTTP retry of the same attempt
 *    must resolve to the identical value, so the eventual payout provider's
 *    own idempotency also treats it as the same request)
 *  - different for a legitimate NEW attempt (a genuine retry-after-failure
 *    must produce a distinct value, or the provider would refuse to process
 *    an intentional retry as a duplicate)
 *  - generated and stored BEFORE any future external call — this module has
 *    no dependency on the DB or on any HTTP client, deliberately, so it can
 *    run purely from already-known local values
 *  - DB-unique (enforced by PayoutAttempt.senderBatchId @unique in schema.prisma,
 *    not by this function)
 *  - no secret material involved — pure derivation from withdrawalId +
 *    attemptNumber, both already guaranteed unique together by
 *    PayoutAttempt's own @@unique([withdrawalId, attemptNumber])
 *
 * Format is exactly what the approved design specified — no new provider
 * (PayPal) length/character assumption is introduced here, since P1 makes
 * no external call and this codebase has no existing PayPal Payouts
 * integration to source a real constraint from. Provider-side wire-format
 * validation, if any is ever needed, belongs to P2 (the actual PayPal
 * Payouts service), not this deterministic-derivation helper.
 */
export function deriveSenderBatchId(withdrawalId: string, attemptNumber: number): string {
	if (!withdrawalId) throw new Error('deriveSenderBatchId: withdrawalId is required');
	if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
		throw new Error('deriveSenderBatchId: attemptNumber must be a positive integer');
	}
	return `wd-${withdrawalId}-a${attemptNumber}`;
}
