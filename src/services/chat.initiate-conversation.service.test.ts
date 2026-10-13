import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// A client opens / negotiates a conversation only on THEIR project, only with an offer that is still live on a request that still takes offers.
type Fx = { user?: object; requestStatus?: string; owner?: string; offerStatus?: string; existing?: boolean };

async function load(t: TestContext, fx: Fx = {}) {
	const created: { conversations: any[]; messages: any[]; offerUpdates: any[] } = { conversations: [], messages: [], offerUpdates: [] };
	const conversation = (data: any) => ({ id: 'conv-1', ...data, project: { title: 't' }, client: { id: data.clientId, firstName: 'a', lastName: 'b' }, provider: { id: data.providerId, firstName: 'c', lastName: 'd' }, messages: [], createdAt: new Date(), updatedAt: new Date() });
	const db: any = {
		user: { findUnique: async () => ({ id: 'client-1', accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', firstName: 'a', lastName: 'b', ...fx.user }) },
		project: { findUnique: async () => ({ id: 'req-1', clientId: fx.owner ?? 'client-1', providerId: null, title: 't', specialty: 's', budgetMin: 1, budgetMax: 2, budgetFixed: null }) },
		clientRequest: { findUnique: async () => ({ id: 'req-1', title: 't', status: fx.requestStatus ?? 'OPEN', clientProfile: { userId: fx.owner ?? 'client-1' } }) },
		projectProposal: {
			findFirst: async () => ({ id: 'canon-1', status: fx.offerStatus ?? 'SUBMITTED' }),
			findUnique: async () => ({ id: 'canon-1', providerId: 'prov-1' }),
			updateMany: async (a: any) => { created.offerUpdates.push(a); return { count: 1 }; }
		},
		proposal: { findFirst: async () => null, findUnique: async () => null, updateMany: async () => ({ count: 1 }) },
		conversation: {
			findUnique: async () => (fx.existing ? conversation({ projectId: 'req-1', providerId: 'prov-1', clientId: 'client-1' }) : null),
			create: async ({ data }: any) => { created.conversations.push(data); return { id: 'conv-1', ...data }; }
		},
		message: { create: async ({ data }: any) => { created.messages.push(data); return data; } },
		$transaction: async (ops: any[]) => Promise.all(ops)
	};
	// refetch after create returns the shape the formatter needs
	const orig = db.conversation.findUnique;
	db.conversation.findUnique = async (a: any) => (created.conversations.length ? conversation(created.conversations[0]) : orig(a));
	t.mock.module('../config/db', { namedExports: { prisma: db } });
	const { chatService } = await import(`./chat.service.ts?fx=${Date.now()}-${Math.random()}`);
	return { svc: chatService, created };
}
const neg = { isNegotiation: true, negType: 'price', negTypeName: 'السعر', price: '800', duration: '10', notes: 'x', status: 'PENDING' };

test('the conversation opens on the right projectId with the offer and provider', async (t) => {
	const { svc, created } = await load(t);
	const out = await svc.initiateConversation('client-1', { projectId: 'req-1', providerId: 'prov-1', offerId: 'canon-1' });
	assert.equal(out.projectId, 'req-1');
	assert.equal(created.conversations[0].projectId, 'req-1');
	assert.equal(created.conversations[0].providerId, 'prov-1');
});

test('a client cannot open a conversation on a project that is not theirs (403)', async (t) => {
	const { svc, created } = await load(t, { owner: 'someone-else' });
	await assert.rejects(svc.initiateConversation('client-1', { projectId: 'req-1', providerId: 'prov-1' }), (e: any) => e.statusCode === 403);
	assert.equal(created.conversations.length, 0);
});

test('a negotiation request on a live offer is stored (with its duration) and moves the offer to UNDER_NEGOTIATION', async (t) => {
	const { svc, created } = await load(t);
	await svc.initiateConversation('client-1', { projectId: 'req-1', providerId: 'prov-1', offerId: 'canon-1', negotiationPayload: neg });
	const card = created.messages.find(m => String(m.content).startsWith('WS_NEGOTIATION::'));
	assert.ok(card);
	assert.equal(JSON.parse(card.content.slice('WS_NEGOTIATION::'.length)).duration, '10');
	assert.equal(created.offerUpdates[0].data.status, 'UNDER_NEGOTIATION');
});

test('the client cannot forge a provider counter / client answer through the request card (kind is dropped)', async (t) => {
	const { svc, created } = await load(t);
	await svc.initiateConversation('client-1', { projectId: 'req-1', providerId: 'prov-1', offerId: 'canon-1', negotiationPayload: { ...neg, kind: 'PROVIDER_COUNTER', offerId: 'canon-1' } as any });
	const card = created.messages.find(m => String(m.content).startsWith('WS_NEGOTIATION::'));
	assert.equal(JSON.parse(card.content.slice('WS_NEGOTIATION::'.length)).kind, undefined);
});

for (const [offerStatus, re] of [['CANCELLED', /سحبه/], ['REJECTED', /مرفوض/], ['PENDING_SIGNATURE', /بانتظار التوقيع/], ['ACCEPTED', /مقبول/]] as const) {
	test(`negotiation is blocked (409, with the reason) when the offer is ${offerStatus}`, async (t) => {
		const { svc, created } = await load(t, { offerStatus });
		await assert.rejects(svc.initiateConversation('client-1', { projectId: 'req-1', providerId: 'prov-1', offerId: 'canon-1', negotiationPayload: neg }), (e: any) => e.statusCode === 409 && re.test(e.message));
		assert.equal(created.offerUpdates.length, 0);
		assert.equal(created.messages.length, 0);
	});
}

for (const [requestStatus, re] of [['CANCELLED', /إلغاء/], ['PENDING_SIGNATURE', /عرض آخر|التوقيع/], ['IN_PROGRESS', /قيد التنفيذ/], ['COMPLETED', /اكتمل/]] as const) {
	test(`negotiation is blocked (409) when the request is ${requestStatus}`, async (t) => {
		const { svc, created } = await load(t, { requestStatus });
		await assert.rejects(svc.initiateConversation('client-1', { projectId: 'req-1', providerId: 'prov-1', offerId: 'canon-1', negotiationPayload: neg }), (e: any) => e.statusCode === 409 && re.test(e.message));
		assert.equal(created.messages.length, 0);
	});
}
