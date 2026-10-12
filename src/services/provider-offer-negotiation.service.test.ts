import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NEG_PREFIX, buildProviderEntry } from '../utils/offer-negotiation';

const clientCard = (o: object) => NEG_PREFIX + JSON.stringify({ isNegotiation: true, negType: 'price', negTypeName: 'السعر', status: 'PENDING', notes: '', ...o });
let sec = 0;
const msg = (id: string, senderId: string, content: string) => ({ id, senderId, content, createdAt: new Date(2026, 0, 1, 0, 0, ++sec) });

type Fx = {
	offer: { id: string; projectId: string; providerId: string; status: string; project: { clientId: string; title: string } };
	mirrors: { id: string; status: string }[];
	contract: null | { offerId: string; providerId: string };
	conversation: null | { id: string };
	messages: any[];
	notifications: any[];
	lockCount?: number;
};
const base = (over: Partial<Fx> = {}): Fx => ({
	offer: { id: 'offer-1', projectId: 'project-1', providerId: 'prov-1', status: 'UNDER_NEGOTIATION', project: { clientId: 'client-1', title: 'تصميم هوية' } },
	mirrors: [{ id: 'legacy-1', status: 'UNDER_NEGOTIATION' }],
	contract: null,
	conversation: { id: 'conv-1' },
	messages: [],
	notifications: [],
	...over
});

// node:test allows mocking a module once per test: a test that builds several fixtures swaps the database behind one proxy.
const perTest = new WeakMap<object, { holder: { db: any }; svc: any }>();

async function load(t: TestContext, fx: Fx) {
	const calls = { offerUpdates: [] as any[], mirrorUpdates: [] as any[], created: [] as any[] };
	const inSet = (cond: any, v: string) => (cond && typeof cond === 'object' ? cond.in.includes(v) : cond === v);
	const clone = () => JSON.parse(JSON.stringify({ offer: fx.offer, mirrors: fx.mirrors, messages: fx.messages, notifications: fx.notifications }));
	const db: any = {
		projectProposal: {
			findFirst: async ({ where }: any) => {
				const o = fx.offer;
				const hit = (where.id ? where.id === o.id : where.projectId === o.projectId) && where.providerId === o.providerId;
				return hit ? { ...o } : null;
			},
			updateMany: async ({ where, data }: any) => {
				calls.offerUpdates.push({ where, data });
				const ok = where.id === fx.offer.id && where.providerId === fx.offer.providerId && inSet(where.status, fx.offer.status) && fx.lockCount !== 0;
				if (!ok) return { count: 0 };
				if (data.status) fx.offer.status = data.status;
				return { count: 1 };
			}
		},
		proposal: {
			findMany: async () => fx.mirrors.map((m) => ({ ...m })),
			updateMany: async ({ where, data }: any) => { calls.mirrorUpdates.push({ where, data }); for (const m of fx.mirrors) if (where.id.in.includes(m.id)) m.status = data.status; return { count: fx.mirrors.length }; }
		},
		contract: { findUnique: async () => fx.contract },
		conversation: { findUnique: async () => fx.conversation },
		message: {
			findMany: async ({ where, take }: any) => fx.messages.filter((m) => m.content?.startsWith(where.content.startsWith)).sort((a, b) => b.createdAt - a.createdAt).slice(0, take),
			findFirst: async ({ where }: any) => fx.messages.find((m) => m.id === where.id) || null,
			create: async ({ data }: any) => { const row = { id: `new-${fx.messages.length + 1}`, createdAt: new Date(2026, 0, 1, 0, 0, ++sec), ...data }; fx.messages.push(row); calls.created.push(row); return row; }
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
		const { providerOfferNegotiationService } = await import(`./provider-offer-negotiation.service.ts?fx=${Date.now()}-${Math.random()}`);
		cached = { holder, svc: providerOfferNegotiationService };
		perTest.set(t, cached);
	}
	cached.holder.db = db;
	return { svc: cached.svc, fx, calls };
}
const refused = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => e.statusCode === status && (!re || re.test(e.message)));
const CLEAR = () => msg('req-1', 'client-1', clientCard({ price: '800' }));

// ---------- withdraw ----------
for (const status of ['PENDING', 'SUBMITTED', 'UNDER_NEGOTIATION']) {
	test(`withdraw is allowed from ${status}: both records become CANCELLED together and the client is notified`, async (t) => {
		const { svc, fx } = await load(t, base({ offer: { ...base().offer, status }, mirrors: [{ id: 'legacy-1', status }] }));
		const out = await svc.withdraw('prov-1', 'offer-1');
		assert.equal(out.status, 'CANCELLED');
		assert.equal(fx.offer.status, 'CANCELLED');
		assert.equal(fx.mirrors[0].status, 'CANCELLED');
		assert.equal(fx.notifications.length, 1);
		assert.equal(fx.notifications[0].userId, 'client-1');
		assert.equal(fx.notifications[0].type, 'OFFER_WITHDRAWN');
	});
}
for (const status of ['DRAFT', 'IN_AI_REVIEW', 'PENDING_SIGNATURE', 'ACCEPTED', 'REJECTED', 'CANCELLED']) {
	test(`withdraw is refused from ${status} (409) and nothing changes`, async (t) => {
		const { svc, fx } = await load(t, base({ offer: { ...base().offer, status }, mirrors: [{ id: 'legacy-1', status }] }));
		await refused(svc.withdraw('prov-1', 'offer-1'), 409);
		assert.equal(fx.offer.status, status);
		assert.equal(fx.mirrors[0].status, status);
		assert.equal(fx.notifications.length, 0);
	});
}
test('withdraw: an offer the provider does not own is 404 (never touched)', async (t) => {
	const { svc, fx } = await load(t, base());
	await refused(svc.withdraw('someone-else', 'offer-1'), 404);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
});
test('withdraw: a lost race (status moved after the read) is 409 and the whole transaction is undone', async (t) => {
	const { svc, fx } = await load(t, base({ lockCount: 0 }));
	await refused(svc.withdraw('prov-1', 'offer-1'), 409);
	assert.equal(fx.mirrors[0].status, 'UNDER_NEGOTIATION');
	assert.equal(fx.notifications.length, 0);
});
test('withdraw: an inconsistent legacy mirror fails the whole action (no half update)', async (t) => {
	const { svc, fx } = await load(t, base({ mirrors: [{ id: 'legacy-1', status: 'ACCEPTED' }] }));
	await refused(svc.withdraw('prov-1', 'offer-1'), 409);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION'); // rolled back
	assert.equal(fx.notifications.length, 0);
});
test('withdraw: not allowed once a contract of this provider exists on the project', async (t) => {
	const { svc, fx } = await load(t, base({ contract: { offerId: 'offer-1', providerId: 'prov-1' } }));
	await refused(svc.withdraw('prov-1', 'offer-1'), 409, /التعاقد/);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
});
test('withdraw: a canonical offer with no legacy mirror still works', async (t) => {
	const { svc, fx } = await load(t, base({ mirrors: [] }));
	await svc.withdraw('prov-1', 'offer-1');
	assert.equal(fx.offer.status, 'CANCELLED');
});

// ---------- counter ----------
test('counter: only while UNDER_NEGOTIATION — every other status is 409 and writes nothing', async (t) => {
	for (const status of ['PENDING', 'SUBMITTED', 'PENDING_SIGNATURE', 'ACCEPTED', 'REJECTED', 'CANCELLED']) {
		const { svc, fx } = await load(t, base({ offer: { ...base().offer, status }, messages: [CLEAR()] }));
		await refused(svc.counter('prov-1', 'offer-1', { price: 900, deliveryDays: 10 }), 409);
		assert.equal(fx.messages.length, 1, status);
		assert.equal(fx.notifications.length, 0, status);
	}
});
test('counter: writes ONE structured WS_NEGOTIATION message (not free text) in the project conversation, notifies the client, keeps the offer untouched', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR()] }));
	const out = await svc.counter('prov-1', 'offer-1', { price: 900, deliveryDays: 10, note: 'سعر عادل' });
	assert.equal(fx.messages.length, 2);
	const m = fx.messages[1];
	assert.equal(m.conversationId, 'conv-1');
	assert.equal(m.senderId, 'prov-1');
	const json = JSON.parse(m.content.slice(NEG_PREFIX.length));
	assert.deepEqual({ kind: json.kind, offerId: json.offerId, priceValue: json.priceValue, deliveryDays: json.deliveryDays, notes: json.notes, replyTo: json.replyToMessageId, status: json.status }, { kind: 'PROVIDER_COUNTER', offerId: 'offer-1', priceValue: 900, deliveryDays: 10, notes: 'سعر عادل', replyTo: 'req-1', status: 'COUNTER_SENT' });
	assert.equal(out.messageId, m.id);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION'); // a counter changes no price / duration / status
	assert.equal(fx.mirrors[0].status, 'UNDER_NEGOTIATION');
	assert.deepEqual(fx.notifications.map((n) => [n.userId, n.type]), [['client-1', 'OFFER_COUNTER']]);
});
test('counter: a SECOND pending counter is refused (409)', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR()] }));
	await svc.counter('prov-1', 'offer-1', { price: 900, deliveryDays: 10 });
	await refused(svc.counter('prov-1', 'offer-1', { price: 850, deliveryDays: 9 }), 409, /معلّق/);
	assert.equal(fx.messages.length, 2);
	assert.equal(fx.notifications.length, 1);
});
test('counter: after the client sends a newer request the provider may counter again', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR()] }));
	await svc.counter('prov-1', 'offer-1', { price: 900, deliveryDays: 10 });
	fx.messages.push(msg('req-2', 'client-1', clientCard({ price: '780' })));
	await svc.counter('prov-1', 'offer-1', { price: 850, deliveryDays: 9 });
	assert.equal(fx.messages.length, 4);
});
test('counter: needs the negotiation conversation (409 when absent)', async (t) => {
	const { svc, fx } = await load(t, base({ conversation: null }));
	await refused(svc.counter('prov-1', 'offer-1', { price: 900, deliveryDays: 10 }), 409);
	assert.equal(fx.notifications.length, 0);
});
test('counter: lost the lock (status changed concurrently) => 409, nothing written', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR()], lockCount: 0 }));
	await refused(svc.counter('prov-1', 'offer-1', { price: 900, deliveryDays: 10 }), 409);
	assert.equal(fx.messages.length, 1);
});
test('counter: values are validated (400) before anything is read or written', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR()] }));
	const bad: any[] = [
		{ price: 0, deliveryDays: 5 }, { price: -1, deliveryDays: 5 }, { price: '900', deliveryDays: 5 }, { price: NaN, deliveryDays: 5 }, { price: Infinity, deliveryDays: 5 }, { price: 1e9, deliveryDays: 5 },
		{ price: 900, deliveryDays: 0 }, { price: 900, deliveryDays: 2.5 }, { price: 900, deliveryDays: '5' }, { price: 900, deliveryDays: 99999 }, { price: 900 }, { deliveryDays: 5 }, {},
		{ price: 900, deliveryDays: 5, note: 123 }, { price: 900, deliveryDays: 5, note: 'x'.repeat(501) }
	];
	for (const b of bad) await refused(svc.counter('prov-1', 'offer-1', b), 400);
	assert.equal(fx.messages.length, 1);
});
test('counter: not another provider\'s offer (404)', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR()] }));
	await refused(svc.counter('someone-else', 'offer-1', { price: 900, deliveryDays: 10 }), 404);
	assert.equal(fx.messages.length, 1);
});

// ---------- reject (decline the client's request) ----------
test('reject: a clear request => both records back to SUBMITTED with their ORIGINAL values, a structured reply, the client notified', async (t) => {
	const { svc, fx, calls } = await load(t, base({ messages: [CLEAR()] }));
	const out = await svc.reject('prov-1', 'offer-1', { messageId: 'req-1' });
	assert.equal(out.status, 'SUBMITTED');
	assert.equal(fx.offer.status, 'SUBMITTED');
	assert.equal(fx.mirrors[0].status, 'SUBMITTED');
	assert.ok(calls.offerUpdates.every((u) => !('totalPrice' in u.data) && !('deliveryDays' in u.data)), 'no price / duration write');
	const reply = JSON.parse(fx.messages[1].content.slice(NEG_PREFIX.length));
	assert.deepEqual({ kind: reply.kind, replyTo: reply.replyToMessageId, status: reply.status }, { kind: 'PROVIDER_REJECT', replyTo: 'req-1', status: 'REJECTED' });
	assert.deepEqual(fx.notifications.map((n) => [n.userId, n.type]), [['client-1', 'OFFER_NEGOTIATION_REJECTED']]);
});
test('reject: a free-text request is refused (422) with the "agree in chat, then send a clear counter" message; nothing changes', async (t) => {
	for (const card of [{ price: 'حوالي 3000', notes: 'خصم؟' }, { price: '', notes: 'ممكن تخفيض' }, { notes: 'فقط كلام' }]) {
		const { svc, fx } = await load(t, base({ messages: [msg('req-1', 'client-1', clientCard(card))] }));
		await refused(svc.reject('prov-1', 'offer-1', { messageId: 'req-1' }), 422, /اتفقوا في المحادثة ثم أرسل عرضًا مضادًا واضحًا/);
		assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
		assert.equal(fx.notifications.length, 0);
	}
});
test('reject: only the NEWEST unanswered request (stale / unknown / answered message ids are 409)', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR(), msg('req-2', 'client-1', clientCard({ price: '700' }))] }));
	await refused(svc.reject('prov-1', 'offer-1', { messageId: 'req-1' }), 409);
	await refused(svc.reject('prov-1', 'offer-1', { messageId: 'nope' }), 409);
	await svc.reject('prov-1', 'offer-1', { messageId: 'req-2' });
	assert.equal(fx.offer.status, 'SUBMITTED');
});
test('reject: after the provider sent a counter the earlier request can no longer be rejected (409)', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR()] }));
	await svc.counter('prov-1', 'offer-1', { price: 900, deliveryDays: 10 });
	await refused(svc.reject('prov-1', 'offer-1', { messageId: 'req-1' }), 409);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
});
test('reject: a "request" that the project\'s client did not write is not acted on', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [msg('req-1', 'stranger', clientCard({ price: '800' }))] }));
	await refused(svc.reject('prov-1', 'offer-1', { messageId: 'req-1' }), 409);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
});
test('reject: not UNDER_NEGOTIATION => 409; missing messageId => 400; not the owner => 404', async (t) => {
	let l = await load(t, base({ offer: { ...base().offer, status: 'SUBMITTED' }, messages: [CLEAR()] }));
	await refused(l.svc.reject('prov-1', 'offer-1', { messageId: 'req-1' }), 409);
	l = await load(t, base({ messages: [CLEAR()] }));
	await refused(l.svc.reject('prov-1', 'offer-1', {}), 400);
	await refused(l.svc.reject('someone-else', 'offer-1', { messageId: 'req-1' }), 404);
});
test('reject: inconsistent mirror => whole action rolled back', async (t) => {
	const { svc, fx } = await load(t, base({ messages: [CLEAR()], mirrors: [{ id: 'legacy-1', status: 'SUBMITTED' }] }));
	await refused(svc.reject('prov-1', 'offer-1', { messageId: 'req-1' }), 409);
	assert.equal(fx.offer.status, 'UNDER_NEGOTIATION');
	assert.equal(fx.messages.length, 1);
	assert.equal(fx.notifications.length, 0);
});

// ---------- view ----------
test('view: open clear request => canReject + canCounter, numbers exposed; free text => no reject and the hint; counter pending => no counter', async (t) => {
	let l = await load(t, base({ messages: [CLEAR()] }));
	let v = await l.svc.getView('prov-1', { offerId: 'offer-1' });
	assert.deepEqual([v.canWithdraw, v.canCounter, v.canReject, v.request?.price, v.request?.messageId, v.hint], [true, true, true, 800, 'req-1', null]);
	l = await load(t, base({ messages: [msg('req-1', 'client-1', clientCard({ price: 'حوالي 3000' }))] }));
	v = await l.svc.getView('prov-1', { projectId: 'project-1' });
	assert.deepEqual([v.canCounter, v.canReject, v.request?.clear], [true, false, false]);
	assert.match(v.hint, /اتفقوا في المحادثة ثم أرسل عرضًا مضادًا واضحًا/);
	l = await load(t, base({ messages: [CLEAR()] }));
	await l.svc.counter('prov-1', 'offer-1', { price: 900, deliveryDays: 10 });
	v = await l.svc.getView('prov-1', { offerId: 'offer-1' });
	assert.deepEqual([v.counterPending, v.canCounter, v.canReject], [true, false, false]);
});
test('view: a SUBMITTED offer can be withdrawn but not countered/rejected; a CANCELLED one nothing; another provider => 404', async (t) => {
	let l = await load(t, base({ offer: { ...base().offer, status: 'SUBMITTED' } }));
	let v = await l.svc.getView('prov-1', { offerId: 'offer-1' });
	assert.deepEqual([v.canWithdraw, v.canCounter, v.canReject], [true, false, false]);
	l = await load(t, base({ offer: { ...base().offer, status: 'CANCELLED' } }));
	v = await l.svc.getView('prov-1', { offerId: 'offer-1' });
	assert.deepEqual([v.canWithdraw, v.canCounter, v.canReject], [false, false, false]);
	await refused(l.svc.getView('other', { offerId: 'offer-1' }), 404);
});
