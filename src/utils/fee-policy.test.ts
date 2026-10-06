import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  FEE_POLICY_VERSION, PROVIDER_FEE_TABLE, providerWithdrawalFees, adjustedPlatformCommission, depositGrossUp, DEPOSIT_FEE_PERCENT,
  cashback, cashbackRatingFactor, REQUESTER_CASHBACK_PERCENT, affiliateCommission, getFeePolicyEffectiveFrom, isFeePolicyV2Active,
} from './fee-policy';

// the reference table, spelled out independently of the implementation: [platform, admin, transfer, vat, total]
const REF: Array<[number, number, number, number, number]> = [
  [5.0, 2, 5.0, 0.75, 12.75], [4.8, 2, 5.0, 0.72, 12.52], [4.6, 2.5, 5.0, 0.69, 12.79], [4.4, 2.5, 4.5, 0.66, 12.06], [4.2, 3, 4.5, 0.63, 12.33],
  [4.0, 3, 4.0, 0.60, 11.60], [3.75, 3.5, 4.0, 0.56, 11.81], [3.5, 3.5, 3.5, 0.53, 11.03], [3.25, 4, 3.5, 0.49, 11.24], [3.0, 4, 3.0, 0.45, 10.45],
  [2.75, 4.5, 3.0, 0.41, 10.66], [2.5, 4.5, 2.5, 0.38, 9.88], [2.0, 5, 2.5, 0.30, 9.80], [1.5, 5, 2.0, 0.23, 8.73], [1.0, 5, 2.0, 0.15, 8.15],
];

test('policy version is 2 and the effective date is unset by default (v2 inactive)', () => {
  assert.equal(FEE_POLICY_VERSION, 2);
  assert.equal(getFeePolicyEffectiveFrom({}), null);
  assert.equal(isFeePolicyV2Active(new Date(), {}), false);
  assert.equal(isFeePolicyV2Active(new Date('2026-12-01'), { FEE_POLICY_EFFECTIVE_FROM: '2026-11-01T00:00:00Z' }), true);
  assert.equal(isFeePolicyV2Active(new Date('2026-10-01'), { FEE_POLICY_EFFECTIVE_FROM: '2026-11-01T00:00:00Z' }), false);
  assert.equal(getFeePolicyEffectiveFrom({ FEE_POLICY_EFFECTIVE_FROM: 'garbage' }), null);
});

test('provider fee table: 15 levels × 5 columns match the reference verbatim', () => {
  assert.equal(PROVIDER_FEE_TABLE.length, 15);
  REF.forEach(([platform, admin, transfer, vat, total], i) => {
    const r = PROVIDER_FEE_TABLE[i];
    assert.deepEqual([r.level, r.platform, r.admin, r.transfer, r.vat, r.total], [i + 1, platform, admin, transfer, vat, total], `level ${i + 1}`);
    // the published total equals the sum of its parts
    assert.equal(Math.round((platform + admin + transfer + vat) * 100) / 100, total, `sum level ${i + 1}`);
  });
});

test('providerWithdrawalFees: net = amount × (1 − total%) for every level', () => {
  REF.forEach(([, , , , total], i) => {
    const r = providerWithdrawalFees(i + 1, 1000);
    assert.equal(r.percent.total, total);
    assert.equal(r.net, Math.round(1000 * (1 - total / 100) * 100) / 100);
    assert.equal(Math.round((r.net + r.fees.total) * 100) / 100, 1000);
  });
  const l1 = providerWithdrawalFees(1, 200);
  assert.deepEqual(l1.fees, { platform: 10, admin: 4, transfer: 10, vat: 1.5, total: 25.5 });
  assert.equal(l1.net, 174.5);
});

test('commission adjustments: −0.5 / −0.3 / −0.2, floor 0.5, none for missing data', () => {
  assert.equal(adjustedPlatformCommission(1, {}), 5.0);
  assert.equal(adjustedPlatformCommission(1, { avgRating: 4.8 }), 4.5);
  assert.equal(adjustedPlatformCommission(1, { avgRating: 4.79 }), 5.0);
  assert.equal(adjustedPlatformCommission(1, { onTimePercent: 80 }), 4.7);
  assert.equal(adjustedPlatformCommission(1, { onTimePercent: 79.9 }), 5.0);
  assert.equal(adjustedPlatformCommission(1, { projectsPerMonth: 10 }), 4.8);
  assert.equal(adjustedPlatformCommission(1, { projectsPerMonth: 9 }), 5.0);
  assert.equal(adjustedPlatformCommission(1, { avgRating: 5, onTimePercent: 100, projectsPerMonth: 12 }), 4.0);
  assert.equal(adjustedPlatformCommission(15, { avgRating: 5, onTimePercent: 100, projectsPerMonth: 12 }), 0.5); // 1.0 − 1.0 → floored
  assert.equal(adjustedPlatformCommission(14, { avgRating: 5 }), 1.0);
  assert.equal(adjustedPlatformCommission(1, { avgRating: null, onTimePercent: null, projectsPerMonth: null }), 5.0);
  const withMod = providerWithdrawalFees(1, 1000, { avgRating: 4.9 });
  assert.equal(withMod.percent.platform, 4.5);
  assert.equal(withMod.percent.total, 12.25);
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

test('fee-policy is wired into nothing (no production file imports it) and BROKER_LEVEL_MATRIX is gone', () => {
  const root = join(__dirname, '..');
  const walk = (d: string, out: string[] = []): string[] => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
  for (const f of walk(root).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts') && !x.endsWith('fee-policy.ts'))) {
    const t = readFileSync(f, 'utf-8');
    assert.equal(/from ['"][^'"]*fee-policy['"]/.test(t), false, `${f} imports fee-policy`);
    assert.equal(t.includes('BROKER_LEVEL_MATRIX'), false, `${f} references BROKER_LEVEL_MATRIX`);
  }
});
