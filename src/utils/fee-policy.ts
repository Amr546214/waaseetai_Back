// BE-3 / phase 1: pure fee-policy calculator (policy v2). Constants are copied verbatim from the binding finance reference
// (xlsx, decision of 2026-10-06). NOT wired into any money path yet: nothing imports this file outside tests, so no behaviour changes.
// No Prisma, no DB, no service imports with side effects.

import { resolveAffiliateCommissionPercentage } from '../config/affiliate-levels.config';
import { PROVIDER_LEVELS, CLIENT_LEVELS } from '../config/levels.config';

export const FEE_POLICY_VERSION = 2;

/** ISO date/time from which policy v2 applies. Unset/empty = v2 is NOT active (decision: nothing uses it yet). Read at call time. */
export function getFeePolicyEffectiveFrom(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = (env.FEE_POLICY_EFFECTIVE_FROM || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True only when an effective date is configured and the given instant (e.g. Escrow.fundedAt) is on/after it. */
export function isFeePolicyV2Active(at: Date, env: NodeJS.ProcessEnv = process.env): boolean {
  const from = getFeePolicyEffectiveFrom(env);
  return from !== null && at.getTime() >= from.getTime();
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Provider: the final deduction by level (نسب الدفع.xlsx, "الخصم النهائي لمقدمي الخدمات"). Percent points. ──────────────────────
// The workbook gives ONE number per level (12.75% ... 8.15%): it is the platform commission and the whole deduction, so there is no admin /
// transfer / VAT column to add on top. It comes from the single ladder (config/levels.config.ts PROVIDER_LEVELS).
export interface ProviderFeeRow { level: number; platform: number; total: number }

export const PROVIDER_FEE_TABLE: readonly ProviderFeeRow[] = PROVIDER_LEVELS.map(d => ({ level: d.level, platform: d.percent, total: d.percent }));

/** Commission adjustments (percentage points). "Complex / high-value projects +1.0" is NOT implemented: its value threshold is undefined. */
export const COMMISSION_ADJUSTMENTS = {
  topRating: { minRating: 4.8, delta: -0.5 },
  fastDelivery: { minOnTimePercent: 80, delta: -0.3 },
  highVolume: { minProjectsPerMonth: 10, delta: -0.2 },
} as const;
export const MIN_PLATFORM_COMMISSION = 0.5;

export interface CommissionModifiers {
  avgRating?: number | null;
  /** % of projects delivered before the deadline */
  onTimePercent?: number | null;
  projectsPerMonth?: number | null;
}

export function providerFeeRow(level: number): ProviderFeeRow {
  const lv = Number.isInteger(level) ? Math.min(15, Math.max(1, level)) : 1;
  return PROVIDER_FEE_TABLE[lv - 1];
}

/** Platform commission after adjustments, floored at MIN_PLATFORM_COMMISSION. */
export function adjustedPlatformCommission(level: number, modifiers: CommissionModifiers = {}): number {
  let c = providerFeeRow(level).platform;
  const { avgRating, onTimePercent, projectsPerMonth } = modifiers;
  if (typeof avgRating === 'number' && avgRating >= COMMISSION_ADJUSTMENTS.topRating.minRating) c += COMMISSION_ADJUSTMENTS.topRating.delta;
  if (typeof onTimePercent === 'number' && onTimePercent >= COMMISSION_ADJUSTMENTS.fastDelivery.minOnTimePercent) c += COMMISSION_ADJUSTMENTS.fastDelivery.delta;
  if (typeof projectsPerMonth === 'number' && projectsPerMonth >= COMMISSION_ADJUSTMENTS.highVolume.minProjectsPerMonth) c += COMMISSION_ADJUSTMENTS.highVolume.delta;
  return Math.max(MIN_PLATFORM_COMMISSION, round2(c));
}

export interface ProviderWithdrawalFees {
  policyVersion: number;
  level: number;
  amount: number;
  percent: { platform: number; total: number };
  fees: { platform: number; total: number };
  net: number;
}

/**
 * net = amount × (1 − platform%). The platform commission is the whole deduction (workbook "الخصم النهائي"); commission modifiers (config only,
 * not wired) only adjust that same number.
 */
export function providerWithdrawalFees(level: number, amount: number, modifiers: CommissionModifiers = {}): ProviderWithdrawalFees {
  const row = providerFeeRow(level);
  const platform = adjustedPlatformCommission(level, modifiers);
  const net = round2(amount * (1 - platform / 100));
  return { policyVersion: FEE_POLICY_VERSION, level: row.level, amount, percent: { platform, total: platform }, fees: { platform: round2(amount - net), total: round2(amount - net) }, net };
}

// ── Requester: deposit fee (transfer + 3.5% admin) by payment method. Percent. ─────────────────────
// Reference constants for ALL methods are kept even though only some have a live path today.
export type DepositMethod = 'mada' | 'visa_mastercard' | 'paypal' | 'international_transfer' | 'other';
export const DEPOSIT_FEE_PERCENT: Readonly<Record<DepositMethod, number>> = {
  mada: 4.25,
  visa_mastercard: 5.5,
  paypal: 7.0,
  international_transfer: 7.5,
  other: 8.5,
};

/** Amount the requester must pay so that `netAmount` is credited: net ÷ (1 − rate). */
export function depositGrossUp(netAmount: number, method: DepositMethod): number {
  const rate = DEPOSIT_FEE_PERCENT[method];
  if (rate === undefined) throw new RangeError(`unknown deposit method: ${method}`);
  return round2(netAmount / (1 - rate / 100));
}

// ── Marketer: withdrawal fee by method (نسب الدفع.xlsx "السحب للوسطاء": transfer + admin + VAT). Percent. Reference data, NOT wired ──
export type MarketerWithdrawalMethod = 'bank_transfer' | 'paypal' | 'usdt';
export const MARKETER_WITHDRAWAL_FEE_PERCENT: Readonly<Record<MarketerWithdrawalMethod, number>> = { bank_transfer: 8.25, paypal: 7.75, usdt: 4 };

/** What the marketer receives when `amount` is withdrawn by `method`: amount × (1 − rate). */
export function marketerWithdrawalFees(amount: number, method: MarketerWithdrawalMethod): { percent: number; fee: number; net: number } {
  const percent = MARKETER_WITHDRAWAL_FEE_PERCENT[method];
  if (percent === undefined) throw new RangeError(`unknown withdrawal method: ${method}`);
  const net = round2(amount * (1 - percent / 100));
  return { percent, fee: round2(amount - net), net };
}

// ── Requester: cashback = level% × project value × ratingFactor × paymentFactor ────────────────────
// from the single ladder (config/levels.config.ts CLIENT_LEVELS)
export const REQUESTER_CASHBACK_PERCENT: readonly number[] = CLIENT_LEVELS.map(d => d.percent);

/** ≥4.8 → 1.2, ≥4.0 → 1.0, otherwise 0.8. */
export function cashbackRatingFactor(rating: number): number {
  if (rating >= 4.8) return 1.2;
  if (rating >= 4.0) return 1.0;
  return 0.8;
}

export function cashback(level: number, projectValue: number, ratingFactor: number, paymentFactor = 1.0): number {
  const lv = Number.isInteger(level) ? Math.min(15, Math.max(1, level)) : 1;
  return round2(projectValue * (REQUESTER_CASHBACK_PERCENT[lv - 1] / 100) * ratingFactor * paymentFactor);
}

// ── Marketer ───────────────────────────────────────────────────────────────────────────────────────
/** Percent for an affiliate level, from the live config (level 7 = 2.75 until the owner confirms). */
export function affiliateCommission(level: number): number {
  return resolveAffiliateCommissionPercentage(level);
}
