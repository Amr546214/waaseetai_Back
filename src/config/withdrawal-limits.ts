/**
 * THE withdrawal limits of the platform, one rule for every role that can withdraw (marketer commissions, provider earnings).
 * Minimum: 10 USD (owner decision). Maximum: NONE: a request is limited only by what the account can actually withdraw (its withdrawable balance).
 * The fee policy's `minMarketerPayout` / `minProviderPayout` and the per-affiliate `minimumPayoutAmount` no longer lower or raise this: they are kept as stored data, but every read answers with this value.
 */
export const MIN_WITHDRAWAL_USD = 10;
