import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const routeSource = fs.readFileSync(path.join(__dirname, '../routes/admin-analytics.routes.ts'), 'utf8');

test('admin-analytics router is gated by authenticate + requireActiveUser + authorize(ADMIN, SUPER_ADMIN) before the route', () => {
	assert.match(routeSource, /router\.use\(authenticate,\s*requireActiveUser,\s*authorize\(AccountType\.ADMIN,\s*AccountType\.SUPER_ADMIN\)\)/);
	assert.ok(routeSource.indexOf("router.get('/overview'") > routeSource.indexOf('router.use(authenticate'));
	assert.doesNotMatch(routeSource, /router\.(post|put|patch|delete)/);
});

test('parseAnalyticsRange: valid dates, bare "to" covers the whole day, junk ignored', async () => {
	const { parseAnalyticsRange } = await import('./admin-analytics.service');
	const r = parseAnalyticsRange('2026-01-01', '2026-01-31');
	assert.equal(r.from?.toISOString(), '2026-01-01T00:00:00.000Z');
	assert.equal(r.to?.toISOString(), '2026-01-31T23:59:59.999Z');
	assert.deepEqual(parseAnalyticsRange('nope', undefined), { from: undefined, to: undefined });
});

function mockPrisma(t: TestContext, capture: { wheres: any[] }) {
	const gb = (rows: any[]) => t.mock.fn(async (args: any) => { capture.wheres.push(args?.where); return rows; });
	return {
		user: { groupBy: gb([{ accountType: 'CLIENT_INDIVIDUAL', _count: { _all: 3 } }, { accountType: 'PROVIDER_INDIVIDUAL', _count: { _all: 2 } }]), findMany: t.mock.fn(async (args: any) => (args?.where?.id ? [{ id: 'p1', firstName: 'A', lastName: 'B', accountType: 'PROVIDER_INDIVIDUAL' }] : [{ createdAt: new Date('2026-01-05T00:00:00Z'), accountType: 'CLIENT_INDIVIDUAL' }])) },
		project: { groupBy: gb([{ status: 'OPEN', providerId: 'p1', specialty: 'web', _count: { _all: 4 } }]) },
		clientRequest: { groupBy: gb([]) },
		order: { groupBy: gb([]) },
		dispute: { groupBy: gb([]) },
		referral: { groupBy: gb([]) },
		providerProfile: { groupBy: gb([{ mainSpecialty: 'web', _count: { _all: 2 } }]) },
		review: {
			aggregate: t.mock.fn(async () => ({ _avg: { rating: 4 }, _count: { _all: 2 } })),
			groupBy: t.mock.fn(async (args: any) => (args.by[0] === 'providerId' ? [{ providerId: 'p1', _avg: { rating: 4 }, _count: { _all: 2 } }] : [{ rating: 5, _count: { _all: 1 } }, { rating: 3, _count: { _all: 1 } }])),
			findMany: t.mock.fn(async () => []),
		},
	};
}

test('overview applies the date window to the queries and returns real aggregates only', async (t) => {
	const capture = { wheres: [] as any[] };
	const prismaMock = mockPrisma(t, capture);
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const { adminAnalyticsService } = await import('./admin-analytics.service?x=1' as any);
	const from = new Date('2026-01-01T00:00:00Z');
	const to = new Date('2026-01-31T23:59:59Z');
	const out = await adminAnalyticsService.overview({ from, to });
	assert.deepEqual(prismaMock.review.aggregate.mock.calls[0].arguments[0].where, { createdAt: { gte: from, lte: to } });
	assert.equal(out.users.total, 5);
	assert.equal(out.users.newInRange, 1);
	assert.deepEqual(out.users.newByMonth, [{ month: '2026-01', count: 1 }]);
	assert.equal(out.reviews.average, 4);
	assert.deepEqual(out.reviews.distribution.find((d: any) => d.stars === 5), { stars: 5, count: 1, percent: 50 });
	assert.equal(out.providers.topRated[0].name, 'A B');
	assert.equal(out.providers.atRisk.length, 0);
	assert.deepEqual(out.specialties, [{ specialty: 'web', projects: 4, providers: 2 }]);
	assert.equal(out.providers.totalProviderAccounts, 2);
});

test('overview without a range sends no createdAt filter', async (t) => {
	const capture = { wheres: [] as any[] };
	const prismaMock = mockPrisma(t, capture);
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const { adminAnalyticsService } = await import('./admin-analytics.service?x=2' as any);
	await adminAnalyticsService.overview({});
	assert.deepEqual(prismaMock.review.aggregate.mock.calls[0].arguments[0].where, {});
});
