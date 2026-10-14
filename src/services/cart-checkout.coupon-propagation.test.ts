import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// A provider coupon discounts the SERVICE VALUE: the contract price, the escrow and the stage amounts are the NET (what the client paid), so the platform commission and
// the provider's release are computed on it. The order's `discount` is spread over its items with the same eligibility the coupon was priced with.

function setup(t: TestContext, opts: { order: any; coupon?: any; stages?: any[]; walletBalance?: number }) {
  const users: any[] = [{ id: 'user-1', walletBalance: opts.walletBalance ?? 1000 }];
  const rec = { wallet: [] as any[], projects: [] as any[], contracts: [] as any[], escrows: [] as any[], stagesMany: [] as any[], stageOne: [] as any[], redemptions: [] as any[] };
  let paid = false;
  const tx = {
    user: {
      updateMany: async (a: any) => { const m = users.filter(u => u.id === a.where.id && u.walletBalance >= a.where.walletBalance.gte); m.forEach(u => { u.walletBalance -= a.data.walletBalance.decrement; }); return { count: m.length }; },
      findUnique: async (a: any) => users.find(u => u.id === a.where.id) ?? null
    },
    walletTransaction: { create: async (a: any) => { rec.wallet.push(a.data); return a.data; } },
    coupon: { findUnique: async () => opts.coupon ?? null, updateMany: async () => ({ count: 1 }) },
    couponRedemption: { count: async () => 0, create: async (a: any) => { rec.redemptions.push(a.data); return a.data; } },
    contract: { create: async (a: any) => { rec.contracts.push(a.data); return { id: `contract-${rec.contracts.length}`, ...a.data }; } },
    providerGamification: { findUnique: async () => null },
    escrow: { create: async (a: any) => { rec.escrows.push(a.data); return a.data; } },
    projectStage: { create: async (a: any) => { rec.stageOne.push(a.data); return a.data; }, createMany: async (a: any) => { rec.stagesMany.push(a.data); return {}; } },
    order: { updateMany: async () => { if (paid) return { count: 0 }; paid = true; return { count: 1 }; } },
    project: { create: async (a: any) => { rec.projects.push(a.data); return { id: `project-${rec.projects.length}`, ...a.data }; }, findMany: async () => [] },
    cartItem: { deleteMany: async () => ({ count: 1 }) },
    otpVerification: { delete: async () => ({}) }
  };
  const prismaMock: any = {
    order: { findFirst: async () => opts.order },
    otpVerification: { findMany: async () => [{ id: 'otp-1', code: '111111', expiresAt: new Date(Date.now() + 60_000), context: { purpose: 'checkout_payment', orderId: opts.order.id, paymentReference: 'PAY-X', paymentMethod: 'wallet' } }], update: async () => ({}) },
    serviceStage: { findMany: async () => opts.stages || [] },
    serviceCatalog: { findMany: async () => [] },
    $transaction: async (fn: any) => { const snap = users.map(u => ({ ...u })); const wasPaid = paid; try { return await fn(tx); } catch (e) { users.length = 0; users.push(...snap); paid = wasPaid; throw e; } }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { sendPaymentOtpEmail: async () => {} } } });
  return { users, rec };
}
async function load(t: TestContext, opts: Parameters<typeof setup>[1]) {
  const mocks = setup(t, opts);
  const { cartCheckoutService } = await import(`./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { svc: cartCheckoutService, ...mocks };
}
const item = (id: string, serviceId: string, price: number) => ({ id, serviceId, providerId: 'provider-1', title: `Service ${serviceId}`, price, deliveryDays: 5, aiScore: 0 });
const order = (o: any = {}) => ({ id: 'order-1', orderNumber: 'WS-2026-000001', status: 'PENDING_PAYMENT', total: 18, discount: 2, couponId: 'coupon-1', couponCode: 'QAC2TEN', items: [item('i1', 'svc-1', 20)], ...o });
const COUPON = (o: any = {}) => ({ id: 'coupon-1', code: 'QAC2TEN', active: true, startAt: new Date(0), expiresAt: null, maxUses: 1, maxUsesPerUser: 1, excludedServiceIds: [], services: [{ serviceId: 'svc-1' }], ...o });

test('20 service + 2 coupon: the client is debited 18 and the project / contract / escrow / stage are all 18 (not 20)', async (t) => {
  const { svc, users, rec } = await load(t, { order: order(), coupon: COUPON() });
  await svc.confirmPayment('user-1', 'order-1', '111111');
  assert.equal(users[0].walletBalance, 982);
  assert.equal(rec.wallet[0].amount, -18);
  assert.equal(rec.projects[0].budgetFixed, 18);
  assert.equal(rec.contracts[0].price, 18);
  assert.equal(rec.escrows[0].amount, 18);
  assert.equal(rec.stageOne[0].amount, 18); // service without stage templates: the single stage carries the net
  assert.equal(rec.redemptions[0].amount, 2);
});

test('the contract remembers the service value + discount + code (so the invoice can show them)', async (t) => {
  const { svc, rec } = await load(t, { order: order(), coupon: COUPON() });
  await svc.confirmPayment('user-1', 'order-1', '111111');
  assert.deepEqual(rec.contracts[0].terms, { source: 'marketplace_order', orderId: 'order-1', orderNumber: 'WS-2026-000001', couponCode: 'QAC2TEN', listPrice: 20, discount: 2, netPrice: 18 });
});

test('stage templates are scaled to the net and add up to it exactly (12 + 8 -> 10.8 + 7.2)', async (t) => {
  const stages = [{ serviceId: 'svc-1', stepOrder: 1, title: 'a', description: null, deliveryDays: 2, percentage: 60, computedAmount: 12 }, { serviceId: 'svc-1', stepOrder: 2, title: 'b', description: null, deliveryDays: 3, percentage: 40, computedAmount: 8 }];
  const { svc, rec } = await load(t, { order: order(), coupon: COUPON(), stages });
  await svc.confirmPayment('user-1', 'order-1', '111111');
  assert.deepEqual(rec.stagesMany[0].map((s: any) => s.amount), [10.8, 7.2]);
  assert.deepEqual(rec.stagesMany[0].map((s: any) => s.percentage), [60, 40]); // percentages are unchanged
  assert.equal(rec.escrows[0].amount, 18);
});

test('NO coupon: everything stays exactly as before (full price, stage amounts as published, no terms written)', async (t) => {
  const stages = [{ serviceId: 'svc-1', stepOrder: 1, title: 'a', description: null, deliveryDays: 2, percentage: 60, computedAmount: 12 }, { serviceId: 'svc-1', stepOrder: 2, title: 'b', description: null, deliveryDays: 3, percentage: 40, computedAmount: 8 }];
  const { svc, rec } = await load(t, { order: order({ total: 20, discount: 0, couponId: null, couponCode: null }), stages });
  await svc.confirmPayment('user-1', 'order-1', '111111');
  assert.equal(rec.contracts[0].price, 20); assert.equal(rec.escrows[0].amount, 20); assert.equal(rec.projects[0].budgetFixed, 20);
  assert.deepEqual(rec.stagesMany[0].map((s: any) => s.amount), [12, 8]);
  assert.equal('terms' in rec.contracts[0], false);
  assert.equal(rec.redemptions.length, 0);
});

test('two items, coupon on ONE of them: only that item\'s contract/escrow is discounted; the wallet debit = the order total = the sum of the nets', async (t) => {
  const o = order({ total: 140, discount: 10, items: [item('i1', 'svc-1', 100), item('i2', 'svc-2', 50)] });
  const { svc, users, rec } = await load(t, { order: o, coupon: COUPON() });
  await svc.confirmPayment('user-1', 'order-1', '111111');
  assert.deepEqual(rec.contracts.map(c => c.price), [90, 50]);
  assert.deepEqual(rec.escrows.map(e => e.amount), [90, 50]);
  assert.equal(users[0].walletBalance, 860);
  assert.equal('terms' in rec.contracts[1], false);
});

test('the coupon\'s excluded services never take the discount', async (t) => {
  const o = order({ total: 190, discount: 10, items: [item('i1', 'svc-1', 100), item('i2', 'svc-2', 100)] });
  const { svc, rec } = await load(t, { order: o, coupon: COUPON({ services: [], excludedServiceIds: ['svc-2'] }) });
  await svc.confirmPayment('user-1', 'order-1', '111111');
  assert.deepEqual(rec.contracts.map(c => c.price), [90, 100]);
});

test('an order whose total does not match price - discount is refused as a whole: nothing created, wallet untouched', async (t) => {
  const { svc, users, rec } = await load(t, { order: order({ total: 20 }), coupon: COUPON() }); // total says 20 but price 20 - discount 2 = 18
  const err: any = await svc.confirmPayment('user-1', 'order-1', '111111').catch((e: any) => e);
  assert.equal(err.statusCode, 500);
  assert.equal(users[0].walletBalance, 1000);
  assert.deepEqual([rec.projects.length, rec.contracts.length, rec.escrows.length], [0, 0, 0]);
});
