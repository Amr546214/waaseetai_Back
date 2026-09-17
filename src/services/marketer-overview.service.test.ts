import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.4: getOrCreateProfile()'s (private) missing-AffiliateProfile
// fallback used to create a bare `{ userId, referralSlug }` row. It now
// routes through the same canonical role-state initializer every other
// role-creation path uses — same referralSlug generation semantics (full
// name + userId), plus seeded display fields and a real initial completion
// via the extracted computeAffiliateCompletion. Exercised here via the
// public getSummary(), the simplest caller of the private helper.

function createMockPrisma(t: TestContext, opts: { existingAffiliate?: any } = {}) {
  let affiliateState: any = opts.existingAffiliate ?? null;
  const userFixture = { firstName: 'Amr', lastName: 'Okasha', avatarUrl: null, email: 'amr@example.com' };

  const affiliateCreateSpy = t.mock.fn((args: any) => { affiliateState = { id: 'affiliate-1', ...args.data }; return affiliateState; });

  const tx = {
    affiliateProfile: { findUnique: async () => affiliateState, create: affiliateCreateSpy }
  };

  const prismaMock: any = {
    affiliateProfile: {
      findUnique: async () => (affiliateState ? { ...affiliateState, referrals: [], commissionLogs: [], channelMetrics: [] } : null)
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
