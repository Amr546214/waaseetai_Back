import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAffiliateCommission } from './affiliate-commission.service';

// calculateAffiliateCommission() is pure (no DB access), so it is directly
// unit-testable regardless of AFFILIATE_COMMISSION_ENGINE_ENABLED — see
// project-progress.service.test.ts for the full end-to-end (flag on/off,
// dispute, idempotency, multi-referral) coverage of the engine hook itself.

test('calculateAffiliateCommission: level 1 (مسوق) applies the P-LG-012 1.00% rate', () => {
  const result = calculateAffiliateCommission(1, 1000);
  assert.equal(result.percentage, 1.0);
  assert.equal(result.amount, 10);
  assert.equal(result.level, 1);
});

test('calculateAffiliateCommission: level 15 (رابط مؤسسي) applies the P-LG-012 4.50% rate', () => {
  const result = calculateAffiliateCommission(15, 1000);
  assert.equal(result.percentage, 4.5);
  assert.equal(result.amount, 45);
});

test('calculateAffiliateCommission: every one of the 15 P-LG-012 levels resolves to its exact documented percentage', () => {
  const expected: Record<number, number> = {
    1: 1.0, 2: 1.2, 3: 1.5, 4: 2.0, 5: 2.25,
    6: 2.5, 7: 2.75, 8: 3.0, 9: 3.2, 10: 3.4,
    11: 3.6, 12: 3.8, 13: 4.0, 14: 4.3, 15: 4.5
  };
  for (const [level, pct] of Object.entries(expected)) {
    const result = calculateAffiliateCommission(Number(level), 100);
    assert.equal(result.percentage, pct, `level ${level}`);
  }
});

test('calculateAffiliateCommission: an out-of-range level (defense-in-depth) falls back to level 1\'s rate rather than throwing or producing NaN', () => {
  const tooHigh = calculateAffiliateCommission(99, 1000);
  const tooLow = calculateAffiliateCommission(0, 1000);
  const notInteger = calculateAffiliateCommission(2.5, 1000);
  assert.equal(tooHigh.percentage, 1.0);
  assert.equal(tooLow.percentage, 1.0);
  assert.equal(notInteger.percentage, 1.0);
});

test('calculateAffiliateCommission: rounds to 2 decimal places (currency-safe)', () => {
  const result = calculateAffiliateCommission(9, 33.33); // 3.20%
  // 33.33 * 0.032 = 1.06656 -> rounds to 1.07
  assert.equal(result.amount, 1.07);
});

test('calculateAffiliateCommission: the base amount is the ONLY thing it is computed from — never a client-supplied figure (regression guard: signature takes level + baseAmount only, both backend-authoritative)', () => {
  // This is enforced by the type signature itself (level: number, baseAmount: number)
  // — no request/body object is ever accepted here. The real caller
  // (createCommissionsForStageReleaseEvent in this same file) only ever
  // passes stage.amount/the affiliate's own persisted level, both read from
  // the DB inside the same transaction as the escrow release — never
  // anything from req.body. See project-progress.service.test.ts's
  // "uses stage.amount as the base, not contract.price" test for the
  // end-to-end proof of that authoritative sourcing.
  const result = calculateAffiliateCommission(1, 500);
  assert.equal(result.amount, 5);
});
