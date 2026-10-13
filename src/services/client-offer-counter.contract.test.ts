import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEG_PREFIX, buildProviderEntry } from '../utils/offer-negotiation';

// End to end over one in-memory database: original 950 -> provider counter 880 -> client accepts -> selectOffer builds the CONTRACT on 880 (not 950).
test('after accepting a counter, selectOffer freezes the contract on the counter terms (880 / 18 days), stages sum 880', async (t) => {
	const s = { offer: { id: 'offer-1', projectId: 'req-1', providerId: 'prov-1', status: 'UNDER_NEGOTIATION', totalPrice: 950, deliveryDays: 20, milestones: [
		{ id: 'm1', stepOrder: 1, days: 10, amount: 475, percentage: 50 }, { id: 'm2', stepOrder: 2, days: 10, amount: 475, percentage: 50 }] },
		legacy: { id: 'legacy-1', providerId: 'prov-1', clientRequestId: 'req-1', projectId: null as string | null, status: 'UNDER_NEGOTIATION', price: 950, deliveryDays: 20 },
		msgs: [
			{ id: 'req-msg', senderId: 'client-1', content: NEG_PREFIX + JSON.stringify({ isNegotiation: true, status: 'PENDING', price: '800' }), createdAt: new Date(2026, 0, 1, 0, 0, 1) },
			{ id: 'counter-1', senderId: 'prov-1', content: buildProviderEntry('PROVIDER_COUNTER', { offerId: 'offer-1', price: 880, deliveryDays: 18 }), createdAt: new Date(2026, 0, 1, 0, 0, 2) }
		] as any[],
		contract: null as any };
	const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
	const db: any = {
		clientRequest: { findFirst: async () => ({ id: 'req-1', title: 'تصميم', status: 'OPEN' }), update: async () => ({}), updateMany: async () => ({ count: 1 }) },
		proposal: {
			findFirst: async ({ where }: any) => (where.id === s.legacy.id ? { ...s.legacy, provider: {} } : null),
			findMany: async () => [{ id: s.legacy.id, status: s.legacy.status }],
			updateMany: async ({ where, data }: any) => { if (where.id?.in || where.clientRequestId === 'req-1' && !where.providerId?.not) Object.assign(s.legacy, data); return { count: 1 }; }
		},
		projectProposal: {
			findFirst: async () => clone(s.offer),
			updateMany: async ({ where, data }: any) => { if (where.status && where.status !== s.offer.status) return { count: 0 }; if (where.providerId?.not) return { count: 0 }; Object.assign(s.offer, data); return { count: 1 }; }
		},
		proposalMilestone: { update: async ({ where, data }: any) => { Object.assign(s.offer.milestones.find((m) => m.id === where.id)!, data); } },
		project: { update: async () => ({}) },
		contract: {
			findUnique: async () => s.contract, updateMany: async () => ({ count: 1 }),
			upsert: async ({ create }: any) => { s.contract = { id: 'contract-1', ...create }; return s.contract; }
		},
		escrow: { findUnique: async () => null },
		conversation: { findUnique: async () => ({ id: 'conv-1' }) },
		message: {
			findMany: async () => [...s.msgs].sort((a, b) => b.createdAt - a.createdAt),
			findFirst: async ({ where }: any) => s.msgs.find((m) => m.id === where.id) || null,
			create: async ({ data }: any) => { const row = { id: `m-${s.msgs.length}`, createdAt: new Date(2026, 0, 1, 0, 0, 10), ...data }; s.msgs.push(row); return row; }
		},
		$transaction: async (fn: any) => fn(db)
	};
	t.mock.module('../config/db', { namedExports: { prisma: db } });
	t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { counterAccepted: async () => undefined }, PROVIDER_ROUTES: {} } });
	const { clientOfferCounterService } = await import(`./client-offer-counter.service.ts?x=${Math.random()}`);
	const { clientRequestsService } = await import(`./client-requests.service.ts?x=${Math.random()}`);

	await clientOfferCounterService.accept('client-1', 'req-1', 'legacy-1', { messageId: 'counter-1' });
	const sel = await clientRequestsService.selectOffer('client-1', 'req-1', 'legacy-1');

	assert.equal(sel.contractId, 'contract-1');
	assert.equal(s.contract.price, 880);
	assert.notEqual(s.contract.price, 950);
	assert.equal(s.contract.durationDays, 18);
	assert.equal(s.contract.terms.price, 880);
	assert.equal(s.contract.terms.durationDays, 18);
	assert.equal(s.contract.terms.milestones.reduce((a: number, m: any) => a + m.amount, 0), 880);
	assert.equal(s.legacy.price, 880);
});
