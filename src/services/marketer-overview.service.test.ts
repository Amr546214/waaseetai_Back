import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.4: getOrCreateProfile()'s (private) missing-AffiliateProfile
// fallback used to create a bare `{ userId, referralSlug }` row. It now
// routes through the same canonical role-state initializer every other
// role-creation path uses — same referralSlug generation semantics (full
// name + userId), plus seeded display fields and a real initial completion
// via the extracted computeAffiliateCompletion. Exercised here via the
// public getSummary(), the simplest caller of the private helper.

function createMockPrisma(t: TestContext, opts: { existingAffiliate?: any; successfulReferrals?: number } = {}) {
  let affiliateState: any = opts.existingAffiliate ?? null;
  const userFixture = { firstName: 'Amr', lastName: 'Okasha', avatarUrl: null, email: 'amr@example.com' };
  const referrals = Array.from({ length: opts.successfulReferrals ?? 0 }, (_, i) => ({ id: `referral-${i}` }));

  const affiliateCreateSpy = t.mock.fn((args: any) => { affiliateState = { id: 'affiliate-1', ...args.data }; return affiliateState; });

  const tx = {
    affiliateProfile: { findUnique: async () => affiliateState, create: affiliateCreateSpy }
  };

  const prismaMock: any = {
    affiliateProfile: {
      findUnique: async () => (affiliateState ? { ...affiliateState, referrals, commissionLogs: [], channelMetrics: [] } : null)
    },
    user: { findUnique: async () => userFixture },
    $transaction: async (fn: any) => fn(tx)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return { affiliateCreateSpy, getAffiliateState: () => affiliateState };
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
