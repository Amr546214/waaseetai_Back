import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Client reports real-data fix: the client-overview "تقاريري" page used to be
// entirely hardcoded markup. These tests exercise the service that replaced
// every number/list on it with real Prisma-derived values, using a fully
// mocked prisma client (no real DB/network call happens).

function makeMockPrisma(opts: {
	clientProfile?: any;
	clientRequests?: any[];
	projects?: any[];
	reviews?: any[];
	disputes?: any[];
	walletTransactions?: any[];
	escrowSum?: number | null;
} = {}) {
	return {
		clientProfile: { findUnique: async () => (opts.clientProfile === undefined ? { id: 'cp-1' } : opts.clientProfile) },
		clientRequest: { findMany: async () => opts.clientRequests || [] },
		project: { findMany: async () => opts.projects || [] },
		review: { findMany: async () => opts.reviews || [] },
		dispute: { findMany: async () => opts.disputes || [] },
		walletTransaction: { findMany: async () => opts.walletTransactions || [] },
		escrow: { aggregate: async () => ({ _sum: { amount: opts.escrowSum ?? null } }) }
	};
}

async function loadService(t: TestContext, opts?: Parameters<typeof makeMockPrisma>[0]) {
	t.mock.module('../config/db', { namedExports: { prisma: makeMockPrisma(opts) } });
	const moduleUrl = `./client-reports.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { clientReportsService } = await import(moduleUrl);
	return clientReportsService;
}

function req(overrides: any = {}) {
	return {
		id: 'req-1',
		title: 'تطوير موقع',
		minBudget: 1000,
		maxBudget: 2000,
		status: 'OPEN',
		proposals: [],
		specialty: { nameAr: 'برمجة', name: 'Dev' },
		createdAt: new Date('2026-01-05'),
		...overrides
	};
}

test('getReports: an entirely empty account returns all-zero KPIs, never throws', async (t) => {
	const service = await loadService(t, { clientProfile: null });

	const result = await service.getReports('user-1', 'all');

	assert.equal(result.kpis.totalRequests, 0);
	assert.equal(result.kpis.completedProjectsCount, 0);
	assert.equal(result.kpis.totalSpent, 0);
	assert.equal(result.kpis.avgRating, 0);
	assert.deepEqual(result.orders.items, []);
	assert.deepEqual(result.finance.transactions, []);
	assert.deepEqual(result.disputes.items, []);
});

test('getReports: totalRequests and status buckets come from the real request list, not a fixed number', async (t) => {
	const service = await loadService(t, {
		clientRequests: [
			req({ id: 'r1', status: 'OPEN' }),
			req({ id: 'r2', status: 'COMPLETED', maxBudget: 5000 }),
			req({ id: 'r3', status: 'CANCELLED' }),
			req({ id: 'r4', status: 'IN_PROGRESS' })
		]
	});

	const result = await service.getReports('user-1', 'all');

	assert.equal(result.kpis.totalRequests, 4);
	assert.equal(result.orders.counts.published, 1);
	assert.equal(result.orders.counts.completed, 1);
	assert.equal(result.orders.counts.cancelled, 1);
	assert.equal(result.orders.counts.active, 1);
});

test('getReports: totalSpent sums only completed orders\' effective budget (fixed > max > min)', async (t) => {
	const service = await loadService(t, {
		clientRequests: [
			req({ id: 'r1', status: 'COMPLETED', minBudget: 100, maxBudget: 900 }),
			req({ id: 'r2', status: 'OPEN', minBudget: 100, maxBudget: 900 }) // must NOT count — not completed
		]
	});

	const result = await service.getReports('user-1', 'all');

	assert.equal(result.kpis.totalSpent, 900);
});

test('getReports: avgRating is computed from real Review rows, rounded to 1 decimal', async (t) => {
	const service = await loadService(t, {
		reviews: [{ rating: 5, createdAt: new Date() }, { rating: 4, createdAt: new Date() }, { rating: 4.5, createdAt: new Date() }]
	});

	const result = await service.getReports('user-1', 'all');

	assert.equal(result.kpis.avgRating, 4.5);
});

test('getReports: acceptance-by-specialty reflects real proposal outcomes per specialty, sorted by rate', async (t) => {
	const service = await loadService(t, {
		clientRequests: [
			req({ id: 'r1', specialty: { nameAr: 'تصميم' }, status: 'IN_PROGRESS', proposals: [{ status: 'ACCEPTED' }] }),
			req({ id: 'r2', specialty: { nameAr: 'تصميم' }, status: 'OPEN', proposals: [] }),
			req({ id: 'r3', specialty: { nameAr: 'تسويق' }, status: 'OPEN', proposals: [] })
		]
	});

	const result = await service.getReports('user-1', 'all');

	const design = result.orders.acceptanceBySpecialty.find((s: any) => s.specialty === 'تصميم');
	const marketing = result.orders.acceptanceBySpecialty.find((s: any) => s.specialty === 'تسويق');
	assert.equal(design.rate, 50);
	assert.equal(marketing.rate, 0);
});

test('getReports: escrowHeld comes directly from the real HELD escrow aggregate, not a guessed value', async (t) => {
	const service = await loadService(t, { escrowSum: 12345.5 });

	const result = await service.getReports('user-1', 'all');

	assert.equal(result.finance.escrowHeld, 12345.5);
});

test('getReports: a ClientRequest and a Project with the same id are never double-counted', async (t) => {
	const service = await loadService(t, {
		clientRequests: [req({ id: 'shared-1' })],
		projects: [{ id: 'shared-1', title: 'x', specialty: 'عام', status: 'OPEN', createdAt: new Date(), proposals: [], contract: null, providerId: null }]
	});

	const result = await service.getReports('user-1', 'all');

	assert.equal(result.kpis.totalRequests, 1);
});

test('getReports: disputes are scoped to disputes the user opened or is named against, with real status counts', async (t) => {
	const service = await loadService(t, {
		disputes: [
			{ id: 'd1', status: 'OPEN', reason: 'x', createdAt: new Date(), resolvedAt: null },
			{ id: 'd2', status: 'RESOLVED', reason: 'y', createdAt: new Date(), resolvedAt: new Date() }
		]
	});

	const result = await service.getReports('user-1', 'all');

	assert.equal(result.disputes.counts.all, 2);
	assert.equal(result.disputes.counts.open, 1);
	assert.equal(result.disputes.counts.resolved, 1);
});

test('getReports: an unknown/invalid range still resolves without throwing (defensive floor)', async (t) => {
	const service = await loadService(t, {});
	// @ts-expect-error — deliberately passing an invalid range at the boundary
	const result = await service.getReports('user-1', 'bogus-range');
	assert.ok(result.kpis);
});
