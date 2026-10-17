import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { globalErrorHandler } from '../middlewares/error.middleware';
import { selfPurchaseError, selfNegotiationError, selfHireError, serviceUnavailableError, assertNoOwnService } from '../utils/self-dealing';
import { liveServices } from './cart-checkout-live.testkit';

// Batch B §8/§9 - mocked unit tests (the real-database proof is pg-self-purchase.pg.test.ts).
const run = (err: any) => { const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } }; globalErrorHandler(err, { method: 'POST', url: '/x' } as any, res, () => {}); return res; };
const mute = (t: TestContext) => t.mock.module('./notification.service', { namedExports: { notificationService: { sendPaymentOtpEmail: async () => {} } } });

test('the error handler forwards the stable self-dealing codes (top level and errors[0].code) with their status', () => {
	for (const [err, status, code] of [[selfPurchaseError('s1'), 403, 'SELF_PURCHASE_FORBIDDEN'], [selfNegotiationError(), 403, 'SELF_NEGOTIATION_FORBIDDEN'], [selfHireError(), 403, 'SELF_HIRE_FORBIDDEN'], [serviceUnavailableError(), 409, 'SERVICE_UNAVAILABLE_FOR_ORDER']] as const) {
		const r = run(err); assert.equal(r.statusCode, status); assert.equal(r.body.code, code); assert.equal(r.body.errors[0].code, code);
	}
});

test('assertNoOwnService compares the real owner user id only', () => {
	assert.doesNotThrow(() => assertNoOwnService('u1', [{ id: 's1', providerId: 'u2' }]));
	assert.throws(() => assertNoOwnService('u1', [{ id: 's1', providerId: 'u2' }, { id: 's2', providerId: 'u1' }]), (e: any) => e.code === 'SELF_PURCHASE_FORBIDDEN' && e.errors[0].serviceId === 's2');
});

test('cart: sync drops the own service with the code and keeps the rest; getCart flags old own rows', async (t) => {
	mute(t);
	let created: any[] = [];
	const row = (id: string, providerId: string) => ({ id: `ci-${id}`, packageName: 'x', addedAt: new Date(), savedForLater: false, service: { id, title: 't', totalAmount: 1, totalDays: 1, aiScore: 0, providerId, specialty: null, provider: { id: providerId, firstName: 'a', lastName: 'b', currentLevel: null, providerProfile: null, gamification: null } } });
	const prismaMock: any = {
		cart: { upsert: async () => ({ id: 'cart-1', items: [row('own', 'u1'), row('other', 'p2')] }) },
		serviceCatalog: { findMany: async () => [{ id: 'own', providerId: 'u1' }, { id: 'other', providerId: 'p2' }] },
		cartItem: { deleteMany: async () => ({}), createMany: async (a: any) => { created = a.data; } },
		$transaction: async (fn: any) => fn(prismaMock)
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const { cartCheckoutService } = await import(`./cart-checkout.service.ts?f=${Date.now()}-${Math.random()}`);
	const out: any = await cartCheckoutService.sync('u1', [{ modelId: 'own' }, { modelId: 'other' }]);
	assert.deepEqual(created.map(c => c.serviceId), ['other']);
	assert.deepEqual(out.rejected, [{ modelId: 'own', code: 'SELF_PURCHASE_FORBIDDEN' }]);
	assert.deepEqual(out.items.map((i: any) => [i.modelId, i.ownService]), [['own', true], ['other', false]]);
});

test('init / resend / confirm: an own service in the order stops BEFORE any OTP write, debit or project (ownership by user id, not activeRole)', async (t) => {
	mute(t);
	const calls: string[] = [];
	const order = { id: 'o1', status: 'PENDING_PAYMENT', total: 20, items: [{ serviceId: 's1', providerId: 'u1' }], user: { email: 'e', phoneNumber: null, walletBalance: 100 } };
	const spy = (n: string) => async () => { calls.push(n); return {}; };
	const prismaMock: any = {
		order: { findFirst: async () => order },
		serviceCatalog: { findMany: liveServices('p2') },
		otpVerification: { findMany: async () => [{ id: 'otp', code: '1', attempts: 0, expiresAt: new Date(Date.now() + 9e4), context: { purpose: 'checkout_payment', orderId: 'o1' } }], deleteMany: spy('otp.deleteMany'), create: spy('otp.create'), update: spy('otp.update'), delete: spy('otp.delete') },
		$transaction: spy('$transaction'), user: { updateMany: spy('debit') }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const { cartCheckoutService: s } = await import(`./cart-checkout.service.ts?f=${Date.now()}-${Math.random()}`);
	for (const call of [() => s.initPayment('u1', 'o1', 'wallet'), () => s.resendPaymentOtp('u1', 'o1'), () => s.confirmPayment('u1', 'o1', '1')]) {
		const e: any = await call().catch((x: any) => x); assert.equal(e.code, 'SELF_PURCHASE_FORBIDDEN'); assert.equal(e.statusCode, 403);
	}
	assert.deepEqual(calls, [], 'no OTP touched, no transaction, no debit');
});

test('init: the live service owned by the user (stale snapshot / alternate id) is refused too; a missing service is SERVICE_UNAVAILABLE_FOR_ORDER', async (t) => {
	mute(t);
	let live: any[] = [{ id: 's1', providerId: 'u1' }];
	const prismaMock: any = { order: { findFirst: async () => ({ id: 'o1', status: 'PENDING_PAYMENT', total: 20, items: [{ serviceId: 's1', providerId: 'p2' }], user: { email: 'e', walletBalance: 100 } }) }, serviceCatalog: { findMany: async () => live } };
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const { cartCheckoutService: s } = await import(`./cart-checkout.service.ts?f=${Date.now()}-${Math.random()}`);
	assert.equal(((await s.initPayment('u1', 'o1', 'wallet').catch((x: any) => x)) as any).code, 'SELF_PURCHASE_FORBIDDEN');
	live = [];
	const e: any = await s.initPayment('u1', 'o1', 'wallet').catch((x: any) => x);
	assert.equal(e.code, 'SERVICE_UNAVAILABLE_FOR_ORDER'); assert.equal(e.statusCode, 409);
});

test('hire paths: selectOffer / signContract / depositEscrow refuse a provider who is the authenticated client (SELF_HIRE_FORBIDDEN)', async (t) => {
	const prismaMock: any = {
		clientRequest: { findFirst: async () => ({ id: 'r1', status: 'OPEN' }) },
		proposal: { findFirst: async () => null },
		projectProposal: { findFirst: async () => ({ id: 'pp1', providerId: 'u1', status: 'SUBMITTED', milestones: [] }) },
		user: { findUnique: async () => ({ id: 'u1', email: 'e@x.y' }) },
		contract: { findFirst: async () => ({ id: 'c1', providerId: 'u1', clientId: 'u1', offerId: 'pp1' }) }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	process.env.OTP_SECRET = process.env.OTP_SECRET || 'test-secret';
	const { clientRequestsService: s } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
	for (const call of [() => s.selectOffer('u1', 'r1', 'pp1'), () => s.signContract('u1', 'r1', 'pp1'), () => s.depositEscrow('u1', 'r1', 'pp1', '123456', 'wallet')]) {
		const e: any = await call().catch((x: any) => x); assert.equal(e.code, 'SELF_HIRE_FORBIDDEN');
	}
});

test('market «طلب تفاوض»: the owner is refused with the code before anything is read or written; no write happens', async (t) => {
	const writes: string[] = [];
	const prismaMock: any = {
		serviceCatalog: { findFirst: async () => ({ id: 's1', providerId: 'u1', title: 't', stages: [], specialty: null }) },
		$transaction: async () => { writes.push('tx'); },
		project: { create: async () => { writes.push('project'); } }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const { MarketplaceService } = await import(`./marketplace-service.service.ts?f=${Date.now()}-${Math.random()}`);
	const e: any = await new MarketplaceService().requestMarketplaceService('u1', 's1', { mode: 'negotiation' }).catch((x: any) => x);
	assert.equal(e.code, 'SELF_NEGOTIATION_FORBIDDEN'); assert.equal(e.statusCode, 403);
	assert.deepEqual(writes, []);
});

test('chat.initiateConversation: the same real user on both ends gets no room (SELF_NEGOTIATION_FORBIDDEN)', async (t) => {
	const db: any = {
		user: { findUnique: async () => ({ id: 'u1', accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT' }) },
		project: { findUnique: async () => ({ id: 'req-1', clientId: 'u1', providerId: null }) },
		clientRequest: { findUnique: async () => ({ id: 'req-1', clientProfile: { userId: 'u1' } }) },
		projectProposal: { findUnique: async () => null, findFirst: async () => ({ id: 'x' }) }, proposal: { findUnique: async () => null, findFirst: async () => null },
		conversation: { create: async () => { throw new Error('must not create'); } }
	};
	t.mock.module('../config/db', { namedExports: { prisma: db } });
	const { chatService } = await import(`./chat.service.ts?f=${Date.now()}-${Math.random()}`);
	const e: any = await chatService.initiateConversation('u1', { projectId: 'req-1', providerId: 'u1' }).catch((x: any) => x);
	assert.equal(e.code, 'SELF_NEGOTIATION_FORBIDDEN');
});
