import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function mockPrisma(o: any = {}) {
	return {
		proposal: { findMany: async () => o.proposals || [] },
		project: { findMany: async () => o.projects || [] },
		dispute: { findMany: async () => o.disputes || [] },
		escrow: { aggregate: async (a: any) => ({ _sum: a._sum.releasedAmount ? { releasedAmount: o.released ?? null } : { amount: o.held ?? null } }) },
		walletTransaction: { findMany: async () => o.txs || [] }
	};
}
async function load(t: TestContext, o?: any) {
	t.mock.module('../config/db', { namedExports: { prisma: mockPrisma(o) } });
	const { providerReportsService, offerBucket } = await import(`./provider-reports.service.ts?f=${Date.now()}-${Math.random()}`);
	return { svc: providerReportsService, offerBucket };
}
const prop = (o: any = {}) => ({ id: 'p', price: 100, status: 'SUBMITTED', createdAt: new Date('2026-02-01'), project: { title: 'T', specialty: 'برمجة' }, clientRequest: null, ...o });

test('empty provider: nulls for unsourced figures, zero counts, empty lists — never invented numbers', async (t) => {
	const { svc } = await load(t);
	const r = await svc.getReports('u1', 'all');
	assert.equal(r.requests.total, 0);
	assert.deepEqual(r.requests.items, []);
	assert.deepEqual(r.offersBySpecialty, []);
	assert.equal(r.projects.avgDurationDays, null);
	assert.equal(r.payments.releasedTotal, null);
	assert.equal(r.payments.heldInEscrow, null);
	assert.equal(r.disputes.ratioPercent, null);
});

test('offer statuses are bucketed from real ProposalStatus values', async (t) => {
	const { offerBucket } = await load(t);
	assert.equal(offerBucket('ACCEPTED'), 'accepted');
	assert.equal(offerBucket('REJECTED'), 'rejected');
	assert.equal(offerBucket('CANCELLED'), 'cancelled');
	for (const s of ['PENDING', 'SUBMITTED', 'UNDER_NEGOTIATION', 'IN_AI_REVIEW', 'DRAFT', 'PENDING_SIGNATURE']) assert.equal(offerBucket(s), 'pending');
});

test('acceptance by specialty counts accepted / total per specialty; proposals without a specialty are not grouped', async (t) => {
	const { svc } = await load(t, { proposals: [
		prop({ status: 'ACCEPTED' }), prop({ status: 'REJECTED' }),
		prop({ project: null, clientRequest: { title: 'R', specialty: { nameAr: 'تصميم' } }, status: 'ACCEPTED' }),
		prop({ project: null, clientRequest: null })
	] });
	const r = await svc.getReports('u1', 'all');
	assert.equal(r.requests.total, 4);
	assert.deepEqual(r.requests.byStatus, { pending: 1, accepted: 2, rejected: 1, cancelled: 0 });
	const dev = r.offersBySpecialty.find((x: any) => x.specialty === 'برمجة');
	assert.deepEqual(dev, { specialty: 'برمجة', total: 2, accepted: 1, rate: 50 });
	assert.equal(r.offersBySpecialty.find((x: any) => x.specialty === 'تصميم').rate, 100);
	assert.equal(r.offersBySpecialty.length, 2);
});

test('completed projects: on-time only counts rows with an agreed duration; duration averages real timestamps', async (t) => {
	const day = 86400000, base = new Date('2026-01-01').getTime();
	const proj = (o: any) => ({ id: 'x', title: 'p', status: 'COMPLETED', createdAt: new Date(base), updatedAt: new Date(base + 5 * day), deliveryDays: null, contract: null, ...o });
	const { svc } = await load(t, { projects: [
		proj({ contract: { durationDays: 10 } }),            // on time
		proj({ deliveryDays: 3 }),                           // late (5 > 3)
		proj({}),                                            // no agreed duration → excluded from on-time
		proj({ status: 'IN_PROGRESS' })
	] });
	const r = await svc.getReports('u1', 'all');
	assert.equal(r.projects.completedCount, 3);
	assert.equal(r.projects.activeCount, 1);
	assert.equal(r.projects.avgDurationDays, 5);
	assert.equal(r.projects.completedWithAgreedDuration, 2);
	assert.equal(r.projects.completedOnTime, 1);
});

test('payments come from Escrow/WalletTransaction; dispute ratio = disputes / projects', async (t) => {
	const { svc } = await load(t, {
		released: 900, held: 300,
		txs: [{ id: 't', type: 'ESCROW_RELEASE', amount: 900, currency: 'USD', status: 'COMPLETED', description: null, createdAt: new Date() }],
		projects: [{ id: 'a', status: 'COMPLETED', createdAt: new Date(), updatedAt: new Date(), contract: null }, { id: 'b', status: 'OPEN', createdAt: new Date(), updatedAt: new Date(), contract: null }],
		disputes: [{ id: 'd', status: 'OPEN' }, { id: 'e', status: 'RESOLVED' }]
	});
	const r = await svc.getReports('u1', 'all');
	assert.equal(r.payments.releasedTotal, 900);
	assert.equal(r.payments.heldInEscrow, 300);
	assert.equal(r.payments.transactions[0].currency, 'USD');
	assert.deepEqual(r.disputes.counts, { all: 2, open: 1, resolved: 1, rejected: 0 });
	assert.equal(r.disputes.ratioPercent, 100);
});

test('route is mounted for provider accounts only', () => {
	const src = readFileSync(join(__dirname, '..', 'routes', 'provider.routes.ts'), 'utf-8');
	assert.match(src, /router\.get\('\/reports', authenticate, requireActiveUser, providerOnly, providerReportsController\.getReports\)/);
});
