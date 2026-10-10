import { MARKETER_LEVELS, MIN_LEVEL, MAX_LEVEL } from './levels.config';
// Source: P-LG-012 (مسودة مرجعية حاكمة) — the authoritative, dated governing
// reference draft for the Marketing Affiliate/referral system
// (angular-app/design-reference/extracted/00-تسليم-الموقع-والسوق/
// القانونية-الإضافية/P-LG-012.html).
//
// 15 fixed affiliate performance levels, each with a FLAT, static commission
// percentage — this is a flat lookup table by level, explicitly NOT a
// multi-level-by-depth (MLM) structure. P-LG-012 is explicit that the
// referral relationship is single-tier/direct only.
//
// P-LG-012 does NOT specify numeric thresholds (points/clients/revenue) for
// progression between levels, no AND/OR formula, and no downgrade rule.
// Nothing here invents one: AffiliateProfile.level is a manually-set integer
// field (1-15, default 1) with NO automatic promotion/recalculation logic
// anywhere in this codebase. This table only maps an already-set level to
// its commission percentage.
//
// Points/levels never convert directly to cash — the level only SELECTS the
// percentage below; it is not itself payable.
// Derived from the single ladder (config/levels.config.ts MARKETER_LEVELS): no number or name is repeated here.
export const AFFILIATE_LEVEL_RATES: Readonly<Record<number, number>> = Object.fromEntries(MARKETER_LEVELS.map(d => [d.level, d.percent]));

export const AFFILIATE_LEVEL_NAMES: Readonly<Record<number, string>> = Object.fromEntries(MARKETER_LEVELS.map(d => [d.level, d.name]));

export const MIN_AFFILIATE_LEVEL = MIN_LEVEL;
export const MAX_AFFILIATE_LEVEL = MAX_LEVEL;

/**
 * Resolves the commission percentage for a given affiliate level, per the
 * static P-LG-012 table above. Any out-of-range or non-integer level
 * defensively falls back to level 1's percentage rather than throwing —
 * this is a commission-calculation input, not user-facing validation, and a
 * corrupted/out-of-range level must never silently produce a 0% or NaN
 * commission.
 */
export function resolveAffiliateCommissionPercentage(level: number): number {
  const isValid = Number.isInteger(level) && level >= MIN_AFFILIATE_LEVEL && level <= MAX_AFFILIATE_LEVEL;
  return AFFILIATE_LEVEL_RATES[isValid ? level : MIN_AFFILIATE_LEVEL];
}
