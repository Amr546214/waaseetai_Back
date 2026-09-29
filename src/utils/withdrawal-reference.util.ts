/**
 * Deterministic Withdrawal.referenceId derivation — WalletTransaction
 * defense-in-depth (financial invariant audit follow-up).
 *
 * Required properties:
 *  - stable and deterministic for a GIVEN withdrawal id — always the same
 *    output for the same input, so it can be derived once at creation time
 *    and safely re-derived (never re-randomized) anywhere the withdrawal's
 *    own id is already known.
 *  - unique per withdrawal — since it embeds the withdrawal's own id, and
 *    Withdrawal.id is itself unique, this can never collide across two
 *    different withdrawals.
 *  - namespaced ("withdrawal-" prefix) so it is visually and structurally
 *    distinguishable from other WalletTransaction.referenceId values this
 *    codebase already writes (e.g. paypal-finance.service.ts's/
 *    client-finance.service.ts's bare PayPal/Moyasar reference UUIDs, or
 *    cart-checkout.service.ts's order payment references) — this value is
 *    never sent to any external API, it exists purely as an internal,
 *    DB-enforced uniqueness key, so it needs no external format constraint.
 *  - no dependency on the DB or any external call — pure derivation from an
 *    already-known local value.
 *
 * This closes the "WalletTransaction.referenceId defense-in-depth" gap
 * identified in the financial invariant audit: Withdrawal.referenceId used
 * to be left null for every withdrawal (nothing ever populated it), and
 * Postgres's unique index permits unlimited NULLs, so the existing
 * WalletTransaction.referenceId @unique constraint provided zero real
 * protection against a duplicate debit ever reaching the database. Giving
 * every new Withdrawal a real, non-null, deterministic referenceId — and
 * having approve() continue to pass that SAME value through to
 * WalletTransaction.referenceId, unchanged — makes that constraint a live
 * second line of defense, independent of and in addition to the existing
 * application-level exactly-once logic (the conditional PENDING -> APPROVED
 * updateMany), matching the same "DB backstop behind app logic" pattern
 * PayoutAttempt's active_attempt_unique partial index already established.
 */
export function deriveWithdrawalReferenceId(withdrawalId: string): string {
	if (!withdrawalId) throw new Error('deriveWithdrawalReferenceId: withdrawalId is required');
	return `withdrawal-${withdrawalId}`;
}
