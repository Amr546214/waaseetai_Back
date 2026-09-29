import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 7 — marketing center aggregation. Same Prisma mocking approach as
// provider-coupon.service.test.ts / provider-special-offer.service.test.ts
// (t.mock.module('../config/db', ...)) — no real DB involved.

const NOW = new Date(Date.UTC(2026, 8, 20, 12)); // 2026-09-20
const THIS_MONTH = (day: number) => new Date(Date.UTC(2026, 8, day));
const LAST_MONTH = (day: number) => new Date(Date.UTC(2026, 7, day));
const OLD = new Date(Date.UTC(2026, 0, 5));

const coupon = (over: any = {}) => ({
  id: 'c1', code: 'HOWIA25', active: true, expiresAt: null, approvalStatus: 'APPROVED', usedCount: 0, maxUses: 50,
  createdAt: OLD, assignedToTeamMemberId: null, assignedToTeamMember: null, ...over
});
const offer = (over: any = {}) => ({
  id: 'o1', name: 'باقة الهوية', type: 'BUNDLE', active: true, expiresAt: null, approvalStatus: 'APPROVED', usedCount: 0,
  createdAt: OLD, assignedToTeamMemberId: null, assignedToTeamMember: null, ...over
});
const redemption = (amount: number, createdAt: Date, orderId: string, total: number) => ({ amount, createdAt, orderId, order: { total } });

async function loadService(t: TestContext, fx: {
  accountType: string; cap?: number | null; coupons?: any[]; offers?: any[];
  couponWindow?: any[]; offerWindow?: any[]; couponGroups?: any[]; offerGroups?: any[]; team?: any[];
}) {
  const userUpdate = t.mock.fn(async ({ data }: any) => ({ marketingMonthlySpendCap: data.marketingMonthlySpendCap }));
  const couponRedemptionFindMany = t.mock.fn(async () => fx.couponWindow ?? []);
  const prismaMock: any = {
    user: { findUnique: async () => ({ accountType: fx.accountType, marketingMonthlySpendCap: fx.cap ?? null }), update: userUpdate },
    coupon: { findMany: async () => fx.coupons ?? [] },
    specialOffer: { findMany: async () => fx.offers ?? [] },
    couponRedemption: { findMany: couponRedemptionFindMany, groupBy: async () => fx.couponGroups ?? [] },
    specialOfferRedemption: { findMany: async () => fx.offerWindow ?? [], groupBy: async () => fx.offerGroups ?? [] },
    companyTeamMember: { findMany: async () => fx.team ?? [] }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const { marketingCenterService } = await import(`./marketing-center.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { marketingCenterService, userUpdate, couponRedemptionFindMany };
}

test('active tools count = active coupons + active offers', async t => {
  const { marketingCenterService } = await loadService(t, {
    accountType: 'PROVIDER_INDIVIDUAL',
    coupons: [coupon({ id: 'c1' }), coupon({ id: 'c2', active: false }), coupon({ id: 'c3', createdAt: THIS_MONTH(2) })],
    offers: [offer({ id: 'o1' }), offer({ id: 'o2', active: false, expiresAt: LAST_MONTH(1) })]
  });
  const r = await marketingCenterService.getCenter('p1', NOW);
  assert.deepEqual(r.kpis.activeTools, { count: 3, coupons: 2, offers: 1, createdThisMonth: 1 });
  assert.equal(r.toolSummaries.coupons.active, 2);
  assert.equal(r.toolSummaries.coupons.paused, 1);
  assert.equal(r.toolSummaries.offers.expired, 1);
  assert.equal(r.company, undefined, 'individual providers get no company block');
});

test('monthly usage / discounted value / revenue with real month-over-month deltas', async t => {
  const { marketingCenterService, couponRedemptionFindMany } = await loadService(t, {
    accountType: 'PROVIDER_INDIVIDUAL',
    couponWindow: [
      redemption(100, THIS_MONTH(3), 'ord1', 900),
      redemption(50, THIS_MONTH(10), 'ord2', 450),
      redemption(100, LAST_MONTH(15), 'ord3', 1000)
    ],
    // ord1 carries both a coupon and an offer redemption → revenue counted once
    offerWindow: [redemption(25, THIS_MONTH(3), 'ord1', 900)]
  });
  const r = await marketingCenterService.getCenter('p1', NOW);
  assert.deepEqual(r.kpis.monthlyUsage, { value: 3, previousMonth: 1, changePercent: 200 });
  assert.deepEqual(r.kpis.discountedValue, { value: 175, previousMonth: 100, changePercent: 75 });
  assert.deepEqual(r.kpis.extraRevenue, { value: 1350, previousMonth: 1000, changePercent: 35 });

  assert.equal(r.monthlyTrend.length, 6);
  assert.equal(r.monthlyTrend[0].month, '2026-04');
  assert.equal(r.monthlyTrend[5].month, '2026-09');
  assert.equal(r.monthlyTrend[4].usageCount, 1);

  // Cancelled orders excluded + provider scoping at the query level
  const where = (couponRedemptionFindMany.mock.calls[0].arguments as any)[0].where;
  assert.deepEqual(where.coupon, { providerId: 'p1' });
  assert.deepEqual(where.order, { status: { not: 'CANCELLED' } });
});

test('delta is null (not fabricated) when previous month has no baseline', async t => {
  const { marketingCenterService } = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL', couponWindow: [redemption(10, THIS_MONTH(1), 'o', 100)] });
  const r = await marketingCenterService.getCenter('p1', NOW);
  assert.equal(r.kpis.monthlyUsage.changePercent, null);
});

test('top tools leaderboard is sorted by usage and merges coupons + offers', async t => {
  const { marketingCenterService } = await loadService(t, {
    accountType: 'PROVIDER_INDIVIDUAL',
    coupons: [coupon({ id: 'c1', code: 'A' }), coupon({ id: 'c2', code: 'B' })],
    offers: [offer({ id: 'o1', name: 'Bundle' })],
    couponGroups: [{ couponId: 'c1', _count: { _all: 3 }, _sum: { amount: 30 }, _max: { createdAt: THIS_MONTH(1) } }],
    offerGroups: [{ offerId: 'o1', _count: { _all: 7 }, _sum: { amount: 930 }, _max: { createdAt: THIS_MONTH(5) } }]
  });
  const r = await marketingCenterService.getCenter('p1', NOW);
  assert.deepEqual(r.topTools.map((x: any) => x.id), ['o1', 'c1', 'c2']);
  assert.equal(r.topTools[0].discountedValue, 930);
  assert.equal(r.topTools[0].kind, 'OFFER');
  assert.equal(r.topTools[2].usageCount, 0);
  assert.equal('assignedTo' in r.topTools[0], false, 'individual leaderboard has no assigned-to column');
});

test('company: pending approvals count = pending coupons + pending offers', async t => {
  const { marketingCenterService } = await loadService(t, {
    accountType: 'PROVIDER_COMPANY',
    coupons: [coupon({ id: 'c1', approvalStatus: 'PENDING', active: false }), coupon({ id: 'c2', approvalStatus: 'PENDING', active: false }), coupon({ id: 'c3' })],
    offers: [offer({ id: 'o1', approvalStatus: 'PENDING', active: false }), offer({ id: 'o2', approvalStatus: 'REJECTED', active: false })]
  });
  const r = await marketingCenterService.getCenter('p1', NOW);
  assert.deepEqual(r.company.pendingApprovals, { count: 3, coupons: 2, offers: 1 });
  assert.equal(r.toolSummaries.offers.rejected, 1);
});

test('company: team performance groups tools + redemption stats by assignedToTeamMemberId', async t => {
  const sara = { id: 'm1', name: 'سارة', avatarUrl: 'https://x/a.png' };
  const { marketingCenterService } = await loadService(t, {
    accountType: 'PROVIDER_COMPANY',
    team: [{ ...sara, jobTitle: 'مسوقة', status: 'ACTIVE' }, { id: 'm2', name: 'نواف', avatarUrl: null, jobTitle: 'مطور', status: 'ACTIVE' }],
    coupons: [
      coupon({ id: 'c1', assignedToTeamMemberId: 'm1', assignedToTeamMember: sara }),
      coupon({ id: 'c2', assignedToTeamMemberId: 'm1', assignedToTeamMember: sara, active: false }),
      coupon({ id: 'c3' })
    ],
    offers: [offer({ id: 'o1', assignedToTeamMemberId: 'm1', assignedToTeamMember: sara })],
    couponGroups: [
      { couponId: 'c1', _count: { _all: 18 }, _sum: { amount: 2250 }, _max: { createdAt: THIS_MONTH(1) } },
      { couponId: 'c3', _count: { _all: 5 }, _sum: { amount: 100 }, _max: { createdAt: THIS_MONTH(1) } }
    ],
    offerGroups: [{ offerId: 'o1', _count: { _all: 2 }, _sum: { amount: 50 }, _max: { createdAt: THIS_MONTH(1) } }]
  });
  const r = await marketingCenterService.getCenter('p1', NOW);
  const [first, second] = r.company.teamPerformance;
  assert.equal(first.teamMemberId, 'm1');
  assert.equal(first.activeCoupons, 1);
  assert.equal(first.activeOffers, 1);
  assert.equal(first.totalTools, 3);
  assert.equal(first.usageCount, 20);
  assert.equal(first.discountedValue, 2300);
  assert.deepEqual({ id: second.teamMemberId, tools: second.totalTools, value: second.discountedValue }, { id: 'm2', tools: 0, value: 0 });
  assert.deepEqual(r.topTools[0].assignedTo, sara, 'company leaderboard gains assigned-to');
  assert.equal(r.topTools.find((x: any) => x.id === 'c3').assignedTo, null);
});

test('company: spend cap reports real consumed vs stored cap', async t => {
  const { marketingCenterService } = await loadService(t, {
    accountType: 'PROVIDER_COMPANY', cap: 10000,
    couponWindow: [redemption(3000, THIS_MONTH(2), 'a', 9000), redemption(500, LAST_MONTH(2), 'b', 900)],
    offerWindow: [redemption(180, THIS_MONTH(4), 'c', 700)]
  });
  const r = await marketingCenterService.getCenter('p1', NOW);
  assert.equal(r.company.spendCap.configured, true);
  assert.equal(r.company.spendCap.cap, 10000);
  assert.equal(r.company.spendCap.consumed, 3180);
  assert.equal(r.company.spendCap.remaining, 6820);
  assert.equal(r.company.spendCap.percentUsed, 31.8);
  assert.equal(r.company.spendCap.resetsAt.toISOString(), '2026-10-01T00:00:00.000Z');
});

test('company: no cap configured → cap/remaining/percent null, consumed still real', async t => {
  const { marketingCenterService } = await loadService(t, {
    accountType: 'PROVIDER_COMPANY', cap: null,
    couponWindow: [redemption(42, THIS_MONTH(2), 'a', 100)]
  });
  const r = await marketingCenterService.getCenter('p1', NOW);
  assert.deepEqual(
    { configured: r.company.spendCap.configured, cap: r.company.spendCap.cap, consumed: r.company.spendCap.consumed, remaining: r.company.spendCap.remaining, percentUsed: r.company.spendCap.percentUsed },
    { configured: false, cap: null, consumed: 42, remaining: null, percentUsed: null }
  );
});

test('updateSpendCap: company can set and clear the cap', async t => {
  const company = await loadService(t, { accountType: 'PROVIDER_COMPANY' });
  assert.deepEqual(await company.marketingCenterService.updateSpendCap('p1', 5000), { cap: 5000, configured: true });
  assert.deepEqual(await company.marketingCenterService.updateSpendCap('p1', null), { cap: null, configured: false });
  assert.equal((company.userUpdate.mock.calls[0].arguments as any)[0].where.id, 'p1');
});

test('updateSpendCap: individual provider is refused', async t => {
  const individual = await loadService(t, { accountType: 'PROVIDER_INDIVIDUAL' });
  await assert.rejects(() => individual.marketingCenterService.updateSpendCap('p1', 5000), { statusCode: 403 });
});
