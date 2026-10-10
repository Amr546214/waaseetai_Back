import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 3, Part B — real admin brokers listing/detail,
// replacing the fully mock sa-brokers frontend page. `prisma` (via
// ../config/db) is mocked; no real DB/network call ever happens. These
// tests prove every returned number is deterministically derived from real
// rows — no aiFlag/aiNotes/aiScore field, no fabricated totals.

function affiliateFixture(overrides: Record<string, any> = {}) {
	return {
		id: 'aff-1',
		userId: 'user-1',
		firstName: 'سعد',
		lastName: 'الغامدي',
		referralSlug: 'saad',
		currentLevel: 'مساعد',
		createdAt: new Date('2026-01-01'),
		user: { id: 'user-1', firstName: 'Saad', lastName: 'Ghamdi', email: 's@example.com', status: 'ACTIVE', createdAt: new Date('2025-08-01') },
		referrals: [{ status: 'CONVERTED' }, { status: 'CONVERTED' }, { status: 'PENDING' }],
		commissionLogs: [
			{ status: 'APPROVED', amount: 100 },
			{ status: 'PAID', amount: 50 },
			{ status: 'PENDING', amount: 30 },
		],
		marketingChannels: [{ id: 'ch-1' }, { id: 'ch-2' }],
		...overrides,
	};
}

async function loadService(t: TestContext, opts: {
	findMany?: any[];
	count?: number;
	findUnique?: any;
	recentCommissions?: any[];
}) {
	const findManySpy = t.mock.fn(async () => opts.findMany ?? [affiliateFixture()]);
	const countSpy = t.mock.fn(async () => opts.count ?? (opts.findMany ?? [affiliateFixture()]).length);
	const findUniqueSpy = t.mock.fn(async () => (opts.findUnique === undefined ? affiliateFixture() : opts.findUnique));
	const commissionFindManySpy = t.mock.fn(async () => opts.recentCommissions ?? []);

	const prismaMock: any = {
		affiliateProfile: { findMany: findManySpy, count: countSpy, findUnique: findUniqueSpy },
		commissionLog: { findMany: commissionFindManySpy },
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

	const moduleUrl = `./admin-brokers.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { adminBrokersService } = await import(moduleUrl);
	return { adminBrokersService, findManySpy, countSpy, findUniqueSpy, commissionFindManySpy };
}

test('listBrokers: derives conversionRate/paidCommission/pendingCommission/channelCount deterministically from real rows', async (t) => {
	const { adminBrokersService } = await loadService(t, {});

	const result = await adminBrokersService.listBrokers({ page: 1, limit: 20 });

	assert.equal(result.items.length, 1);
	const b = result.items[0];
	assert.equal(b.id, 'user-1');
	assert.equal(b.name, 'سعد الغامدي');
	assert.equal(b.email, 's@example.com');
	assert.equal(b.status, 'ACTIVE');
	assert.equal(b.totalReferrals, 3);
	assert.equal(b.convertedReferrals, 2);
	assert.equal(b.conversionRate, 66.7);
	assert.equal(b.paidCommission, 150);
	assert.equal(b.pendingCommission, 30);
	assert.equal(b.channelCount, 2);
});

test('listBrokers: never includes an aiFlag, aiNotes, or aiScore field', async (t) => {
	const { adminBrokersService } = await loadService(t, {});
	const result = await adminBrokersService.listBrokers({});
	const keys = Object.keys(result.items[0]);
	for (const forbidden of ['aiFlag', 'aiNotes', 'aiScore', 'aiRiskScore', 'aiRiskLevel']) {
		assert.equal(keys.includes(forbidden), false, `unexpected AI field leaked: ${forbidden}`);
	}
});

test('listBrokers: a broker with zero referrals gets a real 0% conversion rate, not NaN or a fabricated number', async (t) => {
	const { adminBrokersService } = await loadService(t, {
		findMany: [affiliateFixture({ referrals: [], commissionLogs: [] })],
	});

	const result = await adminBrokersService.listBrokers({});

	assert.equal(result.items[0].totalReferrals, 0);
	assert.equal(result.items[0].conversionRate, 0);
	assert.equal(Number.isNaN(result.items[0].conversionRate), false);
});

test('listBrokers: returns a real empty state (empty items array) when no affiliates exist', async (t) => {
	const { adminBrokersService } = await loadService(t, { findMany: [], count: 0 });

	const result = await adminBrokersService.listBrokers({});

	assert.deepEqual(result.items, []);
	assert.equal(result.pagination.total, 0);
});

test('listBrokers: pagination is clamped and reflects the real total/totalPages', async (t) => {
	const { adminBrokersService, findManySpy } = await loadService(t, { findMany: [affiliateFixture()], count: 47 });

	const result = await adminBrokersService.listBrokers({ page: 2, limit: 500 });

	assert.equal(result.pagination.page, 2);
	assert.equal(result.pagination.limit, 100);
	assert.equal(result.pagination.total, 47);
	assert.equal(result.pagination.totalPages, 1);
	const call = findManySpy.mock.calls[0].arguments[0];
	assert.equal(call.skip, 100);
	assert.equal(call.take, 100);
});

test('listBrokers: search filters by real User firstName/lastName/email', async (t) => {
	const { adminBrokersService, findManySpy } = await loadService(t, {});

	await adminBrokersService.listBrokers({ search: 'saad' });

	const where = findManySpy.mock.calls[0].arguments[0].where;
	assert.ok(where.user.OR.some((c: any) => c.firstName?.contains === 'saad'));
});

test('getBrokerDetail: throws a real 404 for a broker that does not exist', async (t) => {
	const { adminBrokersService } = await loadService(t, { findUnique: null });

	await assert.rejects(() => adminBrokersService.getBrokerDetail('missing'), (error: any) => {
		assert.equal(error.statusCode, 404);
		return true;
	});
});

test('getBrokerDetail: returns real channels, channelMetrics, customLinks, and recentCommissions (with real referred-user name when present)', async (t) => {
	const createdAt = new Date();
	const recentCommissionRows = [
		{ type: 'NEW_CLIENT_REQUEST', amount: 25, currency: 'USD', status: 'APPROVED', createdAt, referral: { referredUser: { firstName: 'خالد', lastName: 'العتيبي' } } },
		{ type: 'SUBSCRIPTION', amount: 10, currency: 'USD', status: 'PENDING', createdAt, referral: null },
	];
	const { adminBrokersService } = await loadService(t, {
		findUnique: affiliateFixture({
			marketingChannels: [{ platform: 'INSTAGRAM', handle: '@saad', url: null }],
			channelMetrics: [{ channel: 'INSTAGRAM', visitors: 100, clients: 5, conversionPercentage: 5 }],
			customLinks: [{ channelName: 'ig', utmSource: 'instagram', customSlug: 'saad-ig', createdAt: new Date() }],
		}),
		recentCommissions: recentCommissionRows,
	});

	const detail = await adminBrokersService.getBrokerDetail('user-1');

	assert.deepEqual(detail.channels, [{ platform: 'INSTAGRAM', handle: '@saad', url: null }]);
	assert.deepEqual(detail.channelMetrics, [{ channel: 'INSTAGRAM', visitors: 100, clients: 5, conversionPercentage: 5 }]);
	assert.equal(detail.customLinks.length, 1);
	assert.equal(detail.recentCommissions.length, 2);
	assert.equal(detail.recentCommissions[0].referredUserName, 'خالد العتيبي');
	assert.equal(detail.recentCommissions[1].referredUserName, null);
});

test('getBrokerDetail and listBrokers perform zero DB writes', async (t) => {
	const { adminBrokersService } = await loadService(t, {});
	await adminBrokersService.listBrokers({});
	await adminBrokersService.getBrokerDetail('user-1');
	// No update/create/delete method exists on either mocked model at all —
	// if the code under test ever tried to write, it would throw.
});

// ============================================================================
// Deployment-safety regression coverage (P-LG-012 affiliate commission
// engine rollout). AffiliateProfile.level exists in prisma/schema.prisma but
// its migration has NOT been applied to DEV/LIVE. listBrokers()/
// getBrokerDetail() previously used a bare top-level `include` (which does
// not restrict AffiliateProfile's own scalars, only the nested relations
// were already select-restricted) — this would have requested the
// not-yet-existing `level` column and 500'd this admin page. affiliateFixture()
// above is already shaped exactly like the CURRENT (pre-migration) DB row
// would actually look (no `level` field), so every passing test above
// already proves no hidden dependency on it.
// ============================================================================

test('listBrokers: uses an explicit top-level `select` (never a bare `include`) and never requests `level`', async (t) => {
	const { adminBrokersService, findManySpy } = await loadService(t, {});

	await adminBrokersService.listBrokers({ page: 1, limit: 20 });

	// call 1 = the list (explicit select, never `level`); call 2 = the numeric level read on its own (guarded), so the list can never 500 on a missing column
	assert.equal(findManySpy.mock.callCount(), 2);
	const args = findManySpy.mock.calls[0].arguments[0];
	assert.equal(args.include, undefined, 'must use `select`, not a bare top-level `include`');
	assert.ok(args.select, 'must pass an explicit select');
	assert.equal('level' in args.select, false);
	assert.equal('currentLevel' in args.select, false, 'the stale label is no longer read');
	assert.deepEqual(findManySpy.mock.calls[1].arguments[0].select, { id: true, level: true });
});

test('getBrokerDetail: uses an explicit top-level `select` (never a bare `include`) and never requests `level`', async (t) => {
	const { adminBrokersService, findUniqueSpy } = await loadService(t, {});

	await adminBrokersService.getBrokerDetail('user-1');

	assert.equal(findUniqueSpy.mock.callCount(), 1);
	const args = findUniqueSpy.mock.calls[0].arguments[0];
	assert.equal(args.include, undefined, 'must use `select`, not a bare top-level `include`');
	assert.ok(args.select, 'must pass an explicit select');
	assert.equal('level' in args.select, false);
	// `id` must still be selected — getBrokerDetail() uses it to scope the
	// separate commissionLog.findMany() query.
	assert.equal(args.select.id, true);
});

test('listBrokers: the level shown is the single ladder\'s name / number / commission for the numeric level (a missing level reads as level 1)', async (t) => {
	const { adminBrokersService } = await loadService(t, { findMany: [affiliateFixture({ id: 'aff-x', level: 8 })] });
	const { items } = await adminBrokersService.listBrokers({ page: 1, limit: 20 });
	assert.deepEqual([items[0].level, items[0].levelNumber, items[0].commissionPercent], ['موجه', 8, 3]);
});
