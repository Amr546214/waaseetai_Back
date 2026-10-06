// BE-3 / phase 1: pure fee-policy calculator (policy v2). Constants are copied verbatim from the binding finance reference
// (xlsx, decision of 2026-10-06). NOT wired into any money path yet: nothing imports this file outside tests, so no behaviour changes.
// No Prisma, no DB, no service imports with side effects.

import { resolveAffiliateCommissionPercentage } from '../config/affiliate-levels.config';

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

// ── Provider: every deduction is applied at withdrawal. Percent points. ─────────────────────────
export interface ProviderFeeRow { level: number; platform: number; admin: number; transfer: number; vat: number; total: number }

export const PROVIDER_FEE_TABLE: readonly ProviderFeeRow[] = [
  { level: 1, platform: 5.0, admin: 2.0, transfer: 5.0, vat: 0.75, total: 12.75 },
  { level: 2, platform: 4.8, admin: 2.0, transfer: 5.0, vat: 0.72, total: 12.52 },
  { level: 3, platform: 4.6, admin: 2.5, transfer: 5.0, vat: 0.69, total: 12.79 },
  { level: 4, platform: 4.4, admin: 2.5, transfer: 4.5, vat: 0.66, total: 12.06 },
  { level: 5, platform: 4.2, admin: 3.0, transfer: 4.5, vat: 0.63, total: 12.33 },
  { level: 6, platform: 4.0, admin: 3.0, transfer: 4.0, vat: 0.60, total: 11.60 },
  { level: 7, platform: 3.75, admin: 3.5, transfer: 4.0, vat: 0.56, total: 11.81 },
  { level: 8, platform: 3.5, admin: 3.5, transfer: 3.5, vat: 0.53, total: 11.03 },
  { level: 9, platform: 3.25, admin: 4.0, transfer: 3.5, vat: 0.49, total: 11.24 },
  { level: 10, platform: 3.0, admin: 4.0, transfer: 3.0, vat: 0.45, total: 10.45 },
  { level: 11, platform: 2.75, admin: 4.5, transfer: 3.0, vat: 0.41, total: 10.66 },
  { level: 12, platform: 2.5, admin: 4.5, transfer: 2.5, vat: 0.38, total: 9.88 },
  { level: 13, platform: 2.0, admin: 5.0, transfer: 2.5, vat: 0.30, total: 9.80 },
  { level: 14, platform: 1.5, admin: 5.0, transfer: 2.0, vat: 0.23, total: 8.73 },
  { level: 15, platform: 1.0, admin: 5.0, transfer: 2.0, vat: 0.15, total: 8.15 },
];

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
  percent: { platform: number; admin: number; transfer: number; vat: number; total: number };
  fees: { platform: number; admin: number; transfer: number; vat: number; total: number };
  net: number;
}

/**
 * net = amount × (1 − total%). The table's VAT column is used as published (it is not recomputed when commission modifiers
 * lower the platform commission); only the platform commission is adjusted.
 */
export function providerWithdrawalFees(level: number, amount: number, modifiers: CommissionModifiers = {}): ProviderWithdrawalFees {
  const row = providerFeeRow(level);
  const platform = adjustedPlatformCommission(level, modifiers);
  const total = round2(platform + row.admin + row.transfer + row.vat);
  const fees = {
    platform: round2((amount * platform) / 100),
    admin: round2((amount * row.admin) / 100),
    transfer: round2((amount * row.transfer) / 100),
    vat: round2((amount * row.vat) / 100),
    total: 0,
  };
  const net = round2(amount * (1 - total / 100));
  fees.total = round2(amount - net);
  return { policyVersion: FEE_POLICY_VERSION, level: row.level, amount, percent: { platform, admin: row.admin, transfer: row.transfer, vat: row.vat, total }, fees, net };
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

// ── Requester: cashback = level% × project value × ratingFactor × paymentFactor ────────────────────
export const REQUESTER_CASHBACK_PERCENT: readonly number[] = [1, 1.5, 2, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.2, 4.4, 4.6, 4.8, 5];

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
