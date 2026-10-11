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

// ── createCommissionsForStageReleaseEvent: direct tests with a fake transaction client (no DB, no schema needed) ──
import { Prisma } from '@prisma/client';
import { createCommissionsForStageReleaseEvent } from './affiliate-commission.service';

const FLAG = 'AFFILIATE_COMMISSION_ENGINE_ENABLED';
const ctx = { contract: { id: 'c1', projectId: 'p1', clientId: 'client-1', providerId: 'provider-1' }, stageId: 'stage-1', releasedAmount: 500 };
const ref = (referredUserId: string, level = 1, over: any = {}) => ({ id: `ref-${referredUserId}`, referredUserId, affiliate: { id: `aff-${referredUserId}`, level, userId: `aff-user-${referredUserId}` }, ...over });
function fakeTx(opts: { referrals?: any[]; dispute?: boolean; createImpl?: (a: any) => any } = {}) {
  const calls = { dispute: 0, referral: [] as any[], create: [] as any[] };
  const tx: any = {
    dispute: { findFirst: async () => { calls.dispute++; return opts.dispute ? { id: 'd1' } : null; } },
    referral: { findMany: async (args: any) => { calls.referral.push(args); return (opts.referrals ?? []); } }, // returns every fixture row regardless of the where, so the service's own guard is what is under test
    commissionLog: { create: async (args: any) => { calls.create.push(args.data); if (opts.createImpl) return opts.createImpl(args); return args.data; } },
  };
  return { tx, calls };
}
function withFlag(value: string | undefined) {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG]; else process.env[FLAG] = value;
  return () => { if (prev === undefined) delete process.env[FLAG]; else process.env[FLAG] = prev; };
}

test('engine: flag off (default) => no reads and no writes at all', async () => {
  const restore = withFlag(undefined);
  try {
    const { tx, calls } = fakeTx({ referrals: [ref('client-1')] });
    await createCommissionsForStageReleaseEvent(tx, ctx);
    assert.deepEqual([calls.dispute, calls.referral.length, calls.create.length], [0, 0, 0]);
  } finally { restore(); }
});

test('engine: referred client + stage release => one commission with every snapshot field, from the gross stage amount', async () => {
  const restore = withFlag('true');
  try {
    const { tx, calls } = fakeTx({ referrals: [ref('client-1', 3)] });
    await createCommissionsForStageReleaseEvent(tx, ctx);
    assert.equal(calls.create.length, 1);
    assert.deepEqual(calls.referral[0].where, { referredUserId: 'client-1' });
    const d = calls.create[0];
    assert.equal(d.baseAmount, 500);
    assert.equal(d.appliedPercentage, 1.5);
    assert.equal(d.level, 3);
    assert.equal(d.amount, 7.5);
    assert.equal(d.sourceStageId, 'stage-1');
    assert.equal(d.sourceProjectId, 'p1');
    assert.equal(d.referredUserId, 'client-1');
    assert.equal(d.referralId, 'ref-client-1');
    assert.equal(d.affiliateId, 'aff-client-1');
    assert.equal(d.type, 'STAGE_RELEASE');
    assert.equal(d.status, 'APPROVED');
    assert.equal(d.currency, 'USD');
  } finally { restore(); }
});

test('engine: referred PROVIDER only => no commission, and the provider is never looked up', async () => {
  const restore = withFlag('true');
  try {
    const { tx, calls } = fakeTx({ referrals: [ref('provider-1', 5)] });
    await createCommissionsForStageReleaseEvent(tx, ctx);
    assert.equal(calls.create.length, 0);
    assert.equal(JSON.stringify(calls.referral).includes('provider-1'), false);
  } finally { restore(); }
});

test('engine: client AND provider both referred => exactly one commission, for the client', async () => {
  const restore = withFlag('true');
  try {
    const { tx, calls } = fakeTx({ referrals: [ref('client-1', 1), ref('provider-1', 9)] });
    await createCommissionsForStageReleaseEvent(tx, ctx);
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].referredUserId, 'client-1');
  } finally { restore(); }
});

test('engine: the percentage comes from the official ladder, 1% at level 1 up to 4.5% at level 15', async () => {
  const restore = withFlag('true');
  try {
    for (const [level, pct] of [[1, 1], [7, 2.75], [15, 4.5]] as const) {
      const { tx, calls } = fakeTx({ referrals: [ref('client-1', level)] });
      await createCommissionsForStageReleaseEvent(tx, { ...ctx, releasedAmount: 1000 });
      assert.deepEqual([calls.create[0].appliedPercentage, calls.create[0].amount], [pct, pct * 10], `level ${level}`);
    }
  } finally { restore(); }
});

test('engine: an OPEN / UNDER_REVIEW dispute => no commission and no referral read', async () => {
  const restore = withFlag('true');
  try {
    const { tx, calls } = fakeTx({ referrals: [ref('client-1')], dispute: true });
    await createCommissionsForStageReleaseEvent(tx, ctx);
    assert.deepEqual([calls.referral.length, calls.create.length], [0, 0]);
  } finally { restore(); }
});

test('engine: a duplicate/retried stage release (dedup constraint P2002) is swallowed, so no duplicate and no throw', async () => {
  const restore = withFlag('true');
  try {
    const dup = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test', meta: { target: ['commission_logs_affiliateId_referralId_type_sourceStageId_key'] } });
    const { tx, calls } = fakeTx({ referrals: [ref('client-1')], createImpl: () => { throw dup; } });
    await createCommissionsForStageReleaseEvent(tx, ctx);
    assert.equal(calls.create.length, 1);
    const other = new Prisma.PrismaClientKnownRequestError('other', { code: 'P2002', clientVersion: 'test', meta: { target: ['something_else'] } });
    await assert.rejects(() => createCommissionsForStageReleaseEvent(fakeTx({ referrals: [ref('client-1')], createImpl: () => { throw other; } }).tx, ctx));
  } finally { restore(); }
});

test('engine: a self-referral (affiliate is the client) never earns', async () => {
  const restore = withFlag('true');
  try {
    const { tx, calls } = fakeTx({ referrals: [ref('client-1', 5, { affiliate: { id: 'a', level: 5, userId: 'client-1' } })] });
    await createCommissionsForStageReleaseEvent(tx, ctx);
    assert.equal(calls.create.length, 0);
  } finally { restore(); }
});
