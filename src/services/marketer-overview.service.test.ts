import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.4: getOrCreateProfile()'s (private) missing-AffiliateProfile
// fallback used to create a bare `{ userId, referralSlug }` row. It now
// routes through the same canonical role-state initializer every other
// role-creation path uses — same referralSlug generation semantics (full
// name + userId), plus seeded display fields and a real initial completion
// via the extracted computeAffiliateCompletion. Exercised here via the
// public getSummary(), the simplest caller of the private helper.

function createMockPrisma(t: TestContext, opts: {
  existingAffiliate?: any;
  successfulReferrals?: number;
  // getReferredUsers() fixtures — raw Referral rows, each shaped exactly as
  // the real Prisma include would return them (referredUser + commissionLogs
  // already joined).
  referralRows?: any[];
  // getRecentCommissions() fixtures — raw CommissionLog rows, shaped exactly
  // as the CURRENT (pre-migration) DB row would actually look: no
  // referredUserId/sourceProjectId/sourceStageId/baseAmount/
  // appliedPercentage/level fields at all.
  commissionLogRows?: any[];
} = {}) {
  let affiliateState: any = opts.existingAffiliate ?? null;
  const userFixture = { firstName: 'Amr', lastName: 'Okasha', avatarUrl: null, email: 'amr@example.com' };
  const referrals = Array.from({ length: opts.successfulReferrals ?? 0 }, (_, i) => ({ id: `referral-${i}` }));
  const referralRows = opts.referralRows ?? [];
  const commissionLogRows = opts.commissionLogRows ?? [];

  const affiliateCreateSpy = t.mock.fn((args: any) => { affiliateState = { id: 'affiliate-1', ...args.data }; return affiliateState; });
  const referralFindManySpy = t.mock.fn(async (args: any) => {
    const scoped = referralRows.filter(r => r.affiliateId === args.where.affiliateId);
    const skip = args.skip ?? 0;
    const take = args.take ?? scoped.length;
    return scoped.slice(skip, skip + take);
  });
  const referralCountSpy = t.mock.fn(async (args: any) => referralRows.filter(r => r.affiliateId === args.where.affiliateId).length);
  // Deployment-safety regression coverage: getOrCreateProfile()'s outer
  // (non-tx) lookup must explicitly `select` — never the default full
  // selection, which would request the not-yet-migrated
  // AffiliateProfile.level column.
  const affiliateFindUniqueSpy = t.mock.fn(async (_args: any) =>
    (affiliateState ? { ...affiliateState, referrals, commissionLogs: [], channelMetrics: [] } : null)
  );
  const commissionLogFindManySpy = t.mock.fn(async (_args: any) => commissionLogRows);

  const tx = {
    affiliateProfile: { findUnique: async () => affiliateState, create: affiliateCreateSpy }
  };

  const prismaMock: any = {
    affiliateProfile: {
      findUnique: affiliateFindUniqueSpy
    },
    commissionLog: { findMany: commissionLogFindManySpy },
    referral: { findMany: referralFindManySpy, count: referralCountSpy },
    user: { findUnique: async () => userFixture },
    $transaction: async (fn: any) => fn(tx)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return {
    affiliateCreateSpy, referralFindManySpy, referralCountSpy, affiliateFindUniqueSpy, commissionLogFindManySpy,
    getAffiliateState: () => affiliateState
  };
}

async function loadService(t: TestContext, opts?: Parameters<typeof createMockPrisma>[1]) {
  const mocks = createMockPrisma(t, opts);
  const moduleUrl = `./marketer-overview.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { marketerOverviewService } = await import(moduleUrl);
  return { marketerOverviewService, ...mocks };
}

test('getSummary: a missing AffiliateProfile is routed through the canonical initializer — seeds display, generates referralSlug, computes real completion', async (t) => {
  const { marketerOverviewService, affiliateCreateSpy } = await loadService(t);

  await marketerOverviewService.getSummary('user-1');

  assert.equal(affiliateCreateSpy.mock.callCount(), 1);
  const data = affiliateCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.lastName, 'Okasha');
  assert.equal(typeof data.referralSlug, 'string');
  assert.equal(data.referralSlug.length > 0, true);
  assert.equal(typeof data.completionPercentage, 'number');
  // No new affiliate points system, no override of the existing currentLevel default.
  assert.equal('currentLevel' in data, false);
  assert.equal('points' in data, false);
});

test('getSummary: repeat call with an existing AffiliateProfile never re-initializes or overwrites it', async (t) => {
  const { marketerOverviewService, affiliateCreateSpy } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', firstName: 'Independent', currentLevel: 'موصل', completionPercentage: 90 }
  });

  await marketerOverviewService.getSummary('user-1');

  assert.equal(affiliateCreateSpy.mock.callCount(), 0);
});

// ============================================================================
// Phase 3D.5A — Affiliate progression regression tests.
//
// Phase 3D.5's audit concluded no writer for AffiliateProfile.currentLevel
// exists anywhere, and getSummary()'s tier/threshold/progress math has been
// byte-for-byte unchanged since the very first commit. BUSINESS DECISION: do
// not implement automatic "مساعد" -> "موصل" promotion, do not invent a
// threshold. These tests lock in the CURRENT (non-promoting) behavior of
// getSummary() exactly as it exists today, so a future change cannot
// silently alter it.
// ============================================================================

test('getSummary (currentLevel="مساعد"): tier/threshold/progress math matches the existing, unmodified formula', async (t) => {
  const { marketerOverviewService } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', currentLevel: 'مساعد', completionPercentage: 45 },
    successfulReferrals: 3
  });

  const summary = await marketerOverviewService.getSummary('user-1');

  assert.equal(summary.tier, 'مساعد');
  assert.equal(summary.nextTierThreshold, 10);
  assert.equal(summary.successfulReferrals, 3);
  // progressPercentage = successfulReferrals / nextTierThreshold * 100 = 3/10*100 = 30.
  assert.equal(summary.progressPercentage, 30);
});

test('getSummary (currentLevel="مساعد"): progressPercentage caps at 100 even when successfulReferrals exceeds the threshold', async (t) => {
  const { marketerOverviewService } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', currentLevel: 'مساعد', completionPercentage: 45 },
    successfulReferrals: 25
  });

  const summary = await marketerOverviewService.getSummary('user-1');

  assert.equal(summary.nextTierThreshold, 10);
  assert.equal(summary.progressPercentage, 100);
});

test('getSummary (currentLevel="موصل"): tier/threshold/progress math matches the existing, unmodified formula', async (t) => {
  const { marketerOverviewService } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', currentLevel: 'موصل', completionPercentage: 90 },
    successfulReferrals: 10
  });

  const summary = await marketerOverviewService.getSummary('user-1');

  assert.equal(summary.tier, 'موصل');
  assert.equal(summary.nextTierThreshold, 50);
  assert.equal(summary.successfulReferrals, 10);
  // progressPercentage = successfulReferrals / nextTierThreshold * 100 = 10/50*100 = 20.
  assert.equal(summary.progressPercentage, 20);
});

test('getSummary (currentLevel="موصل"): progressPercentage caps at 100 even when successfulReferrals exceeds the threshold', async (t) => {
  const { marketerOverviewService } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', currentLevel: 'موصل', completionPercentage: 90 },
    successfulReferrals: 75
  });

  const summary = await marketerOverviewService.getSummary('user-1');

  assert.equal(summary.nextTierThreshold, 50);
  assert.equal(summary.progressPercentage, 100);
});

test('getSummary: never transitions currentLevel from "مساعد" to "موصل" regardless of successfulReferrals reaching/exceeding the displayed threshold', async (t) => {
  const { marketerOverviewService, affiliateCreateSpy, getAffiliateState } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', currentLevel: 'مساعد', completionPercentage: 45 },
    successfulReferrals: 10 // exactly meets the "مساعد" -> "موصل" nextTierThreshold
  });

  const summary = await marketerOverviewService.getSummary('user-1');

  // tier is still reported as "مساعد" — reaching the threshold never promotes.
  assert.equal(summary.tier, 'مساعد');
  // No write of any kind was attempted (only `.create` exists on the fake
  // model, and it was never called — an `.update` attempt would have thrown).
  assert.equal(affiliateCreateSpy.mock.callCount(), 0);
  assert.equal(getAffiliateState().currentLevel, 'مساعد');
});

// ============================================================================
// getReferredUsers — GET /api/marketer-overview/referrals backing method.
// PII-safety (display name only, never email/phone) and strict per-affiliate
// scoping (never another affiliate's referrals).
// ============================================================================

function referralRowFixture(overrides: any = {}) {
  return {
    id: 'referral-1',
    affiliateId: 'affiliate-1',
    status: 'CONVERTED',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    referredUser: { firstName: 'سارة', lastName: 'أحمد' },
    commissionLogs: [],
    ...overrides
  };
}

test('getReferredUsers: returns display name (firstName/lastName only), status, join date and total commission earned', async (t) => {
  const { marketerOverviewService } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', currentLevel: 'مساعد', completionPercentage: 45 },
    referralRows: [referralRowFixture({
      commissionLogs: [{ amount: 10 }, { amount: 5 }]
    })]
  });

  const result = await marketerOverviewService.getReferredUsers('user-1', 1, 20);

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.displayName, 'سارة أحمد');
  assert.equal(item.status, 'CONVERTED');
  assert.deepEqual(item.joinedAt, new Date('2026-01-01T00:00:00Z'));
  assert.equal(item.totalCommissionEarned, 15);
  // Never exposes email/phone or any other PII field.
  assert.equal('email' in item, false);
  assert.equal('phone' in item, false);
  assert.equal('phoneNumber' in item, false);
});

test('getReferredUsers: only counts APPROVED/PAID commissions as "earned" for display — PENDING is excluded from the total (query-level, via the where clause)', async (t) => {
  const { marketerOverviewService, referralFindManySpy } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1' },
    referralRows: [referralRowFixture()]
  });

  await marketerOverviewService.getReferredUsers('user-1');

  const commissionLogsInclude = referralFindManySpy.mock.calls[0].arguments[0].include.commissionLogs;
  assert.deepEqual(commissionLogsInclude.where.status.in, ['APPROVED', 'PAID']);
});

test('getReferredUsers: paginates via page/limit query params, with a sensible default page size', async (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => referralRowFixture({ id: `referral-${i}`, referredUser: { firstName: `User${i}`, lastName: '' } }));
  const { marketerOverviewService, referralFindManySpy } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1' },
    referralRows: rows
  });

  const page1 = await marketerOverviewService.getReferredUsers('user-1', 1, 2);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.pagination.total, 5);
  assert.equal(page1.pagination.totalPages, 3);

  const page2 = await marketerOverviewService.getReferredUsers('user-1', 2, 2);
  assert.equal(page2.items.length, 2);
  assert.notDeepEqual(page1.items, page2.items);

  // Default limit (no explicit limit passed) is 20.
  await marketerOverviewService.getReferredUsers('user-1');
  const defaultCall = referralFindManySpy.mock.calls.find((c: any) => c.arguments[0].take === 20);
  assert.notEqual(defaultCall, undefined);
});

test('getReferredUsers: strictly scoped to the calling affiliate\'s OWN AffiliateProfile — never returns or queries another affiliate\'s referrals', async (t) => {
  // Two independently-loaded instances simulate two different logged-in
  // affiliates, each with their own AffiliateProfile and their own Referral
  // rows in the same underlying table — proving affiliate B's call can never
  // see affiliate A's referrals (and vice versa). t.mock.module() can only
  // mock a given path once per TestContext, so each load needs its own
  // sub-TestContext (same pattern as project-progress.service.test.ts's
  // winner/loser concurrency test).
  const allRows = [
    referralRowFixture({ id: 'referral-a', affiliateId: 'affiliate-A', referredUser: { firstName: 'Client', lastName: 'A' } }),
    referralRowFixture({ id: 'referral-b', affiliateId: 'affiliate-B', referredUser: { firstName: 'Client', lastName: 'B' } })
  ];

  await t.test('affiliate A, isolated instance', async (t1) => {
    const { marketerOverviewService: serviceA } = await loadService(t1, {
      existingAffiliate: { id: 'affiliate-A' },
      referralRows: allRows
    });
    const resultA = await serviceA.getReferredUsers('user-A');
    assert.equal(resultA.items.length, 1);
    assert.equal(resultA.items[0].displayName, 'Client A');
  });

  await t.test('affiliate B, isolated instance', async (t2) => {
    const { marketerOverviewService: serviceB } = await loadService(t2, {
      existingAffiliate: { id: 'affiliate-B' },
      referralRows: allRows
    });
    const resultB = await serviceB.getReferredUsers('user-B');
    assert.equal(resultB.items.length, 1);
    assert.equal(resultB.items[0].displayName, 'Client B');
  });
});

// ============================================================================
// Deployment-safety regression coverage (P-LG-012 affiliate commission
// engine rollout). AffiliateProfile.level and 6 new CommissionLog columns
// exist in prisma/schema.prisma but their migration has NOT been applied to
// DEV/LIVE. getOrCreateProfile()/getRecentCommissions() previously used
// `include` (which does not restrict the parent model's own scalars), so
// they would have requested those not-yet-existing columns and 500'd this
// dashboard. These tests assert the actual `select` shape sent to Prisma,
// and that every fixture row is shaped exactly like the CURRENT
// (pre-migration) DB would actually return it (the new columns are simply
// absent, not present-with-a-default), proving no hidden dependency on them.
// ============================================================================

test('getSummary: getOrCreateProfile() selects AffiliateProfile scalars explicitly and never requests `level`', async (t) => {
  const { marketerOverviewService, affiliateFindUniqueSpy } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', currentLevel: 'مساعد', referralSlug: 'khalid-1', notifyOnNewReferral: true, sharePerformanceStats: false }
  });

  await marketerOverviewService.getSummary('user-1');

  assert.equal(affiliateFindUniqueSpy.mock.callCount(), 1);
  const args = affiliateFindUniqueSpy.mock.calls[0].arguments[0];
  assert.equal(args.include, undefined, 'must use `select`, not `include` (include does not restrict parent scalars)');
  assert.ok(args.select, 'must pass an explicit select');
  assert.equal('level' in args.select, false);
  // Nested CommissionLog relation must also be restricted — never the 6 new
  // scalars (referredUserId/sourceProjectId/sourceStageId/baseAmount/
  // appliedPercentage/level).
  assert.deepEqual(args.select.commissionLogs.select, { amount: true });
  assert.deepEqual(args.select.channelMetrics.select, { channel: true, visitors: true, conversionPercentage: true });
});

test('getSummary: still computes the correct summary from a fixture row shaped exactly like the pre-migration DB (no `level` field present at all)', async (t) => {
  // Deliberately no `level` key anywhere on this fixture — proving getSummary()
  // does not secretly depend on it being present.
  const { marketerOverviewService } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', currentLevel: 'مساعد', referralSlug: 'khalid-1', notifyOnNewReferral: true, sharePerformanceStats: false },
    successfulReferrals: 3
  });

  const summary = await marketerOverviewService.getSummary('user-1');

  assert.equal(summary.tier, 'مساعد');
  assert.equal(summary.successfulReferrals, 3);
});

test('getRecentCommissions: selects only the fields it reads and never the 6 new CommissionLog scalars or a raw `include`', async (t) => {
  const { marketerOverviewService, commissionLogFindManySpy } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', referralSlug: 'khalid-1' },
    commissionLogRows: []
  });

  await marketerOverviewService.getRecentCommissions('user-1', 5);

  assert.equal(commissionLogFindManySpy.mock.callCount(), 1);
  const args = commissionLogFindManySpy.mock.calls[0].arguments[0];
  assert.equal(args.include, undefined, 'must use `select`, not `include`');
  assert.ok(args.select, 'must pass an explicit select');
  for (const forbidden of ['referredUserId', 'sourceProjectId', 'sourceStageId', 'baseAmount', 'appliedPercentage', 'level']) {
    assert.equal(forbidden in args.select, false, `must not select the new CommissionLog field: ${forbidden}`);
  }
  assert.deepEqual(Object.keys(args.select).sort(), ['amount', 'createdAt', 'currency', 'id', 'referral', 'status', 'type'].sort());
});

test('getRecentCommissions: maps a fixture row shaped exactly like the pre-migration DB (no new CommissionLog columns present) to the correct output shape', async (t) => {
  const row = {
    id: 'log-1',
    type: 'NEW_CLIENT_REQUEST',
    amount: 42,
    currency: 'SAR',
    status: 'APPROVED',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    referral: { referredUser: { id: 'user-9' } }
    // No referredUserId/sourceProjectId/sourceStageId/baseAmount/
    // appliedPercentage/level — matches the CURRENT (pre-migration) schema.
  };
  const { marketerOverviewService } = await loadService(t, {
    existingAffiliate: { id: 'affiliate-1', referralSlug: 'khalid-1' },
    commissionLogRows: [row]
  });

  const result = await marketerOverviewService.getRecentCommissions('user-1', 5);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'log-1');
  assert.equal(result[0].type, 'NEW_CLIENT_REQUEST');
  assert.equal(result[0].amount, 42);
  assert.equal(result[0].currency, 'SAR');
  assert.equal(result[0].status, 'APPROVED');
  assert.equal(result[0].source, 'إحالة عميل جديد');
});
