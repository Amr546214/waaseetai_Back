/**
 * The single withdrawal-reservation rule shared by the wallet read and withdrawal.service createForProvider():
 * a request holds its amount in every status except REJECTED. PENDING/APPROVED/PROCESSING are still in the review/payout pipeline;
 * COMPLETED (paid) and REVERSED (PayPal took the payout back after it was paid, so the earnings were already once consumed) are spent.
 */
export const IN_FLIGHT_WITHDRAWAL_STATUSES = ['PENDING', 'APPROVED', 'PROCESSING'] as const;
export const SPENT_WITHDRAWAL_STATUSES = ['COMPLETED', 'REVERSED'] as const;
export const RESERVING_WITHDRAWAL_STATUSES = [...IN_FLIGHT_WITHDRAWAL_STATUSES, ...SPENT_WITHDRAWAL_STATUSES] as const;
