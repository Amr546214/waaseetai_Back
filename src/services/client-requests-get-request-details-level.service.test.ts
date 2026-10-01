import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Batch 5 (truthfulness pass) — getRequestDetails() previously returned no
// real gamification level at all; the frontend (request-details.ts) read the
// accreditation `badge` field (`isAccredited ? 'معتمد' : 'محترف'` — note
// 'محترف' collides with a REAL PROVIDER_LEVEL_MATRIX title) into a variable
// named providerLevel. This proves the backend now resolves and returns a
// real `providerLevel` via the same resolveProviderProgression() canonical
// resolver marketplace and the dashboard already use, independent of and
// alongside the still-intact accreditation `badge` field.

type ProviderFixture = {
  id: string; firstName: string; lastName: string; avatarUrl: string | null;
  currentLevel: string | null; gamification: { points: number; currentLevelIndex: number } | null;
  providerProfile: { headline: string | null; companyName: string | null; rating: number | null; isVerified: boolean } | null;
};

function providerFixture(overrides: Partial<ProviderFixture> = {}): ProviderFixture {
  return {
    id: 'provider-1',
    firstName: 'أحمد',
    lastName: 'محمد',
    avatarUrl: null,
    currentLevel: null,
    gamification: null,
    providerProfile: { headline: null, companyName: null, rating: 4.5, isVerified: true },
    ...overrides,
  };
}

function proposalFixture(overrides: Partial<{ id: string; providerId: string; provider: ProviderFixture; status: string }> = {}) {
  return {
    id: overrides.id ?? 'prop-1',
    providerId: overrides.providerId ?? overrides.provider?.id ?? 'provider-1',
    provider: overrides.provider ?? providerFixture(),
    status: overrides.status ?? 'SUBMITTED',
    coverLetter: '', workPlan: '', price: 500, deliveryDays: 5,
    aiMatchScore: null, aiFairPriceMin: null, aiFairPriceMax: null, aiPriceTag: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    attachments: [],
  };
}

async function loadService(t: TestContext, opts: { proposals?: ReturnType<typeof proposalFixture>[] } = {}) {
  const clientRequestFindFirstArgs: any[] = [];
  const prismaMock: any = {
    clientRequest: {
      findFirst: async (args: any) => {
        clientRequestFindFirstArgs.push(args);
        return {
          id: 'req-1',
          title: 'طلب تجريبي',
          description: 'وصف',
          status: 'OPEN',
          budgetType: 'FIXED',
          minBudget: 500,
          maxBudget: null,
          attachments: [],
          subSpecialties: [],
          expectedDurationDays: 14,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          aiAnalyzedSummary: null,
          aiComplexityRating: null,
          specialty: { id: 'spec-1', nameAr: 'تصميم', slug: 'design', category: { id: 'cat-1', nameAr: 'تصميم وإبداع', slug: 'design-cat' } },
          clientProfile: { user: { email: 'client@example.com', firstName: 'ع', lastName: 'م' } },
          proposals: opts.proposals ?? [],
        };
      },
    },
    projectProposal: { findMany: async () => [] },
    project: { groupBy: async () => [] },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./client-requests.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.clientRequestsService as { getRequestDetails: (userId: string, requestId: string) => Promise<any> }, clientRequestFindFirstArgs };
}

test('1) getRequestDetails returns the real canonical providerLevel on each proposal.provider', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ provider: providerFixture({ gamification: { points: 2100, currentLevelIndex: 9 } }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals[0].provider.providerLevel, 'خبير');
});

test('2) providerLevel is resolved via resolveProviderProgression() / PROVIDER_LEVEL_MATRIX — matches the exact real title for a given currentLevelIndex', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ provider: providerFixture({ gamification: { points: 1600, currentLevelIndex: 8 } }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals[0].provider.providerLevel, 'محترف');
});

test('3) the gamification row wins over a stale legacy currentLevel when both are present — canonical resolver precedence', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ provider: providerFixture({ currentLevel: 'مستوى قديم', gamification: { points: 2100, currentLevelIndex: 9 } }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals[0].provider.providerLevel, 'خبير');
});

test('4) a provider with no ProviderGamification row falls back to the canonical legacy currentLevel the resolver defines', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ provider: providerFixture({ currentLevel: 'مستوى قديم محفوظ', gamification: null }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals[0].provider.providerLevel, 'مستوى قديم محفوظ');
});

test('5) a provider with neither gamification nor legacy currentLevel returns providerLevel: null — never fabricated', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ provider: providerFixture({ currentLevel: null, gamification: null }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals[0].provider.providerLevel, null);
});

test('6a) an unverified provider (badge: \'محترف\') still resolves providerLevel purely from gamification, not from the colliding badge string', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ provider: providerFixture({ providerProfile: { headline: null, companyName: null, rating: 4.5, isVerified: false }, gamification: { points: 1600, currentLevelIndex: 8 } }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals[0].provider.badge, 'محترف'); // unaffected — still the unverified-accreditation label
  assert.equal(result.proposals[0].provider.providerLevel, 'محترف'); // happens to also be 'محترف' here, but from gamification index 8, not from badge
});

test('6b) flipping accreditation (badge: \'معتمد\') with the same gamification data produces the identical providerLevel — proves level is independent of badge', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ provider: providerFixture({ providerProfile: { headline: null, companyName: null, rating: 4.5, isVerified: true }, gamification: { points: 1600, currentLevelIndex: 8 } }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals[0].provider.badge, 'معتمد');
  assert.equal(result.proposals[0].provider.providerLevel, 'محترف'); // identical level regardless of accreditation
});

test('7) the accreditation badge field remains intact and unchanged in the response alongside the new providerLevel field', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ provider: providerFixture({ providerProfile: { headline: null, companyName: null, rating: 4.5, isVerified: true } }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals[0].provider.badge, 'معتمد');
  assert.ok('providerLevel' in result.proposals[0].provider);
});

test('8) no N+1: provider/gamification data is fetched in the SAME clientRequest.findFirst query, not one query per proposal', async t => {
  const providers = Array.from({ length: 3 }, (_, i) => providerFixture({ id: `p${i}`, gamification: { points: 100, currentLevelIndex: 1 } }));
  const { service, clientRequestFindFirstArgs } = await loadService(t, {
    proposals: providers.map((provider, i) => proposalFixture({ id: `prop-${i}`, providerId: provider.id, provider })),
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  assert.equal(result.proposals.length, 3);
  assert.equal(clientRequestFindFirstArgs.length, 1);
  const providerSelect = clientRequestFindFirstArgs[0].include.proposals.include.provider.select;
  assert.ok(providerSelect.gamification, 'gamification must be included inside the single clientRequest query');
  assert.ok(providerSelect.currentLevel, 'currentLevel must be included inside the single clientRequest query');
});

test('9) existing proposal/provider fields remain unchanged alongside the new providerLevel field', async t => {
  const { service } = await loadService(t, {
    proposals: [proposalFixture({ id: 'prop-9', provider: providerFixture({ id: 'provider-9', firstName: 'سارة', lastName: 'علي' }) })],
  });
  const result = await service.getRequestDetails('client-1', 'req-1');
  const proposal = result.proposals[0];
  assert.equal(proposal.id, 'prop-9');
  assert.equal(proposal.status, 'SUBMITTED');
  assert.equal(proposal.bidAmount, 500);
  assert.equal(proposal.deliveryDays, 5);
  assert.equal(proposal.provider.id, 'provider-9');
  assert.equal(proposal.provider.name, 'سارة علي');
  assert.ok('badge' in proposal.provider);
});
