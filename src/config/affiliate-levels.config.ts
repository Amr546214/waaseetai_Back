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
export const AFFILIATE_LEVEL_RATES: Readonly<Record<number, number>> = {
  1: 1.0, // مسوق
  2: 1.2, // مساعد
  3: 1.5, // موصل
  4: 2.0, // منسق
  5: 2.25, // وسيط
  6: 2.5, // ممثل
  7: 2.75, // سفير
  8: 3.0, // موجه
  9: 3.2, // حلقة وصل
  10: 3.4, // جسر الوصل
  11: 3.6, // ناقل حيوي
  12: 3.8, // موصل استراتيجي
  13: 4.0, // رابط استشاري
  14: 4.3, // شريك تنفيذي
  15: 4.5 // رابط مؤسسي
};

export const AFFILIATE_LEVEL_NAMES: Readonly<Record<number, string>> = {
  1: 'مسوق',
  2: 'مساعد',
  3: 'موصل',
  4: 'منسق',
  5: 'وسيط',
  6: 'ممثل',
  7: 'سفير',
  8: 'موجه',
  9: 'حلقة وصل',
  10: 'جسر الوصل',
  11: 'ناقل حيوي',
  12: 'موصل استراتيجي',
  13: 'رابط استشاري',
  14: 'شريك تنفيذي',
  15: 'رابط مؤسسي'
};

export const MIN_AFFILIATE_LEVEL = 1;
export const MAX_AFFILIATE_LEVEL = 15;

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
