import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Coupons come ONLY from the server: validateCoupon prices the discount from the services' stored amounts (never from what the page sends) and refuses
// an unknown / inactive / expired / exhausted / already-used code or one whose conditions the cart does not meet.
const COUPON = (o: any = {}) => ({ id: 'c1', code: 'SAVE10', active: true, startAt: new Date(0), expiresAt: null, maxUses: null, usedCount: 0, maxUsesPerUser: 1, minimumAmount: null, maxDiscount: null, discountType: 'percentage', discountValue: 10, excludedServiceIds: [], services: [], ...o });

async function load(t: TestContext, o: { coupon?: any; uses?: number; services?: any[] } = {}) {
	const lookups: any[] = [];
	t.mock.module('../config/db', { namedExports: { prisma: {
		coupon: { findFirst: async (a: any) => { lookups.push(a); return o.coupon === undefined ? null : o.coupon; } },
		couponRedemption: { count: async () => o.uses ?? 0 },
		serviceCatalog: { findMany: async () => o.services ?? [{ id: 's1', totalAmount: 200 }] }
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { sendPaymentOtpEmail: async () => {} } } });
	const { cartCheckoutService } = await import(`./cart-checkout.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { svc: cartCheckoutService, lookups };
}
// the page sends a (possibly forged) totalAmount: the server ignores it
const input = (code = 'save10') => ({ code, items: [{ modelId: 's1', totalAmount: 1 }] });
const refused = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: any) => e.statusCode === 400 && re.test(e.message));

test('valid coupon: the discount is 10% of the SERVER price (200 -> 20), not of the amount the page sent; the code is looked up upper-cased', async t => {
	const { svc, lookups } = await load(t, { coupon: COUPON() });
	const r = await svc.validateCoupon('u1', input());
	assert.deepEqual([r.code, r.discountAmount, r.discountType, r.discountValue], ['SAVE10', 20, 'percentage', 10]);
	assert.equal(lookups[0].where.code, 'SAVE10');
});
test('a fixed coupon is capped by the cart total', async t => {
	const { svc } = await load(t, { coupon: COUPON({ discountType: 'fixed', discountValue: 500 }) });
	assert.equal((await svc.validateCoupon('u1', input())).discountAmount, 200);
});
test('maxDiscount caps a percentage coupon', async t => {
	const { svc } = await load(t, { coupon: COUPON({ maxDiscount: 15 }) });
	assert.equal((await svc.validateCoupon('u1', input())).discountAmount, 15);
});
test('unknown / inactive code is refused (nothing is invented for a guest or a typo)', async t => {
	const { svc } = await load(t, { coupon: null });
	await refused(svc.validateCoupon('u1', input('NOPE')), /كوبون غير صالح/);
});
test('an expired coupon is refused', async t => {
	const { svc } = await load(t, { coupon: COUPON({ expiresAt: new Date(Date.now() - 1000) }) });
	await refused(svc.validateCoupon('u1', input()), /كوبون غير صالح/);
});
test('a coupon that has not started yet is refused', async t => {
	const { svc } = await load(t, { coupon: COUPON({ startAt: new Date(Date.now() + 86_400_000) }) });
	await refused(svc.validateCoupon('u1', input()), /كوبون غير صالح/);
});
test('an exhausted coupon is refused', async t => {
	const { svc } = await load(t, { coupon: COUPON({ maxUses: 5, usedCount: 5 }) });
	await refused(svc.validateCoupon('u1', input()), /كوبون غير صالح/);
});
test('a coupon the client already used is refused', async t => {
	const { svc } = await load(t, { coupon: COUPON(), uses: 1 });
	await refused(svc.validateCoupon('u1', input()), /استعملت هذا الكوبون/);
});
test('the minimum amount of the coupon is enforced on the server price', async t => {
	const { svc } = await load(t, { coupon: COUPON({ minimumAmount: 500 }) });
	await refused(svc.validateCoupon('u1', input()), /لا تستوفي شروط الكوبون/);
});

// restricted services: only the coupon's own services take the discount; a cart with none of them is refused
test('a coupon restricted to s1 discounts only s1 (200 of 300 -> 20), the other service is untouched', async t => {
	const { svc } = await load(t, { coupon: COUPON({ services: [{ serviceId: 's1' }] }), services: [{ id: 's1', totalAmount: 200 }, { id: 's2', totalAmount: 100 }] });
	const r = await svc.validateCoupon('u1', { code: 'save10', items: [{ modelId: 's1', totalAmount: 1 }, { modelId: 's2', totalAmount: 1 }] });
	assert.equal(r.discountAmount, 20);
});
test('a coupon restricted to other services is refused for a cart without them', async t => {
	const { svc } = await load(t, { coupon: COUPON({ services: [{ serviceId: 'other' }] }) });
	await refused(svc.validateCoupon('u1', input()), /لا تستوفي شروط الكوبون/);
});
test('an excluded service is not discounted: the cart of only that service is refused', async t => {
	const { svc } = await load(t, { coupon: COUPON({ excludedServiceIds: ['s1'] }) });
	await refused(svc.validateCoupon('u1', input()), /لا تستوفي شروط الكوبون/);
});
