import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Batch 5 (completion pass) — the Client dashboard's "latest offers" card
// used to fabricate a provider level from the card's array index
// (getLevelBadgeStyle/getLevelColor/getLevelLabel — removed on the
// frontend). This proves the real replacement: getClientStats::
// latestProposals now carries a real `providerLevel`, resolved via the same
// resolveProviderProgression()/PROVIDER_LEVEL_MATRIX source
// marketplace-service.service.ts already uses — included in the existing
// proposal.findMany query (no extra per-row DB call), never fabricated from
// index/rating/AI score/the accreditation `badge` field.

type ProviderFixture = { firstName: string; lastName: string; currentLevel: string | null; gamification: { points: number; currentLevelIndex: number } | null };

function proposalFixture(overrides: Partial<{ id: string; projectId: string; price: number; deliveryDays: number; aiMatchScore: number | null; status: string; createdAt: Date; provider: ProviderFixture }> = {}) {
  return {
    id: overrides.id ?? 'prop-1',
    projectId: overrides.projectId ?? 'proj-1',
    project: { title: 'مشروع تجريبي' },
    price: overrides.price ?? 500,
    deliveryDays: overrides.deliveryDays ?? 5,
    aiMatchScore: overrides.aiMatchScore ?? 80,
    status: overrides.status ?? 'PENDING',
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    provider: overrides.provider ?? { firstName: 'أحمد', lastName: 'محمد', currentLevel: null, gamification: null },
  };
}

async function loadService(t: TestContext, opts: { latestProposals?: ReturnType<typeof proposalFixture>[] } = {}) {
  const proposalFindManyCalls: any[] = [];
  const prismaMock: any = {
    project: {
      count: async () => 0,
      aggregate: async () => ({ _sum: { budgetFixed: 0, budgetMax: 0 } }),
      findMany: async () => [],
    },
    proposal: {
      count: async () => 0,
      findMany: async (args: any) => {
        proposalFindManyCalls.push(args);
        if (args?.where?.aiPriceTag) return [];
        return opts.latestProposals ?? [];
      },
    },
    escrow: { aggregate: async () => ({ _sum: { amount: 0 } }) },
    user: { findUnique: async () => ({ activeRole: 'CLIENT', profileCompletionPercent: 0, currentLevel: null, currentPoints: 0, pointsToNextLevel: 100, clientProfile: null }) },
    contract: { findFirst: async () => null },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./dashboard.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.dashboardService as { getClientStats: (userId: string) => Promise<any> }, proposalFindManyCalls };
}

test('1) latestProposals returns the real providerLevel resolved from ProviderGamification.currentLevelIndex via the canonical matrix', async t => {
  const { service } = await loadService(t, {
    latestProposals: [proposalFixture({ provider: { firstName: 'أحمد', lastName: 'محمد', currentLevel: null, gamification: { points: 2100, currentLevelIndex: 9 } } })],
  });
  const result = await service.getClientStats('client-1');
  assert.equal(result.latestProposals[0].providerLevel, 'خبير');
});

test('2) two proposals from the same provider progression data return the same level', async t => {
  const sameProvider: ProviderFixture = { firstName: 'سارة', lastName: 'علي', currentLevel: null, gamification: { points: 1600, currentLevelIndex: 8 } };
  const { service } = await loadService(t, {
    latestProposals: [
      proposalFixture({ id: 'p1', provider: sameProvider }),
      proposalFixture({ id: 'p2', provider: sameProvider }),
    ],
  });
  const result = await service.getClientStats('client-1');
  assert.equal(result.latestProposals[0].providerLevel, result.latestProposals[1].providerLevel);
  assert.equal(result.latestProposals[0].providerLevel, 'محترف');
});

const PROVIDER_A: ProviderFixture = { firstName: 'أحمد', lastName: 'م', currentLevel: null, gamification: { points: 2100, currentLevelIndex: 9 } };
const PROVIDER_B: ProviderFixture = { firstName: 'سارة', lastName: 'ع', currentLevel: null, gamification: { points: 60, currentLevelIndex: 2 } };

test('3a) proposal order [A, B] resolves each provider to its own real level', async t => {
  const { service } = await loadService(t, {
    latestProposals: [proposalFixture({ id: 'a', provider: PROVIDER_A }), proposalFixture({ id: 'b', provider: PROVIDER_B })],
  });
  const result = await service.getClientStats('client-1');
  const levelById = (id: string) => result.latestProposals.find((p: any) => p.id === id).providerLevel;
  assert.equal(levelById('a'), 'خبير');
  assert.equal(levelById('b'), 'منجز');
});

test('3b) reversing the same proposals to order [B, A] does not change either provider\'s resolved level — index cannot alter providerLevel', async t => {
  const { service } = await loadService(t, {
    latestProposals: [proposalFixture({ id: 'b', provider: PROVIDER_B }), proposalFixture({ id: 'a', provider: PROVIDER_A })],
  });
  const result = await service.getClientStats('client-1');
  const levelById = (id: string) => result.latestProposals.find((p: any) => p.id === id).providerLevel;
  assert.equal(levelById('a'), 'خبير');
  assert.equal(levelById('b'), 'منجز');
});

test('4) different provider progression produces the corresponding different real level', async t => {
  const { service } = await loadService(t, {
    latestProposals: [
      proposalFixture({ id: 'p1', provider: { firstName: 'أ', lastName: 'ب', currentLevel: null, gamification: { points: 0, currentLevelIndex: 1 } } }),
      proposalFixture({ id: 'p2', provider: { firstName: 'ج', lastName: 'د', currentLevel: null, gamification: { points: 7300, currentLevelIndex: 15 } } }),
    ],
  });
  const result = await service.getClientStats('client-1');
  assert.equal(result.latestProposals[0].providerLevel, 'مبتدئ');
  assert.equal(result.latestProposals[1].providerLevel, 'مرجع');
});

test('5) a provider with no ProviderGamification row uses the canonical legacy currentLevel fallback the resolver defines', async t => {
  const { service } = await loadService(t, {
    latestProposals: [proposalFixture({ provider: { firstName: 'خالد', lastName: 'س', currentLevel: 'مستوى قديم محفوظ', gamification: null } })],
  });
  const result = await service.getClientStats('client-1');
  assert.equal(result.latestProposals[0].providerLevel, 'مستوى قديم محفوظ');
});

test('6) a provider with neither a gamification row nor a legacy currentLevel returns null — never a fabricated level', async t => {
  const { service } = await loadService(t, {
    latestProposals: [proposalFixture({ provider: { firstName: 'نورة', lastName: 'ح', currentLevel: null, gamification: null } })],
  });
  const result = await service.getClientStats('client-1');
  assert.equal(result.latestProposals[0].providerLevel, null);
});

test('6b) an empty-string legacy currentLevel (not just null) also resolves to null, not an empty badge', async t => {
  const { service } = await loadService(t, {
    latestProposals: [proposalFixture({ provider: { firstName: 'نورة', lastName: 'ح', currentLevel: '   ', gamification: null } })],
  });
  const result = await service.getClientStats('client-1');
  assert.equal(result.latestProposals[0].providerLevel, null);
});

test('7) providerLevel is derived only from gamification/currentLevel — the query never selects or uses an accreditation badge field', async t => {
  const { service, proposalFindManyCalls } = await loadService(t, {
    latestProposals: [proposalFixture({ provider: { firstName: 'أحمد', lastName: 'م', currentLevel: null, gamification: { points: 2100, currentLevelIndex: 9 } } })],
  });
  await service.getClientStats('client-1');
  const latestProposalsQuery = proposalFindManyCalls.find(a => !a?.where?.aiPriceTag);
  assert.ok(latestProposalsQuery, 'expected the latestProposals query to run');
  assert.deepEqual(Object.keys(latestProposalsQuery.include.provider.select).sort(), ['currentLevel', 'firstName', 'gamification', 'lastName'].sort());
  assert.equal('badge' in latestProposalsQuery.include.provider.select, false);
});

test('8) no N+1: provider/gamification data is fetched in the SAME proposal.findMany call, not one query per proposal', async t => {
  const providers: ProviderFixture[] = Array.from({ length: 3 }, (_, i) => ({ firstName: `p${i}`, lastName: 'x', currentLevel: null, gamification: { points: 100 * i, currentLevelIndex: 1 } }));
  const { service, proposalFindManyCalls } = await loadService(t, {
    latestProposals: providers.map((provider, i) => proposalFixture({ id: `p${i}`, provider })),
  });
  const result = await service.getClientStats('client-1');
  assert.equal(result.latestProposals.length, 3);
  // Only the 2 pre-existing proposal.findMany calls (latestProposals + the
  // price-fairness aggregate) — no third/fourth call added per provider.
  assert.equal(proposalFindManyCalls.length, 2);
  const latestProposalsQuery = proposalFindManyCalls.find(a => !a?.where?.aiPriceTag);
  assert.ok(latestProposalsQuery.include.provider.select.gamification, 'gamification must be included inside the single proposal query');
});

test('9) existing latestProposals fields remain unchanged alongside the new providerLevel field', async t => {
  const { service } = await loadService(t, {
    latestProposals: [proposalFixture({ id: 'p1', projectId: 'proj-9', price: 750, deliveryDays: 3, aiMatchScore: 91, status: 'ACCEPTED' })],
  });
  const result = await service.getClientStats('client-1');
  const proposal = result.latestProposals[0];
  assert.equal(proposal.id, 'p1');
  assert.equal(proposal.projectId, 'proj-9');
  assert.equal(proposal.projectTitle, 'مشروع تجريبي');
  assert.equal(proposal.price, 750);
  assert.equal(proposal.deliveryDays, 3);
  assert.equal(proposal.aiMatchScore, 91);
  assert.equal(proposal.providerName, 'أحمد محمد');
  assert.equal(proposal.status, 'ACCEPTED');
  assert.ok(proposal.createdAt);
  assert.ok('providerLevel' in proposal);
});
