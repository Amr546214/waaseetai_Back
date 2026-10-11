import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEscrowSnapshot, commissionOn, splitRelease, isV2Escrow, providerReleased, providerNetEntitlement, ESCROW_FEE_POLICY_V2 } from './escrow-commission';

test('the snapshot is the provider\'s level and that level\'s commission from the single ladder (workbook 12.75% .. 8.15%)', () => {
  const at = new Date('2026-10-12T10:00:00Z');
  assert.deepEqual(buildEscrowSnapshot(1, at), { feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, providerCommissionSnapshotAt: at });
  assert.deepEqual([buildEscrowSnapshot(6).providerCommissionRateSnapshot, buildEscrowSnapshot(15).providerCommissionRateSnapshot], [11.12, 8.15]);
  for (const bad of [null, undefined, 0, 99, 2.5]) assert.equal(buildEscrowSnapshot(bad as any).providerCommissionLevelSnapshot, bad === 99 ? 15 : 1, String(bad));
  assert.equal(ESCROW_FEE_POLICY_V2, 2);
});

test('one release: commission on the stage, net = stage − commission', () => {
  const r = splitRelease({ grossReleasedBefore: 0, commissionTotalBefore: 0, grossReleasedAfter: 400, ratePercent: 12.75 });
  assert.deepEqual([r.gross, r.commission, r.net], [400, 51, 349]);
  assert.deepEqual([r.grossReleasedAfter, r.commissionTotalAfter, r.netReleasedAfter], [400, 51, 349]);
});

test('over a whole contract the total commission is exactly round2(price × rate), whatever the stage split (no cent drift)', () => {
  const price = 1000, rate = 11.45; // 114.5
  let gross = 0, commission = 0, net = 0;
  for (const stage of [333.33, 333.33, 333.34]) {
    const r = splitRelease({ grossReleasedBefore: gross, commissionTotalBefore: commission, grossReleasedAfter: gross + stage, ratePercent: rate });
    gross = r.grossReleasedAfter; commission = r.commissionTotalAfter; net += r.net;
  }
  assert.equal(gross, price);
  assert.equal(commission, commissionOn(price, rate));
  assert.equal(commission, 114.5);
  assert.equal(Math.round(net * 100) / 100, 885.5);
});

test('three odd stages: stage commissions add up to the total and nets add up to price − total', () => {
  const rate = 12.42; const stages = [100.01, 200.02, 300.03]; const price = 600.06;
  let g = 0, c = 0; const nets: number[] = []; const coms: number[] = [];
  for (const s of stages) { const r = splitRelease({ grossReleasedBefore: g, commissionTotalBefore: c, grossReleasedAfter: g + s, ratePercent: rate }); g = r.grossReleasedAfter; c = r.commissionTotalAfter; nets.push(r.net); coms.push(r.commission); }
  assert.equal(Math.round(coms.reduce((a, b) => a + b, 0) * 100) / 100, commissionOn(price, rate));
  assert.equal(Math.round(nets.reduce((a, b) => a + b, 0) * 100) / 100, providerNetEntitlement(price, rate));
});

test('final release sets the cumulative gross to the contract price (direct set) and the commission total follows', () => {
  const r = splitRelease({ grossReleasedBefore: 700, commissionTotalBefore: commissionOn(700, 8.15), grossReleasedAfter: 1000, ratePercent: 8.15 });
  assert.equal(r.commissionTotalAfter, 81.5);
  assert.equal(r.netReleasedAfter, 918.5);
  assert.equal(r.gross, 300);
});

test('legacy vs v2 detection and what the provider counts on', () => {
  assert.equal(isV2Escrow({ feePolicyVersion: null }), false);
  assert.equal(isV2Escrow({}), false);
  assert.equal(isV2Escrow(null), false);
  assert.equal(isV2Escrow({ feePolicyVersion: 2 }), true);
  assert.equal(providerReleased({ feePolicyVersion: null, releasedAmount: 500, providerNetReleasedAmount: 0 }), 500, 'legacy = gross, unchanged');
  assert.equal(providerReleased({ feePolicyVersion: 2, releasedAmount: 500, providerNetReleasedAmount: 436.25 }), 436.25);
  assert.equal(providerNetEntitlement(1000, 12.75), 872.5);
});
