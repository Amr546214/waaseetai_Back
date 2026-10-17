import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NEG_PREFIX, buildProviderEntry, deriveNegotiationState, readNegotiationEntries } from '../utils/offer-negotiation';

const clientCard = (o: object) => NEG_PREFIX + JSON.stringify({ isNegotiation: true, negType: 'price', negTypeName: 'السعر', status: 'PENDING', notes: '', ...o });
let sec = 0;
const msg = (id: string, senderId: string, content: string) => ({ id, senderId, content, createdAt: new Date(2026, 0, 1, 0, 0, ++sec) });

type Fx = {
	request: null | { id: string; title: string; status: string; ownerUserId: string };
	offer: { id: string; projectId: string; providerId: string; status: string; totalPrice: number; deliveryDays: number; milestones: { id: string; stepOrder: number; days: number; amount: number; percentage: number }[] };
	mirrors: { id: string; status: string; price: number; deliveryDays: number }[];
	contract: null | { status: string };
	conversation: null | { id: string };
	messages: any[];
	notified: any[];
	failMilestoneUpdate?: boolean;
	notifyThrows?: boolean;
};
const base = (over: Partial<Fx> = {}): Fx => ({
	request: { id: 'req-1', title: 'تصميم هوية', status: 'OPEN', ownerUserId: 'client-1' },
	offer: {
		id: 'offer-1', projectId: 'req-1', providerId: 'prov-1', status: 'UNDER_NEGOTIATION', totalPrice: 950, deliveryDays: 20,
		milestones: [
			{ id: 'm1', stepOrder: 1, days: 5, amount: 285, percentage: 30 },
			{ id: 'm2', stepOrder: 2, days: 10, amount: 475, percentage: 50 },
			{ id: 'm3', stepOrder: 3, days: 5, amount: 190, percentage: 20 }
		]
	},
	mirrors: [{ id: 'legacy-1', status: 'UNDER_NEGOTIATION', price: 950, deliveryDays: 20 }],
	contract: null,
	conversation: { id: 'conv-1' },
	messages: [],
	notified: [],
	...over
});

const perTest = new WeakMap<object, { holder: { db: any; notify: any }; svc: any }>();

async function load(t: TestContext, fx: Fx) {
	const inSet = (cond: any, v: string) => (cond && typeof cond === 'object' && cond.in ? cond.in.includes(v) : cond === v);
	const clone = () => JSON.parse(JSON.stringify({ offer: fx.offer, mirrors: fx.mirrors, messages: fx.messages }));
	const db: any = {
		clientRequest: { findFirst: async ({ where }: any) => (fx.request && where.id === fx.request.id && where.clientProfile.userId === fx.request.ownerUserId ? { ...fx.request } : null) },
		proposal: {
			findFirst: async ({ where }: any) => { const m = fx.mirrors.find((x) => x.id === where.id); return m ? { id: m.id, providerId: fx.offer.providerId } : null; },
			findMany: async () => fx.mirrors.map((m) => ({ id: m.id, status: m.status })),
			updateMany: async ({ where, data }: any) => { for (const m of fx.mirrors) if (where.id.in.includes(m.id)) Object.assign(m, data); return { count: fx.mirrors.length }; }
		},
		projectProposal: {
			findFirst: async ({ where }: any) => {
				const o = fx.offer;
				const hit = where.id ? where.id === o.id && where.projectId === o.projectId : where.projectId === o.projectId && where.providerId === o.providerId;
				return hit ? JSON.parse(JSON.stringify(o)) : null;
			},
			updateMany: async ({ where, data }: any) => {
				if (where.id !== fx.offer.id || !inSet(where.status, fx.offer.status)) return { count: 0 };
				Object.assign(fx.offer, data);
				return { count: 1 };
			}
		},
		proposalMilestone: {
			update: async ({ where, data }: any) => {
				if (fx.failMilestoneUpdate) throw new Error('db down');
				Object.assign(fx.offer.milestones.find((m) => m.id === where.id)!, data);
			}
		},
		contract: { findUnique: async () => fx.contract },
		conversation: { findUnique: async () => fx.conversation },
		message: {
			findMany: async ({ where, take }: any) => fx.messages.filter((m) => m.content?.startsWith(where.content.startsWith)).sort((a, b) => b.createdAt - a.createdAt).slice(0, take),
			findFirst: async ({ where }: any) => fx.messages.find((m) => m.id === where.id) || null,
			create: async ({ data }: any) => { const row = { id: `new-${fx.messages.length + 1}`, createdAt: new Date(2026, 0, 1, 0, 0, ++sec), ...data }; fx.messages.push(row); return row; }
		},
		$transaction: async (fn: any) => {
			const snap = clone();
			try { return await fn(db); } catch (e) { Object.assign(fx.offer, snap.offer); fx.mirrors.splice(0, fx.mirrors.length, ...snap.mirrors); fx.messages.splice(snap.messages.length); throw e; }
		}
	};
	const notify = async (p: any) => { if (fx.notifyThrows) { /* the real helper swallows errors; model that */ } fx.notified.push(p); };
	let cached = perTest.get(t);
	if (!cached) {
		const holder = { db: db as any, notify };
		t.mock.module('../config/db', { namedExports: { prisma: new Proxy({}, { get: (_o, k) => holder.db[k as string] }) } });
		t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { counterAccepted: (p: any) => holder.notify(p) }, PROVIDER_ROUTES: {} } });
		const { clientOfferCounterService } = await import(`./client-offer-counter.service.ts?fx=${Date.now()}-${Math.random()}`);
		cached = { holder, svc: clientOfferCounterService };
		perTest.set(t, cached);
	}
	cached.holder.db = db;
	cached.holder.notify = notify;
	return { svc: cached.svc, fx };
}
const refused = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => e.statusCode === status && (!re || re.test(e.message)));
const REQ = () => msg('req-msg', 'client-1', clientCard({ price: '800' }));
const COUNTER = (id = 'counter-1', price = 880, days = 18) => msg(id, 'prov-1', buildProviderEntry('PROVIDER_COUNTER', { offerId: 'offer-1', price, deliveryDays: days, notes: 'آخر سعر', replyToMessageId: 'req-msg' }));
const withCounter = (over: Partial<Fx> = {}) => base({ messages: [REQ(), COUNTER()], ...over });

test('accept: applies the counter price + days to BOTH records, back to SUBMITTED, stages re-split to the new total, one acceptance message, provider notified', async (t) => {
	const { svc, fx } = await load(t, withCounter());
	const r = await svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' });
	assert.deepEqual({ status: r.status, price: r.price, days: r.deliveryDays, offerId: r.offerId }, { status: 'SUBMITTED', price: 880, days: 18, offerId: 'offer-1' });
	assert.deepEqual({ s: fx.offer.status, p: fx.offer.totalPrice, d: fx.offer.deliveryDays }, { s: 'SUBMITTED', p: 880, d: 18 });
	assert.deepEqual(fx.mirrors[0], { id: 'legacy-1', status: 'SUBMITTED', price: 880, deliveryDays: 18 });
	assert.equal(fx.offer.milestones.reduce((s, m) => s + m.amount, 0), 880);
	assert.equal(fx.offer.milestones.reduce((s, m) => s + m.days, 0), 18);
	assert.deepEqual(fx.offer.milestones.map((m) => m.percentage), [30, 50, 20]);
	const accepts = fx.messages.filter((m) => m.senderId === 'client-1' && m.content.includes('CLIENT_ACCEPT_COUNTER'));
	assert.equal(accepts.length, 1);
	assert.equal(JSON.parse(accepts[0].content.slice(NEG_PREFIX.length)).replyToMessageId, 'counter-1');
	assert.equal(fx.notified.length, 1);
	assert.deepEqual({ providerId: fx.notified[0].providerId, offerId: fx.notified[0].offerId, price: fx.notified[0].price, days: fx.notified[0].deliveryDays }, { providerId: 'prov-1', offerId: 'offer-1', price: 880, days: 18 });
});

test('accept: the legacy mirror id (what the client UI carries) resolves to the same offer', async (t) => {
	const { svc, fx } = await load(t, withCounter());
	const r = await svc.accept('client-1', 'req-1', 'legacy-1', { messageId: 'counter-1' });
	assert.equal(r.offerId, 'offer-1');
	assert.equal(r.legacyOfferId, 'legacy-1');
	assert.equal(fx.offer.totalPrice, 880);
});

test('accept: a stale / older / unknown message id is 409 and nothing changes', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [REQ(), COUNTER('counter-1', 900, 19), msg('req-2', 'client-1', clientCard({ price: '700' })), COUNTER('counter-2', 880, 18)] }));
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409, /لم يعد الأحدث/);
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'nope' }), 409);
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'req-2' }), 409);
	assert.deepEqual({ s: fx.offer.status, p: fx.offer.totalPrice }, { s: 'UNDER_NEGOTIATION', p: 950 });
	assert.equal(fx.notified.length, 0);
	const ok = await svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-2' });
	assert.equal(ok.price, 880);
});

test('accept: a newer client request after the counter withdraws it (no pending counter => 409)', async (t) => {
	const { svc } = await load(t, base({ messages: [REQ(), COUNTER(), msg('req-2', 'client-1', clientCard({ price: '700' }))] }));
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409, /لا يوجد عرض مضاد معلّق/);
});

test('accept: a request that is not this client\'s is 404, another client cannot accept', async (t) => {
	const { svc, fx } = await load(t, withCounter());
	await refused(svc.accept('client-2', 'req-1', 'offer-1', { messageId: 'counter-1' }), 404);
	await refused(svc.accept('client-1', 'req-other', 'offer-1', { messageId: 'counter-1' }), 404);
	await refused(svc.accept('client-1', 'req-1', 'offer-zzz', { messageId: 'counter-1' }), 404);
	assert.equal(fx.offer.totalPrice, 950);
});

test('accept: messageId is required (400)', async (t) => {
	const { svc } = await load(t, withCounter());
	await refused(svc.accept('client-1', 'req-1', 'offer-1', {}), 400);
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 5 }), 400);
});

test('accept: double accept is 409 (the offer is already SUBMITTED with the new terms) and nothing is written twice', async (t) => {
	const { svc, fx } = await load(t, withCounter());
	await svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' });
	const written = fx.messages.length;
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409);
	assert.equal(fx.messages.length, written);
	assert.equal(fx.notified.length, 1);
});

test('accept: after the acceptance entry no counter is pending even if the offer goes under negotiation again', async (t) => {
	const { svc, fx } = await load(t, withCounter());
	await svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' });
	fx.offer.status = 'UNDER_NEGOTIATION';
	fx.mirrors[0].status = 'UNDER_NEGOTIATION';
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409, /لا يوجد عرض مضاد معلّق/);
	const state = deriveNegotiationState(readNegotiationEntries(fx.messages.map((m) => ({ id: m.id, senderId: m.senderId, content: m.content, createdAt: m.createdAt })), 'prov-1'), 'offer-1');
	assert.deepEqual({ pending: state.counterPending, open: state.openRequest }, { pending: false, open: null });
});

test('accept: a withdrawn offer (CANCELLED) or any non-negotiation state is 409', async (t) => {
	for (const [status, re] of [['CANCELLED', /سحب مقدم الخدمة/], ['SUBMITTED', /لا يوجد عرض مضاد/], ['PENDING_SIGNATURE', /لا يوجد عرض مضاد/], ['REJECTED', /لا يوجد عرض مضاد/]] as const) {
		const { svc, fx } = await load(t, withCounter());
		fx.offer.status = status;
		await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409, re);
		assert.equal(fx.offer.totalPrice, 950);
	}
});

test('accept: refused once the request left OPEN/PENDING_SIGNATURE or the contract moved past client signature', async (t) => {
	let { svc } = await load(t, withCounter({ request: { id: 'req-1', title: 'x', status: 'IN_PROGRESS', ownerUserId: 'client-1' } }));
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409);
	({ svc } = await load(t, withCounter({ contract: { status: 'PENDING_PROVIDER_SIGNATURE' } })));
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409, /تم توقيع العقد/);
});

test('accept: a counter without a clear numeric price/days is refused (422)', async (t) => {
	const free = () => msg('counter-1', 'prov-1', NEG_PREFIX + JSON.stringify({ kind: 'PROVIDER_COUNTER', offerId: 'offer-1', price: 'حوالي 880', duration: 'أسبوعين' }));
	const req = REQ();
	const { svc, fx } = await load(t, base({ messages: [req, free()] }));
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 422);
	assert.equal(fx.offer.totalPrice, 950);
});

test('accept: a "counter" written by the client (forged) is never a pending counter', async (t) => {
	const forged = msg('counter-1', 'client-1', buildProviderEntry('PROVIDER_COUNTER', { offerId: 'offer-1', price: 1, deliveryDays: 1 }));
	const { svc, fx } = await load(t, base({ messages: [REQ(), forged] }));
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409);
	assert.equal(fx.offer.totalPrice, 950);
});

test('accept: atomic — a failure while re-splitting the stages rolls back price, days, status and the mirror together', async (t) => {
	const { svc, fx } = await load(t, withCounter({ failMilestoneUpdate: true }));
	await assert.rejects(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), /db down/);
	assert.deepEqual({ s: fx.offer.status, p: fx.offer.totalPrice, d: fx.offer.deliveryDays }, { s: 'UNDER_NEGOTIATION', p: 950, d: 20 });
	assert.deepEqual(fx.mirrors[0], { id: 'legacy-1', status: 'UNDER_NEGOTIATION', price: 950, deliveryDays: 20 });
	assert.equal(fx.notified.length, 0);
});

test('accept: an inconsistent legacy mirror fails the whole action', async (t) => {
	const { svc, fx } = await load(t, withCounter());
	fx.mirrors[0].status = 'SUBMITTED';
	await refused(svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' }), 409);
	assert.equal(fx.offer.totalPrice, 950);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
});

test('accept: an offer without stages or without a legacy mirror still works', async (t) => {
	const { svc, fx } = await load(t, withCounter({ mirrors: [] }));
	fx.offer.milestones = [];
	const r = await svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' });
	assert.equal(r.legacyOfferId, null);
	assert.equal(fx.offer.totalPrice, 880);
});

test('accept: odd totals keep the stage amounts summing EXACTLY to the new price', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [REQ(), COUNTER('counter-1', 333.33, 7)] }));
	await svc.accept('client-1', 'req-1', 'offer-1', { messageId: 'counter-1' });
	assert.equal(Math.round(fx.offer.milestones.reduce((s, m) => s + m.amount, 0) * 100) / 100, 333.33);
	assert.equal(fx.offer.milestones.reduce((s, m) => s + m.days, 0), 7);
});

test('view: pending clear counter => canAccept; no counter / other status => nothing to accept; non-owner 404', async (t) => {
	let { svc, fx } = await load(t, withCounter());
	let v = await svc.getView('client-1', 'req-1', 'offer-1');
	assert.deepEqual({ id: v.counter.messageId, price: v.counter.price, days: v.counter.deliveryDays, can: v.canAccept }, { id: 'counter-1', price: 880, days: 18, can: true });
	await refused(svc.getView('client-2', 'req-1', 'offer-1'), 404);
	fx.offer.status = 'SUBMITTED';
	v = await svc.getView('client-1', 'req-1', 'offer-1');
	assert.deepEqual({ c: v.counter, can: v.canAccept }, { c: null, can: false });
	({ svc } = await load(t, base({ messages: [REQ()] })));
	v = await svc.getView('client-1', 'req-1', 'offer-1');
	assert.equal(v.canAccept, false);
});
