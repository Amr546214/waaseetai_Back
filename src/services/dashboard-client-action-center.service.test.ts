import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// The client dashboard's action cards (escrow required / delivery waiting / offers waiting), the human rating and
// the active-contract progress used to be hardcoded 0. They are real reads now; this proves the numbers and the
// honest-null / fail-soft behaviour of getClientStats.

async function loadService(t: TestContext, opts: { contractsPendingPayment?: number; proposalCount?: number; reviews?: { count: number; avg: number | null }; stages?: { total: number; approved: number }; pendingCount?: number; throwReviews?: boolean; activeContract?: any } = {}) {
  const calls: { proposalCount: any[]; contractCount: any[]; review: any[]; stageCount: any[] } = { proposalCount: [], contractCount: [], review: [], stageCount: [] };
  const prismaMock: any = {
    project: { count: async () => 0, aggregate: async () => ({ _sum: { budgetFixed: 0, budgetMax: 0 } }), findMany: async () => [] },
    proposal: { count: async (a: any) => { calls.proposalCount.push(a); return opts.proposalCount ?? 0; }, findMany: async () => [] },
    escrow: { aggregate: async () => ({ _sum: { amount: 0 } }) },
    user: { findUnique: async () => ({ activeRole: 'CLIENT', profileCompletionPercent: 0, currentLevel: null, currentPoints: 0, pointsToNextLevel: 100, clientProfile: null }) },
    contract: {
      findFirst: async () => opts.activeContract ?? null,
      count: async (a: any) => { calls.contractCount.push(a); return opts.contractsPendingPayment ?? 0; },
    },
    review: {
      aggregate: async (a: any) => {
        calls.review.push(a);
        if (opts.throwReviews) throw new Error('db down');
        return { _count: { _all: opts.reviews?.count ?? 0 }, _avg: { rating: opts.reviews?.avg ?? null } };
      },
    },
    projectStage: {
      count: async (a: any) => {
        if (a.where.contract) { calls.stageCount.push(a); return opts.pendingCount ?? 0; }
        return a.where.status ? opts.stages?.approved ?? 0 : opts.stages?.total ?? 0;
      },
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const mod = await import(`./dashboard.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service: mod.dashboardService as { getClientStats: (userId: string) => Promise<any> }, calls };
}

test('topSteps: escrow-required counts the client\'s PENDING_PAYMENT contracts, offers counts only actionable statuses on OPEN requests', async t => {
  const { service, calls } = await loadService(t, { contractsPendingPayment: 2, proposalCount: 5 });
  const r = await service.getClientStats('client-1');
  assert.equal(r.topSteps.step1_escrowRequiredCount, 2);
  assert.equal(r.topSteps.step3_pendingProposalsCount, 5);
  assert.deepEqual(calls.contractCount[0].where, { clientId: 'client-1', status: 'PENDING_PAYMENT' });
  const statusFilter = calls.proposalCount[0].where.status.in;
  assert.deepEqual(statusFilter, ['PENDING', 'SUBMITTED', 'UNDER_NEGOTIATION']);
  assert.ok(!statusFilter.includes('DRAFT') && !statusFilter.includes('REJECTED'));
});

test('topSteps: pending approval counts SUBMITTED stages with a SUBMITTED delivery on the client\'s ACTIVE contracts', async t => {
  const { service, calls } = await loadService(t, { pendingCount: 2 });
  const r = await service.getClientStats('client-1');
  assert.equal(r.topSteps.step2_pendingApprovalCount, 2);
  assert.deepEqual(calls.stageCount[0].where, { status: 'SUBMITTED', contract: { clientId: 'client-1', status: 'ACTIVE' }, deliveries: { some: { status: 'SUBMITTED' } } });
});

test('humanRating: real average of provider reviews of the client; null (never 0) when there are none; null when the read fails', async t => {
  let ctx = await loadService(t, { reviews: { count: 3, avg: 4.333 } });
  let r = await ctx.service.getClientStats('client-1');
  assert.equal(Math.round(r.summary.humanRating * 100) / 100, 4.33);
  assert.deepEqual(ctx.calls.review[0].where, { clientId: 'client-1', reviewerRole: 'PROVIDER' });
});

test('humanRating is null with no reviews', async t => {
  const { service } = await loadService(t, { reviews: { count: 0, avg: null } });
  assert.equal((await service.getClientStats('client-1')).summary.humanRating, null);
});

test('humanRating read failure never breaks the dashboard: null', async t => {
  const { service } = await loadService(t, { throwReviews: true });
  const r = await service.getClientStats('client-1');
  assert.equal(r.summary.humanRating, null);
});

test('activeContract progress = approved stages / stages, 0 when the contract has no stages', async t => {
  const contract = { id: 'c1', status: 'ACTIVE', price: 100, project: { id: 'abcdefgh', title: 'P', status: 'IN_PROGRESS' }, provider: { firstName: 'A', lastName: 'B', providerProfile: null } };
  let { service } = await loadService(t, { activeContract: contract, stages: { total: 4, approved: 1 } });
  assert.equal((await service.getClientStats('client-1')).activeContract.progress, 25);
});

test('activeContract progress is 0 without stages', async t => {
  const contract = { id: 'c1', status: 'ACTIVE', price: 100, project: { id: 'abcdefgh', title: 'P', status: 'IN_PROGRESS' }, provider: { firstName: 'A', lastName: 'B', providerProfile: null } };
  const { service } = await loadService(t, { activeContract: contract, stages: { total: 0, approved: 0 } });
  assert.equal((await service.getClientStats('client-1')).activeContract.progress, 0);
});
