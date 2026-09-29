import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaging, weeklyTrend } from './marketing-stats.util';

// Per-tool stats (GET /provider/coupons/:id/stats, GET
// /provider/special-offers/:id/stats) and the offers-list bundle revenue KPI
// (GET /provider/special-offers/summary). Prisma is mocked the same way as
// provider-coupon.service.test.ts (t.mock.module('../config/db', ...)).

const NOW = new Date('2026-09-29T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const user = (id: string, firstName: string) => ({ id, firstName, lastName: 'Test' });

async function load(t: TestContext, file: 'provider-coupon' | 'provider-special-offer', prismaMock: any) {
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  return import(`./${file}.service.ts?fixture=${Date.now()}-${Math.random()}`);
}

// A findMany mock that serves the light "all" query and the paginated
// (skip/take, newest first) query from the same fixture rows, and records
// every `where` it was called with.
function redemptionFindMany(rows: any[], calls: any[]) {
  return async (args: any) => {
    calls.push(args);
    if (args.take === undefined) return rows;
    const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return sorted.slice(args.skip, args.skip + args.take);
  };
}

// --- util -----------------------------------------------------------------

test('util: weeklyTrend buckets the last 6 rolling weeks and ignores older rows', () => {
  const trend = weeklyTrend([
    { amount: 10, createdAt: daysAgo(1) },
    { amount: 5, createdAt: daysAgo(2) },
    { amount: 7, createdAt: daysAgo(8) },
    { amount: 99, createdAt: daysAgo(50) }
  ], NOW);
  assert.equal(trend.length, 6);
  assert.deepEqual(trend.map(w => w.usageCount), [0, 0, 0, 0, 1, 2]);
  assert.equal(trend[5].discountedValue, 15);
  assert.equal(trend[4].discountedValue, 7);
  assert.equal(trend[5].weekEnd.getTime(), NOW.getTime());
});

test('util: parsePaging clamps page/pageSize', () => {
  assert.deepEqual(parsePaging({}), { page: 1, pageSize: 10 });
  assert.deepEqual(parsePaging({ page: '3', pageSize: '500' }), { page: 3, pageSize: 50 });
  assert.deepEqual(parsePaging({ page: '-2', pageSize: 'x' }), { page: 1, pageSize: 10 });
});

// --- coupon getStats --------------------------------------------------------

const couponRows = [
  { id: 'r1', amount: 150, createdAt: daysAgo(2), userId: 'u1', orderId: 'o1', order: { orderNumber: 'ORD-1', status: 'COMPLETED', subtotal: 600, total: 450 }, user: user('u1', 'Nour') },
  { id: 'r2', amount: 125, createdAt: daysAgo(5), userId: 'u2', orderId: 'o2', order: { orderNumber: 'ORD-2', status: 'PAID', subtotal: 500, total: 375 }, user: user('u2', 'Sadeem') },
  { id: 'r3', amount: 100, createdAt: daysAgo(20), userId: 'u1', orderId: 'o3', order: { orderNumber: 'ORD-3', status: 'PAID', subtotal: 400, total: 300 }, user: user('u1', 'Nour') }
];

test('coupon getStats: totals, weekly trend and paginated orders for any owned coupon', async (t) => {
  const calls: any[] = [];
  const { providerCouponService } = await load(t, 'provider-coupon', {
    coupon: { findFirst: async ({ where }: any) => (where.id === 'c1' && where.providerId === 'p1' ? { id: 'c1', maxUses: 50 } : null) },
    couponRedemption: { findMany: redemptionFindMany(couponRows, calls) }
  });

  const stats = await providerCouponService.getStats('p1', 'c1', { page: 1, pageSize: 2 }, NOW);
  assert.equal(stats.totals.usageCount, 3);
  assert.equal(stats.totals.maxUses, 50);
  assert.equal(stats.totals.discountedValue, 375);
  assert.equal(stats.totals.revenue, 1125);
  assert.equal(stats.totals.uniqueCustomers, 2);
  assert.equal(stats.totals.repeatCustomers, 1);
  assert.equal(stats.totals.averageOrderValue, 500);
  assert.equal(stats.totals.lastUsedAt.getTime(), daysAgo(2).getTime());
  assert.equal(stats.weeklyTrend.length, 6);
  assert.equal(stats.weeklyTrend[5].usageCount, 2);

  assert.equal(stats.redemptions.total, 3);
  assert.equal(stats.redemptions.totalPages, 2);
  assert.equal(stats.redemptions.items.length, 2);
  assert.deepEqual(stats.redemptions.items[0], {
    redemptionId: 'r1', orderId: 'o1', orderNumber: 'ORD-1', orderStatus: 'COMPLETED',
    customer: { id: 'u1', name: 'Nour Test' }, orderValue: 600, discountApplied: 150, netValue: 450, createdAt: daysAgo(2)
  });

  // Every redemption query is scoped to this coupon and excludes CANCELLED orders.
  for (const c of calls) {
    assert.equal(c.where.couponId, 'c1');
    assert.deepEqual(c.where.order, { status: { not: 'CANCELLED' } });
  }
});

test('coupon getStats: a coupon of another provider (or unknown id) is 404', async (t) => {
  const { providerCouponService } = await load(t, 'provider-coupon', {
    coupon: { findFirst: async () => null },
    couponRedemption: { findMany: async () => { throw new Error('must not query redemptions'); } }
  });
  await assert.rejects(providerCouponService.getStats('p1', 'foreign'), (e: any) => e.statusCode === 404);
});

test('coupon getStats: unused coupon returns zeros and null averages', async (t) => {
  const { providerCouponService } = await load(t, 'provider-coupon', {
    coupon: { findFirst: async () => ({ id: 'c1', maxUses: null }) },
    couponRedemption: { findMany: async () => [] }
  });
  const stats = await providerCouponService.getStats('p1', 'c1', { page: 1, pageSize: 10 }, NOW);
  assert.equal(stats.totals.usageCount, 0);
  assert.equal(stats.totals.averageOrderValue, null);
  assert.equal(stats.totals.lastUsedAt, null);
  assert.equal(stats.redemptions.total, 0);
  assert.equal(stats.redemptions.totalPages, 1);
});

// --- special offer getStats -------------------------------------------------

const bundleOffer = {
  id: 'b1', type: 'BUNDLE', primaryServiceId: 'svc-x', beneficiaryServiceId: 'svc-y', targetServiceId: null,
  validityDays: 14, startAt: daysAgo(60), expiresAt: null
};
const offerRows = [
  { id: 'sr1', amount: 300, createdAt: daysAgo(3), userId: 'u1', orderId: 'o1', order: { orderNumber: 'ORD-1', status: 'PAID', subtotal: 1500, total: 1200, items: [{ serviceId: 'svc-y', title: 'Website', price: 1500 }] }, user: user('u1', 'A') },
  // u2 redeemed 30 days after their first X order — outside the 14-day window.
  { id: 'sr2', amount: 260, createdAt: daysAgo(10), userId: 'u2', orderId: 'o2', order: { orderNumber: 'ORD-2', status: 'PAID', subtotal: 1300, total: 1040, items: [{ serviceId: 'svc-y', title: 'Website', price: 1300 }] }, user: user('u2', 'B') }
];

test('offer getStats (BUNDLE): totals, discounted-model revenue and conversion within validityDays', async (t) => {
  const calls: any[] = [];
  const orderItemCalls: any[] = [];
  const { providerSpecialOfferService } = await load(t, 'provider-special-offer', {
    specialOffer: { findFirst: async ({ where }: any) => (where.id === 'b1' && where.providerId === 'p1' ? bundleOffer : null) },
    specialOfferRedemption: { findMany: redemptionFindMany(offerRows, calls) },
    orderItem: {
      findMany: async (args: any) => {
        orderItemCalls.push(args);
        return [
          { order: { userId: 'u1', createdAt: daysAgo(8) } },   // first X 8d ago, redeemed 3d ago → converted
          { order: { userId: 'u1', createdAt: daysAgo(4) } },
          { order: { userId: 'u2', createdAt: daysAgo(40) } },  // redeemed 30d later → not converted
          { order: { userId: 'u3', createdAt: daysAgo(6) } },   // never redeemed
          { order: { userId: 'u4', createdAt: daysAgo(2) } }
        ];
      }
    }
  });

  const stats = await providerSpecialOfferService.getStats('p1', 'b1', { page: 1, pageSize: 10 }, NOW);
  assert.equal(stats.type, 'BUNDLE');
  assert.equal(stats.totals.usageCount, 2);
  assert.equal(stats.totals.discountedValue, 560);
  assert.equal(stats.totals.revenue, 2240);
  assert.equal(stats.totals.discountedServiceRevenue, 2800);
  assert.equal(stats.totals.uniqueCustomers, 2);
  assert.equal(stats.redemptions.items[0].discountedItem.title, 'Website');
  assert.equal(stats.redemptions.items[0].orderNumber, 'ORD-1');

  assert.deepEqual(stats.bundle, {
    primaryServiceId: 'svc-x', validityDays: 14, primaryCustomers: 4, convertedCustomers: 1, conversionRate: 25
  });

  // Primary-model orders are looked up only for X, non-cancelled, since the offer started.
  assert.equal(orderItemCalls[0].where.serviceId, 'svc-x');
  assert.deepEqual(orderItemCalls[0].where.order.status, { not: 'CANCELLED' });
  assert.equal(orderItemCalls[0].where.order.createdAt.gte.getTime(), bundleOffer.startAt.getTime());
  // Redemption lookups are scoped to this offer and to the beneficiary line item.
  for (const c of calls) {
    assert.equal(c.where.offerId, 'b1');
    assert.equal(c.select.order.select.items.where.serviceId, 'svc-y');
  }
});

test('offer getStats (DIRECT_DISCOUNT): no bundle block, target model is the discounted item', async (t) => {
  const calls: any[] = [];
  const { providerSpecialOfferService } = await load(t, 'provider-special-offer', {
    specialOffer: { findFirst: async () => ({ ...bundleOffer, id: 'd1', type: 'DIRECT_DISCOUNT', primaryServiceId: null, beneficiaryServiceId: null, targetServiceId: 'svc-z', validityDays: null }) },
    specialOfferRedemption: { findMany: redemptionFindMany([], calls) },
    orderItem: { findMany: async () => { throw new Error('conversion is bundle-only'); } }
  });
  const stats = await providerSpecialOfferService.getStats('p1', 'd1', { page: 1, pageSize: 10 }, NOW);
  assert.equal(stats.bundle, null);
  assert.equal(stats.totals.usageCount, 0);
  assert.equal(calls[0].select.order.select.items.where.serviceId, 'svc-z');
});

test('offer getStats: an offer of another provider is 404', async (t) => {
  const { providerSpecialOfferService } = await load(t, 'provider-special-offer', {
    specialOffer: { findFirst: async () => null }
  });
  await assert.rejects(providerSpecialOfferService.getStats('p1', 'foreign'), (e: any) => e.statusCode === 404);
});

// --- offers list KPI: bundle extra revenue -----------------------------------

test('offer getSummary: bundle extra revenue sums distinct order totals of BUNDLE redemptions only', async (t) => {
  let where: any;
  const { providerSpecialOfferService } = await load(t, 'provider-special-offer', {
    specialOfferRedemption: {
      findMany: async (args: any) => {
        where = args.where;
        return [
          { orderId: 'o1', order: { total: 1200 } },
          { orderId: 'o1', order: { total: 1200 } }, // same order, two bundle redemptions → counted once
          { orderId: 'o2', order: { total: 1040.5 } }
        ];
      }
    }
  });
  const summary = await providerSpecialOfferService.getSummary('p1');
  assert.deepEqual(summary, { bundleExtraRevenue: 2240.5, bundleOrders: 2, bundleRedemptions: 3 });
  assert.deepEqual(where.offer, { providerId: 'p1', type: 'BUNDLE' });
  assert.deepEqual(where.order, { status: { not: 'CANCELLED' } });
});
