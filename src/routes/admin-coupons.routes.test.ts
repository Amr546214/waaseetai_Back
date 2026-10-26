import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { fullAccessModels } from '../testing/admin-full-access.testutil';

// Real Express + real authenticate / requireActiveUser / authorize; only the database and the session store are replaced.
process.env.JWT_SECRET = 'admin-coupons-secret';

const acct = (id: string, accountType: string) => ({ id, email: `${id}@x.com`, accountType, status: 'ACTIVE', activeRole: accountType.endsWith('ADMIN') ? accountType : accountType.startsWith('CLIENT') ? 'CLIENT' : 'PROVIDER', roles: [] });
const users: Record<string, any> = {
	admin: acct('admin', 'ADMIN'), sadmin: acct('sadmin', 'SUPER_ADMIN'),
	client: acct('client', 'CLIENT_INDIVIDUAL'), prov: acct('prov', 'PROVIDER_INDIVIDUAL')
};
const future = new Date(Date.now() + 86_400_000);
const mk = (o: any = {}) => ({
	id: 'c1', code: 'SAVE10', providerId: 'prov', discountType: 'percentage', discountValue: 10, minimumAmount: null, maxDiscount: null,
	maxUses: 10, usedCount: 2, maxUsesPerUser: 1, active: true, approvalStatus: 'APPROVED', rejectionReason: null,
	startAt: new Date(0), expiresAt: future, excludedServiceIds: [], internalNote: null, createdAt: new Date(), updatedAt: new Date(),
	provider: { id: 'prov', firstName: 'Sara', lastName: 'K', email: 'p@x.com', accountType: 'PROVIDER_INDIVIDUAL' },
	services: [{ serviceId: 's1', service: { title: 'Logo' } }], ...o
});
let store: any = mk();
const audits: any[] = [];
let lastFindManyWhere: any;

const prisma: any = {
	...fullAccessModels(),
	user: { findUnique: async ({ where }: any) => users[where.id] ?? null },
	coupon: {
		fields: { maxUses: '__maxUses' },
		findMany: async (a: any) => { lastFindManyWhere = a.where; return [store]; },
		count: async () => 1,
		findUnique: async ({ where }: any) => (where.id === store.id ? store : null),
		update: async ({ data }: any) => { store = { ...store, ...data }; return store; }
	},
	order: { groupBy: async () => [{ currency: 'USD', _count: { _all: 2 }, _sum: { discount: 30 } }] },
	couponRedemption: {
		aggregate: async () => ({ _count: { _all: 2 }, _sum: { amount: 30 } }),
		count: async () => 1,
		findMany: async () => [{ id: 'r1', amount: 20, createdAt: new Date(), orderId: 'o1', order: { orderNumber: 'W-1', status: 'PAID', subtotal: 200, total: 180 }, user: { id: 'u9', firstName: 'Ali', lastName: 'M' } }]
	},
	specialOffer: {
		findMany: async () => [{ id: 'o1', type: 'DIRECT_DISCOUNT', name: 'Offer', badgeText: '20%', discountValue: 20, active: true, approvalStatus: 'NONE', usedCount: 0, startAt: new Date(0), expiresAt: null, createdAt: new Date(), provider: store.provider, targetService: { id: 's1', title: 'Logo' } }],
		count: async () => 1,
		findUnique: async ({ where }: any) => (where.id === 'o1' ? { id: 'o1', type: 'DIRECT_DISCOUNT', name: 'Offer', badgeText: '20%', discountValue: 20, active: true, approvalStatus: 'NONE', usedCount: 0, startAt: new Date(0), expiresAt: null, createdAt: new Date(), provider: store.provider } : null)
	},
	specialOfferRedemption: { findMany: async () => [], count: async () => 0 },
	accountAuditLog: { create: async ({ data }: any) => { audits.push(data); return data; } },
	$transaction: async (fn: any) => fn(prisma)
};

let srv: Promise<{ url: string; close: () => void }> | undefined;
function server() {
	srv ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }) } } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const routes = await import('./admin-coupons.routes');
		const app = express();
		app.use(express.json());
		app.use('/admin/coupons', routes.default);
		app.use('/admin/special-offers', routes.adminSpecialOffersRouter);
		app.use(globalErrorHandler);
		const s = http.createServer(app);
		await new Promise<void>(r => s.listen(0, r));
		return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
	})();
	return srv;
}
async function call(as: string | null, method: string, path: string, body?: any) {
	const { url } = await server();
	const headers: any = { 'content-type': 'application/json' };
	if (as) headers.authorization = `Bearer ${jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
	const res = await fetch(`${url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ROUTES: [string, string, any?][] = [
	['GET', '/admin/coupons'], ['GET', '/admin/coupons/c1'], ['PATCH', '/admin/coupons/c1/active', { active: false, reason: 'x' }],
	['GET', '/admin/special-offers'], ['GET', '/admin/special-offers/o1']
];

test('unauthenticated -> 401 on every admin coupon / offer route', async () => {
	for (const [m, p, b] of ROUTES) assert.equal((await call(null, m, p, b)).status, 401, p);
});
test('non-admin accounts (client, provider) -> 403 on every route and nothing is written', async () => {
	for (const who of ['client', 'prov']) for (const [m, p, b] of ROUTES) assert.equal((await call(who, m, p, b)).status, 403, `${who} ${m} ${p}`);
	assert.equal(audits.length, 0);
	assert.equal(store.active, true);
});
test('ADMIN and SUPER_ADMIN can list coupons: real fields, derived status, provider name, services', async () => {
	for (const who of ['admin', 'sadmin']) {
		const r = await call(who, 'GET', '/admin/coupons?status=active&q=sav&providerId=prov');
		assert.equal(r.status, 200);
		const c = r.body.data.items[0];
		assert.equal(c.status, 'active');
		assert.equal(c.provider.name, 'Sara K');
		assert.deepEqual([c.usedCount, c.maxUses], [2, 10]);
		assert.deepEqual(c.services, [{ id: 's1', title: 'Logo' }]);
		assert.deepEqual(r.body.data.summary, { totalRedemptions: 2, totalDiscountGiven: 30, totalDiscountGivenBy: { USD: 30 }, currency: 'USD' });
	}
	const and = JSON.stringify(lastFindManyWhere.AND);
	assert.match(and, /"providerId":"prov"/);
	assert.match(and, /"contains":"sav"/);
});
test('an unknown status filter is a 400', async () => {
	assert.equal((await call('admin', 'GET', '/admin/coupons?status=bogus')).status, 400);
});
test('detail returns the redemptions with the customer, order and discount; missing id -> 404', async () => {
	const r = await call('admin', 'GET', '/admin/coupons/c1');
	assert.equal(r.status, 200);
	assert.equal(r.body.data.redemptions[0].customer.name, 'Ali M');
	assert.equal(r.body.data.redemptions[0].discountApplied, 20);
	assert.equal((await call('admin', 'GET', '/admin/coupons/nope')).status, 404);
});
test('deactivate needs a reason (400), then works, is audited with the reason, and a repeat is 409', async () => {
	assert.equal((await call('admin', 'PATCH', '/admin/coupons/c1/active', { active: false })).status, 400);
	assert.equal((await call('admin', 'PATCH', '/admin/coupons/c1/active', { active: false, reason: '  ' })).status, 400);
	assert.equal(store.active, true);
	const r = await call('admin', 'PATCH', '/admin/coupons/c1/active', { active: false, reason: 'شكوى من سوء استخدام' });
	assert.equal(r.status, 200);
	assert.equal(r.body.data.active, false);
	assert.equal(r.body.data.status, 'inactive');
	assert.equal(audits.length, 1);
	assert.equal(audits[0].eventType, 'COUPON_ADMIN_DEACTIVATED');
	assert.equal(audits[0].metaData.reason, 'شكوى من سوء استخدام');
	assert.equal(audits[0].metaData.adminId, 'admin');
	assert.equal((await call('admin', 'PATCH', '/admin/coupons/c1/active', { active: false, reason: 'again' })).status, 409);
});
test('reactivate works without a reason and is audited', async () => {
	const r = await call('sadmin', 'PATCH', '/admin/coupons/c1/active', { active: true });
	assert.equal(r.status, 200);
	assert.equal(r.body.data.status, 'active');
	assert.equal(audits.at(-1).eventType, 'COUPON_ADMIN_REACTIVATED');
});
test('reactivation never bypasses expiry, exhaustion or pending company approval', async () => {
	const base = store;
	for (const [patch, re] of [
		[{ expiresAt: new Date(Date.now() - 1000) }, /منتهي/],
		[{ maxUses: 2, usedCount: 2 }, /استُنفد/],
		[{ approvalStatus: 'PENDING' }, /موافقة/]
	] as [any, RegExp][]) {
		store = { ...base, active: false, ...patch };
		const r = await call('admin', 'PATCH', '/admin/coupons/c1/active', { active: true });
		assert.equal(r.status, 400);
		assert.match(r.body.message, re);
	}
	store = base;
});
test('an expired coupon that is still flagged active reads "expired"', async () => {
	store = mk({ expiresAt: new Date(Date.now() - 1000) });
	assert.equal((await call('admin', 'GET', '/admin/coupons')).body.data.items[0].status, 'expired');
	store = mk();
});
test('special offers: read-only list + detail, and no write verbs exist', async () => {
	const l = await call('admin', 'GET', '/admin/special-offers');
	assert.equal(l.status, 200);
	assert.equal(l.body.data.items[0].status, 'active');
	assert.equal(l.body.data.items[0].targetService.title, 'Logo');
	assert.equal((await call('admin', 'GET', '/admin/special-offers/o1')).status, 200);
	assert.equal((await call('admin', 'GET', '/admin/special-offers/zzz')).status, 404);
	assert.equal((await call('admin', 'GET', '/admin/special-offers?status=weird')).status, 400);
	assert.equal((await call('admin', 'PATCH', '/admin/special-offers/o1', { active: false })).status, 404);
	assert.equal((await call('admin', 'DELETE', '/admin/special-offers/o1')).status, 404);
});

test.after(async () => { (await server()).close(); });
