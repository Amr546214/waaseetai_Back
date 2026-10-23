import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  FEE_POLICY_VERSION, PROVIDER_FEE_TABLE, MARKETER_WITHDRAWAL_FEE_PERCENT, marketerWithdrawalFees, providerWithdrawalFees, adjustedPlatformCommission, depositGrossUp, DEPOSIT_FEE_PERCENT,
  cashback, cashbackRatingFactor, REQUESTER_CASHBACK_PERCENT, affiliateCommission, getFeePolicyEffectiveFrom, isFeePolicyV2Active,
} from './fee-policy';

// the reference table, spelled out independently of the implementation: نسب الدفع.xlsx "الخصم النهائي لمقدمي الخدمات" (= the platform commission)
const REF = [12.75, 12.42, 12.10, 11.77, 11.45, 11.12, 10.80, 10.47, 10.15, 9.82, 9.50, 9.17, 8.85, 8.52, 8.15];

test('policy version is 2 and the effective date is unset by default (v2 inactive)', () => {
  assert.equal(FEE_POLICY_VERSION, 2);
  assert.equal(getFeePolicyEffectiveFrom({}), null);
  assert.equal(isFeePolicyV2Active(new Date(), {}), false);
  assert.equal(isFeePolicyV2Active(new Date('2026-12-01'), { FEE_POLICY_EFFECTIVE_FROM: '2026-11-01T00:00:00Z' }), true);
  assert.equal(isFeePolicyV2Active(new Date('2026-10-01'), { FEE_POLICY_EFFECTIVE_FROM: '2026-11-01T00:00:00Z' }), false);
  assert.equal(getFeePolicyEffectiveFrom({ FEE_POLICY_EFFECTIVE_FROM: 'garbage' }), null);
});

test('provider fee table: 15 levels, the final deduction 12.75% -> 8.15% verbatim, with no other fee on top', () => {
  assert.equal(PROVIDER_FEE_TABLE.length, 15);
  REF.forEach((pct, i) => {
    assert.deepEqual(PROVIDER_FEE_TABLE[i], { level: i + 1, platform: pct, total: pct }, `level ${i + 1}`);
  });
});

test('providerWithdrawalFees: net = amount × (1 − final deduction) for every level', () => {
  REF.forEach((pct, i) => {
    const r = providerWithdrawalFees(i + 1, 1000);
    assert.deepEqual(r.percent, { platform: pct, total: pct });
    assert.equal(r.net, Math.round(1000 * (1 - pct / 100) * 100) / 100);
    assert.equal(Math.round((r.net + r.fees.total) * 100) / 100, 1000);
  });
  const l1 = providerWithdrawalFees(1, 200);
  assert.deepEqual(l1.fees, { platform: 25.5, total: 25.5 });
  assert.equal(l1.net, 174.5);
});

test('commission adjustments (config only, not wired): −0.5 / −0.3 / −0.2 on the same number, floor 0.5, none for missing data', () => {
  assert.equal(adjustedPlatformCommission(1, {}), 12.75);
  assert.equal(adjustedPlatformCommission(1, { avgRating: 4.8 }), 12.25);
  assert.equal(adjustedPlatformCommission(1, { avgRating: 4.79 }), 12.75);
  assert.equal(adjustedPlatformCommission(1, { onTimePercent: 80 }), 12.45);
  assert.equal(adjustedPlatformCommission(1, { onTimePercent: 79.9 }), 12.75);
  assert.equal(adjustedPlatformCommission(1, { projectsPerMonth: 10 }), 12.55);
  assert.equal(adjustedPlatformCommission(1, { projectsPerMonth: 9 }), 12.75);
  assert.equal(adjustedPlatformCommission(1, { avgRating: 5, onTimePercent: 100, projectsPerMonth: 12 }), 11.75);
  assert.equal(adjustedPlatformCommission(15, { avgRating: 5, onTimePercent: 100, projectsPerMonth: 12 }), 7.15);
  assert.equal(adjustedPlatformCommission(1, { avgRating: null, onTimePercent: null, projectsPerMonth: null }), 12.75);
  const withMod = providerWithdrawalFees(1, 1000, { avgRating: 4.9 });
  assert.deepEqual(withMod.percent, { platform: 12.25, total: 12.25 });
  assert.equal(withMod.net, 877.5);
});

test('out-of-range level is clamped to 1..15', () => {
  assert.equal(providerWithdrawalFees(0, 100).level, 1);
  assert.equal(providerWithdrawalFees(99, 100).level, 15);
});

test('depositGrossUp: reference examples for every method', () => {
  assert.equal(depositGrossUp(100, 'mada'), 104.44);
  assert.equal(depositGrossUp(100, 'visa_mastercard'), 105.82);
  assert.equal(depositGrossUp(100, 'paypal'), 107.53);
  assert.equal(depositGrossUp(100, 'international_transfer'), 108.11);
  assert.equal(depositGrossUp(100, 'other'), 109.29);
  assert.deepEqual(DEPOSIT_FEE_PERCENT, { mada: 4.25, visa_mastercard: 5.5, paypal: 7, international_transfer: 7.5, other: 8.5 });
  assert.throws(() => depositGrossUp(100, 'x' as any), RangeError);
});

test('cashback: 15 level rates, rating factor, payment factor', () => {
  assert.deepEqual([...REQUESTER_CASHBACK_PERCENT], [1, 1.5, 2, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.2, 4.4, 4.6, 4.8, 5]);
  REQUESTER_CASHBACK_PERCENT.forEach((pct, i) => assert.equal(cashback(i + 1, 1000, 1), Math.round(10 * pct * 100) / 100, `level ${i + 1}`));
  assert.equal(cashbackRatingFactor(4.8), 1.2);
  assert.equal(cashbackRatingFactor(4.79), 1.0);
  assert.equal(cashbackRatingFactor(4.0), 1.0);
  assert.equal(cashbackRatingFactor(3.99), 0.8);
  assert.equal(cashback(10, 1000, 1.2), 48); // 4% × 1000 × 1.2
  assert.equal(cashback(10, 1000, 1.0, 1.1), 44);
  assert.equal(cashback(1, 1000, 0.8), 8);
});

test('affiliateCommission: 15 levels from the live config; level 7 = 2.75', () => {
  const expected = [1, 1.2, 1.5, 2, 2.25, 2.5, 2.75, 3.0, 3.2, 3.4, 3.6, 3.8, 4.0, 4.3, 4.5];
  expected.forEach((p, i) => assert.equal(affiliateCommission(i + 1), p, `level ${i + 1}`));
});

// The ONLY importers: the read-only display endpoint (GET /levels serves the published percentage tables) and the PayPal DEPOSIT fee (7%, phase 1).
// Nothing else is wired: no cashback, no marketer withdrawal fee, no provider withdrawal fee (the provider commission is taken at stage release, in utils/escrow-commission.ts).
const READ_ONLY_DISPLAY_IMPORTERS = ['gamification.controller.ts', 'paypal-finance.service.ts'];
test('fee-policy is wired only into the /levels display and the PayPal deposit fee, and BROKER_LEVEL_MATRIX is gone', () => {
  const root = join(__dirname, '..');
  const walk = (d: string, out: string[] = []): string[] => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
  for (const f of walk(root).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts') && !x.endsWith('fee-policy.ts'))) {
    const t = readFileSync(f, 'utf-8');
    if (!READ_ONLY_DISPLAY_IMPORTERS.some(n => f.endsWith(n))) assert.equal(/from ['"][^'"]*fee-policy['"]/.test(t), false, `${f} imports fee-policy`);
    assert.equal(t.includes('BROKER_LEVEL_MATRIX'), false, `${f} references BROKER_LEVEL_MATRIX`);
  }
});

test('marketer withdrawal fees (نسب الدفع.xlsx): bank transfer 8.25%, PayPal 7.75%, USDT 4% — net = amount × (1 − rate)', () => {
  assert.deepEqual(MARKETER_WITHDRAWAL_FEE_PERCENT, { bank_transfer: 8.25, paypal: 7.75, usdt: 4 });
  assert.deepEqual(marketerWithdrawalFees(1000, 'bank_transfer'), { percent: 8.25, fee: 82.5, net: 917.5 });
  assert.deepEqual(marketerWithdrawalFees(1000, 'paypal'), { percent: 7.75, fee: 77.5, net: 922.5 });
  assert.deepEqual(marketerWithdrawalFees(1000, 'usdt'), { percent: 4, fee: 40, net: 960 });
  assert.throws(() => marketerWithdrawalFees(100, 'x' as any), RangeError);
});
