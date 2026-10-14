import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NEG_PREFIX, buildProviderEntry } from '../utils/offer-negotiation';

const clientCard = (o: object) => NEG_PREFIX + JSON.stringify({ isNegotiation: true, negType: 'price', negTypeName: 'السعر', status: 'PENDING', notes: '', ...o });
let sec = 0;
const msg = (id: string, senderId: string, content: string) => ({ id, senderId, content, createdAt: new Date(2026, 0, 1, 0, 0, ++sec) });
const counterMsg = (id: string, price: number, days: number) => msg(id, 'prov-1', buildProviderEntry('PROVIDER_COUNTER', { offerId: 'offer-1', price, deliveryDays: days, notes: 'ok' }));

type Fx = {
	request: { id: string; title: string; status: string; owner: string };
	offer: { id: string; projectId: string; providerId: string; status: string; totalPrice: number; deliveryDays: number; milestones: any[] };
	mirrors: { id: string; status: string; price?: number; deliveryDays?: number }[];
	messages: any[];
	notifications: any[];
	lockCount?: number;
};
const base = (over: Partial<Fx> = {}): Fx => ({
	request: { id: 'req-1', title: 'تصميم هوية', status: 'OPEN', owner: 'client-1' },
	offer: {
		id: 'offer-1', projectId: 'req-1', providerId: 'prov-1', status: 'UNDER_NEGOTIATION', totalPrice: 1000, deliveryDays: 10,
		milestones: [{ id: 'm1', stepOrder: 1, days: 4, percentage: 40, amount: 400 }, { id: 'm2', stepOrder: 2, days: 6, percentage: 60, amount: 600 }]
	},
	mirrors: [{ id: 'legacy-1', status: 'UNDER_NEGOTIATION', price: 1000, deliveryDays: 10 }],
	messages: [msg('req-msg', 'client-1', clientCard({ price: '800' })), counterMsg('ctr-1', 900, 5)],
	notifications: [],
	...over
});

const perTest = new WeakMap<object, { holder: { db: any }; svc: any }>();

async function load(t: TestContext, fx: Fx) {
	const created: any[] = [];
	const clone = () => JSON.parse(JSON.stringify({ offer: fx.offer, mirrors: fx.mirrors, messages: fx.messages, notifications: fx.notifications }));
	const db: any = {
		clientRequest: {
			findFirst: async ({ where }: any) => (where.id === fx.request.id && where.clientProfile.userId === fx.request.owner ? { id: fx.request.id, title: fx.request.title, status: fx.request.status } : null),
			updateMany: async ({ where }: any) => ({ count: where.id === fx.request.id && where.status === fx.request.status && fx.lockCount !== 0 ? 1 : 0 })
		},
		proposal: {
			findFirst: async ({ where }: any) => (fx.mirrors.some(m => m.id === where.id) ? { providerId: 'prov-1' } : null),
			findMany: async () => fx.mirrors.map((m) => ({ ...m })),
			updateMany: async ({ where, data }: any) => { for (const m of fx.mirrors) if (where.id.in.includes(m.id)) Object.assign(m, data); return { count: fx.mirrors.length }; }
		},
		projectProposal: {
			findFirst: async ({ where }: any) => {
				const o = fx.offer;
				const hit = where.id ? where.id === o.id : (where.projectId === o.projectId && where.providerId === o.providerId);
				return hit ? JSON.parse(JSON.stringify(o)) : null;
			},
			updateMany: async ({ where }: any) => (where.id === fx.offer.id && where.status === fx.offer.status && fx.lockCount !== 0 ? { count: 1 } : { count: 0 }),
			update: async ({ data }: any) => { Object.assign(fx.offer, data); return fx.offer; }
		},
		proposalMilestone: { update: async ({ where, data }: any) => { Object.assign(fx.offer.milestones.find((m: any) => m.id === where.id), data); } },
		conversation: { findUnique: async () => ({ id: 'conv-1' }) },
		message: {
			findMany: async ({ where, take }: any) => fx.messages.filter((m) => m.content?.startsWith(where.content.startsWith)).sort((a, b) => b.createdAt - a.createdAt).slice(0, take)
				.map((m) => ({ ...m, conversation: { providerId: 'prov-1' } })),
			create: async ({ data }: any) => { const row = { id: `new-${fx.messages.length + 1}`, createdAt: new Date(2026, 0, 1, 0, 0, ++sec), ...data }; fx.messages.push(row); created.push(row); return row; }
		},
		notification: { create: async ({ data }: any) => { fx.notifications.push(data); return data; } },
		$transaction: async (fn: any) => {
			const snap = clone();
			try { return await fn(db); } catch (e) { Object.assign(fx.offer, snap.offer); fx.mirrors.splice(0, fx.mirrors.length, ...snap.mirrors); fx.messages.splice(snap.messages.length); fx.notifications.splice(snap.notifications.length); throw e; }
		}
	};
	let cached = perTest.get(t);
	if (!cached) {
		const holder = { db: db as any };
		t.mock.module('../config/db', { namedExports: { prisma: new Proxy({}, { get: (_o, k) => holder.db[k as string] }) } });
		t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { counterAccepted: async () => undefined }, PROVIDER_ROUTES: {} } });
		const { clientOfferCounterService } = await import(`./client-offer-counter.service.ts?fx=${Date.now()}-${Math.random()}`);
		cached = { holder, svc: clientOfferCounterService };
		perTest.set(t, cached);
	}
	cached.holder.db = db;
	return { svc: cached.svc, fx, created };
}
const refused = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => e.statusCode === status && (!re || re.test(e.message)));

test('decline counter: the offer keeps its ORIGINAL terms, goes back to SUBMITTED, the provider is told', async (t) => {
	const { svc, fx, created } = await load(t, base());
	const out = await svc.decline('client-1', 'req-1', 'offer-1', { messageId: 'ctr-1' });
	assert.deepEqual(out, { offerId: 'offer-1', status: 'SUBMITTED' });
	assert.equal(fx.offer.totalPrice, 1000);
	assert.equal(fx.offer.deliveryDays, 10);
	assert.equal(fx.offer.status, 'SUBMITTED');
	assert.equal(fx.mirrors[0].status, 'SUBMITTED');
	assert.match(created[0].content, /CLIENT_DECLINE_COUNTER/);
	assert.equal(fx.notifications[0].type, 'OFFER_COUNTER_DECLINED');
	await refused(svc.decline('client-1', 'req-1', 'offer-1', { messageId: 'ctr-1' }), 409);
});

test('decline counter: only the NEWEST counter; a stale one is 409; missing id 400; not the owner 404; lost race rolls back', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [msg('req-msg', 'client-1', clientCard({ price: '800' })), counterMsg('ctr-1', 900, 5), msg('req-2', 'client-1', clientCard({ price: '850' })), counterMsg('ctr-2', 950, 8)] }));
	await refused(svc.decline('client-1', 'req-1', 'offer-1', { messageId: 'ctr-1' }), 409, /لم يعد الأحدث/);
	await refused(svc.decline('client-1', 'req-1', 'offer-1', {}), 400);
	await refused(svc.decline('someone-else', 'req-1', 'offer-1', { messageId: 'ctr-2' }), 404);
	fx.lockCount = 0;
	await refused(svc.decline('client-1', 'req-1', 'offer-1', { messageId: 'ctr-2' }), 409);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
});

for (const requestStatus of ['CANCELLED', 'IN_PROGRESS', 'COMPLETED']) {
	test(`decline counter is refused (409) when the request is ${requestStatus}`, async (t) => {
		const { svc, fx } = await load(t, base({ request: { ...base().request, status: requestStatus } }));
		await refused(svc.decline('client-1', 'req-1', 'offer-1', { messageId: 'ctr-1' }), 409);
		assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
	});
}
for (const offerStatus of ['CANCELLED', 'SUBMITTED', 'PENDING_SIGNATURE']) {
	test(`decline counter is refused (409) when the offer is ${offerStatus}`, async (t) => {
		const { svc, fx } = await load(t, base({ offer: { ...base().offer, status: offerStatus }, mirrors: [{ id: 'legacy-1', status: offerStatus }] }));
		await refused(svc.decline('client-1', 'req-1', 'offer-1', { messageId: 'ctr-1' }), 409);
		assert.equal(fx.offer.status, offerStatus);
	});
}

test('viewsForRequest: counter pending / request sent / none, per provider', async (t) => {
	const { svc } = await load(t, base());
	const v = await svc.viewsForRequest('req-1', new Map([['prov-1', 'offer-1']]));
	assert.equal(v.get('prov-1').state, 'COUNTER_PENDING');
	assert.equal(v.get('prov-1').counter.messageId, 'ctr-1');
	assert.equal(v.get('prov-1').counter.price, 900);
	const { svc: svc2 } = await load(t, base({ messages: [msg('r', 'client-1', clientCard({ price: '800' }))] }));
	assert.equal((await svc2.viewsForRequest('req-1', new Map([['prov-1', 'offer-1']]))).get('prov-1').state, 'REQUEST_SENT');
	const { svc: svc3 } = await load(t, base({ messages: [] }));
	assert.equal((await svc3.viewsForRequest('req-1', new Map([['prov-1', 'offer-1']]))).get('prov-1').state, 'NONE');
});
