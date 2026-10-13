import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Requests list + details carry the REAL stage (request status + contract + offers); createRequest invents nothing; details expose per-offer actions with the server's reason.

const dateT = new Date('2026-01-01T00:00:00Z');
const row = (id: string, status: string, proposals: string[] = []) => ({ id, title: `طلب ${id}`, description: 'وصف', specialty: { nameAr: 'تصميم' }, subSpecialties: [], status, minBudget: 100, maxBudget: 200, budgetType: 'RANGE', proposals: proposals.map(s => ({ status: s })), createdAt: dateT });

// the negotiation service module is cached across the fresh service imports, so every test hands its database through one shared proxy
const holder = { db: {} as any };
const sharedPrisma = new Proxy({}, { get: (_o, k) => holder.db[k as string] });
async function load(t: TestContext, db: any) {
	holder.db = db;
	t.mock.module('../config/db', { namedExports: { prisma: sharedPrisma } });
	const mod = await import(`./client-requests.service.ts?fx=${Date.now()}-${Math.random()}`);
	return mod.clientRequestsService as any;
}

test('getMyRequests: stage is derived from the contract - a request waiting for funding is NOT counted as active', async (t) => {
	const svc = await load(t, {
		clientProfile: { findUnique: async () => ({ id: 'cp-1' }) },
		clientRequest: { findMany: async () => [row('a', 'OPEN'), row('b', 'OPEN', ['SUBMITTED']), row('c', 'OPEN', ['UNDER_NEGOTIATION']), row('d', 'PENDING_SIGNATURE'), row('e', 'PENDING_SIGNATURE'), row('f', 'IN_PROGRESS'), row('g', 'CANCELLED'), row('h', 'COMPLETED'), row('i', 'DRAFT')] },
		project: { findMany: async () => [] },
		contract: { findMany: async () => [{ projectId: 'd', status: 'PENDING_CLIENT_SIGNATURE' }, { projectId: 'e', status: 'PENDING_PROVIDER_SIGNATURE' }, { projectId: 'f', status: 'ACTIVE' }] }
	});
	const { filters, data } = await svc.getMyRequests('user-1');
	const stages = Object.fromEntries(data.map((r: any) => [r.id, r.stage]));
	assert.deepEqual(stages, { a: 'OPEN', b: 'OFFERS_RECEIVED', c: 'UNDER_NEGOTIATION', d: 'AWAITING_CLIENT_SIGNATURE', e: 'AWAITING_PROVIDER_SIGNATURE', f: 'ACTIVE', g: 'CANCELLED', h: 'COMPLETED', i: 'DRAFT' });
	assert.ok(data.every((r: any) => r.stageLabel));
	assert.deepEqual(filters, { allCount: 9, draftCount: 1, openCount: 3, pendingCount: 2, activeCount: 1, closedCount: 2 });
});

test('getMyRequests: a cancelled request is never counted as active (it used to fall into the default bucket)', async (t) => {
	const svc = await load(t, {
		clientProfile: { findUnique: async () => ({ id: 'cp-1' }) },
		clientRequest: { findMany: async () => [row('g', 'CANCELLED')] },
		project: { findMany: async () => [] },
		contract: { findMany: async () => [] }
	});
	const { filters } = await svc.getMyRequests('user-1');
	assert.equal(filters.activeCount, 0);
	assert.equal(filters.closedCount, 1);
});

const createDb = (opts: { specialties?: any[]; created?: any[] } = {}) => {
	const created = opts.created ?? [];
	return {
		clientProfile: { findUnique: async () => ({ id: 'cp-1' }) },
		specialty: {
			findUnique: async ({ where }: any) => (opts.specialties ?? []).find(s => s.id === where.id) ?? null,
			findFirst: async () => null,
			create: async () => { throw new Error('must not create a specialty'); }
		},
		category: { findFirst: async () => null, create: async () => { throw new Error('must not create a category'); } },
		clientRequest: { create: async ({ data }: any) => { created.push(data); return { id: 'new-req', ...data, specialty: {}, clientProfile: { user: {} } }; } },
		project: { create: async () => ({}) },
		user: { findUnique: async () => ({ id: 'user-1' }) },
		notification: { createMany: async () => ({}) }
	};
};
const dto = (o: object = {}) => ({ specialtyId: 'spec-1', title: 'تصميم شعار', description: 'وصف كافٍ للمشروع', budgetType: 'FIXED', minBudget: 500, maxBudget: 500, expectedDurationDays: 14, subSpecialties: [], requiredSkills: [], attachments: [], ...o });

test('createRequest: an unknown specialty is refused (400) - no silent "any active specialty", no made-up one', async (t) => {
	const created: any[] = [];
	const svc = await load(t, createDb({ created }));
	await assert.rejects(svc.createRequest('user-1', dto({ specialtyId: 'nope', specialty: undefined })), (e: any) => e.statusCode === 400 && /التخصص/.test(e.message));
	assert.equal(created.length, 0);
});

test('createRequest: missing duration is refused (400), no invented 14 days', async (t) => {
	const created: any[] = [];
	const svc = await load(t, createDb({ created, specialties: [{ id: 'spec-1', nameAr: 'تصميم' }] }));
	await assert.rejects(svc.createRequest('user-1', dto({ expectedDurationDays: null })), (e: any) => e.statusCode === 400 && /مدة/.test(e.message));
	assert.equal(created.length, 0);
});

test('createRequest: valid data creates an OPEN request with exactly the client\'s own budget and duration', async (t) => {
	const created: any[] = [];
	const svc = await load(t, createDb({ created, specialties: [{ id: 'spec-1', nameAr: 'تصميم', name: 'Design' }] }));
	const out = await svc.createRequest('user-1', dto({ expectedDurationDays: 21 }));
	assert.equal(out.id, 'new-req');
	assert.equal(created[0].status, 'OPEN');
	assert.equal(created[0].expectedDurationDays, 21);
	assert.equal(created[0].minBudget, 500);
	assert.equal(created[0].specialtyId, 'spec-1');
});

test('getRequestDetails: a request owned by someone else is 404 (the owner filter is part of the query)', async (t) => {
	let seen: any;
	const svc = await load(t, { clientRequest: { findFirst: async (a: any) => { seen = a; return null; } } });
	await assert.rejects(svc.getRequestDetails('intruder', 'req-1'), (e: any) => e.statusCode === 404);
	assert.deepEqual(seen.where, { id: 'req-1', clientProfile: { userId: 'intruder' } });
});

function detailsDb(o: { requestStatus?: string; offerStatus?: string; contract?: any; messages?: any[] }) {
	return {
		clientRequest: {
			findFirst: async () => ({
				id: 'req-1', title: 't', description: 'd', status: o.requestStatus ?? 'OPEN', budgetType: 'FIXED', minBudget: 500, maxBudget: null, attachments: [], subSpecialties: [],
				expectedDurationDays: null, createdAt: dateT, updatedAt: dateT, aiAnalyzedSummary: null, aiComplexityRating: null,
				specialty: { id: 's', nameAr: 'تصميم', slug: 's', category: { id: 'c', nameAr: 'ت', slug: 'c' } },
				clientProfile: { user: { email: 'e', firstName: 'a', lastName: 'b' } },
				proposals: [{ id: 'legacy-1', providerId: 'prov-1', status: o.offerStatus ?? 'SUBMITTED', price: 500, deliveryDays: 5, createdAt: dateT, attachments: [], provider: { id: 'prov-1', firstName: 'م', lastName: 'ز', avatarUrl: null, currentLevel: null, gamification: null, providerProfile: null } }]
			})
		},
		projectProposal: { findMany: async () => [{ id: 'canon-1', providerId: 'prov-1', milestones: [], aiQualityTag: null, aiFeedback: null }] },
		project: { groupBy: async () => [] },
		contract: { findUnique: async () => o.contract ?? null },
		message: { findMany: async () => (o.messages ?? []).map(m => ({ ...m, conversation: { providerId: 'prov-1' } })) }
	};
}

test('getRequestDetails: no invented duration; stage OFFERS_RECEIVED; every action allowed on a live offer', async (t) => {
	const svc = await load(t, detailsDb({}));
	const d = await svc.getRequestDetails('client-1', 'req-1');
	assert.equal(d.expectedDurationDays, null);
	assert.equal(d.stage, 'OFFERS_RECEIVED');
	assert.deepEqual(d.proposals[0].actions, { canSelect: true, canNegotiate: true, canChat: true, blockedReason: null, chatBlockedReason: null });
	assert.equal(d.proposals[0].negotiation.state, 'NONE');
});

test('getRequestDetails: a pending counter blocks selecting until answered, and exposes the counter for accept / decline', async (t) => {
	const { buildProviderEntry } = await import('../utils/offer-negotiation');
	const msg = { id: 'ctr-1', senderId: 'prov-1', createdAt: new Date(), content: buildProviderEntry('PROVIDER_COUNTER', { offerId: 'canon-1', price: 450, deliveryDays: 4 }) };
	const svc = await load(t, detailsDb({ offerStatus: 'UNDER_NEGOTIATION', messages: [msg] }));
	const d = await svc.getRequestDetails('client-1', 'req-1');
	assert.equal(d.stage, 'UNDER_NEGOTIATION');
	const p = d.proposals[0];
	assert.equal(p.negotiation.state, 'COUNTER_PENDING');
	assert.equal(p.negotiation.counter.messageId, 'ctr-1');
	assert.equal(p.actions.canSelect, false);
	assert.match(p.actions.blockedReason, /العرض المضاد/);
	assert.equal(p.actions.canNegotiate, true);
});

test('getRequestDetails: waiting for funding is NOT active; selecting/negotiating are disabled with the reason', async (t) => {
	const svc = await load(t, detailsDb({ requestStatus: 'PENDING_SIGNATURE', offerStatus: 'PENDING_SIGNATURE', contract: { status: 'PENDING_PAYMENT', offerId: 'canon-1', providerId: 'prov-1' } }));
	const d = await svc.getRequestDetails('client-1', 'req-1');
	assert.equal(d.stage, 'AWAITING_FUNDING');
	assert.equal(d.contractStatus, 'PENDING_PAYMENT');
	assert.equal(d.selectedOfferId, 'canon-1');
	assert.equal(d.proposals[0].actions.canSelect, false);
	assert.equal(d.proposals[0].actions.canNegotiate, false);
	assert.match(d.proposals[0].actions.blockedReason, /ينتظر التوقيع والضمان/);
});

test('getRequestDetails: cancelled request - no actions, chat disabled with a reason', async (t) => {
	const svc = await load(t, detailsDb({ requestStatus: 'CANCELLED' }));
	const a = (await svc.getRequestDetails('client-1', 'req-1')).proposals[0].actions;
	assert.equal(a.canSelect, false); assert.equal(a.canNegotiate, false); assert.equal(a.canChat, false);
	assert.match(a.chatBlockedReason, /إلغاء/);
});

test('selectOffer: a withdrawn offer, and an offer whose counter still waits, cannot be selected while the request is OPEN', async (t) => {
	const { buildProviderEntry } = await import('../utils/offer-negotiation');
	let status = 'CANCELLED';
	const msgs: any[] = [];
	const db: any = {
		clientRequest: { findFirst: async () => ({ id: 'req-1', title: 't', status: 'OPEN' }) },
		proposal: { findFirst: async () => ({ id: 'legacy-1', providerId: 'prov-1', status, price: 500, deliveryDays: 5, provider: {} }) },
		projectProposal: { findFirst: async () => ({ id: 'canon-1', providerId: 'prov-1', status, totalPrice: 500, deliveryDays: 5, milestones: [] }) },
		message: { findMany: async () => msgs.map(m => ({ ...m, conversation: { providerId: 'prov-1' } })) },
		contract: { findUnique: async () => null },
		escrow: { findUnique: async () => null }
	};
	const svc = await load(t, db);
	await assert.rejects(svc.selectOffer('client-1', 'req-1', 'legacy-1'), (e: any) => e.statusCode === 409 && /مسحوب/.test(e.message));
	status = 'UNDER_NEGOTIATION';
	msgs.push({ id: 'ctr-1', senderId: 'prov-1', createdAt: new Date(), content: buildProviderEntry('PROVIDER_COUNTER', { offerId: 'canon-1', price: 450, deliveryDays: 4 }) });
	await assert.rejects(svc.selectOffer('client-1', 'req-1', 'legacy-1'), (e: any) => e.statusCode === 409 && /العرض المضاد/.test(e.message));
});
