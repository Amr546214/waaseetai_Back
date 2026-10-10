import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.3A: getLevelDetails() previously computed the correct 3-D level
// in memory but only ever persisted points/completedProjects/avgRating to
// ProviderGamification — currentLevelIndex/currentCommission stayed frozen
// at their creation-time defaults forever, so this endpoint's *returned*
// level could permanently disagree with the persisted row every other
// provider-facing display (Phase 3C's role-display-resolver) trusts. It now
// reuses the shared deriveProviderProgression() helper and persists
// currentLevelIndex/currentCommission too, so the two can never disagree
// again. Response contract (currentStats/currentLevel/nextLevelProgress/
// aiRecommendation/roadmap/pointRules) is unchanged.

function createGetLevelDetailsMockPrisma(t: TestContext, opts: {
  completedProjects: number;
  totalPoints: number;
  avgRating: number;
  existingRules?: any[];
  clientPoints?: number;
}) {
  let gamificationState: any = null;
  const upsertSpy = t.mock.fn((args: any) => {
    gamificationState = gamificationState ? { ...gamificationState, ...args.update } : { ...args.create };
    return { ...gamificationState };
  });
  let rules = opts.existingRules ?? [];
  const createManySpy = t.mock.fn(async (args: any) => { rules = args.data.map((r: any, i: number) => ({ id: `rule-${i}`, ...r })); return { count: rules.length }; });

  const prismaMock = {
    project: { count: async () => opts.completedProjects },
    pointTransaction: { aggregate: async () => ({ _sum: { amount: opts.totalPoints } }) },
    review: { aggregate: async () => ({ _avg: { rating: opts.avgRating } }) },
    gamificationRule: {
      findMany: async () => rules,
      createMany: createManySpy
    },
    providerGamification: { upsert: upsertSpy },
    clientProfile: { findUnique: async () => ({ currentPoints: opts.clientPoints ?? 0 }) }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return { upsertSpy, createManySpy, getGamificationState: () => gamificationState };
}

async function loadGamificationServiceWithFixture(t: TestContext, opts: Parameters<typeof createGetLevelDetailsMockPrisma>[1]) {
  const mocks = createGetLevelDetailsMockPrisma(t, opts);
  const moduleUrl = `./gamification.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { gamificationService, getClientLevelDetails } = await import(moduleUrl);
  return { gamificationService, getClientLevelDetails, ...mocks };
}

test('getLevelDetails: the returned current level index equals the persisted ProviderGamification.currentLevelIndex', async (t) => {
  const { gamificationService, getGamificationState } = await loadGamificationServiceWithFixture(t, {
    completedProjects: 3, totalPoints: 101, avgRating: 3.5
  });

  const result = await gamificationService.getLevelDetails('provider-1');

  assert.equal(result.currentLevel.index, 2);
  assert.equal(getGamificationState().currentLevelIndex, 2);
  assert.equal(result.currentLevel.index, getGamificationState().currentLevelIndex);
});

test('getLevelDetails: the persisted currentCommission equals the returned qualified level\'s commission rate', async (t) => {
  const { gamificationService, getGamificationState } = await loadGamificationServiceWithFixture(t, {
    completedProjects: 21, totalPoints: 1001, avgRating: 4.2
  });

  const result = await gamificationService.getLevelDetails('provider-1');

  assert.equal(result.currentStats.commissionRate, 4.0);
  assert.equal(getGamificationState().currentCommission, 4.0);
  assert.equal(result.currentStats.commissionRate, getGamificationState().currentCommission);
});

test('getLevelDetails: max level resolves without any hardcoded max-index dependency (matrix-derived)', async (t) => {
  const { gamificationService, getGamificationState } = await loadGamificationServiceWithFixture(t, {
    completedProjects: 211, totalPoints: 12001, avgRating: 4.9
  });

  const result = await gamificationService.getLevelDetails('provider-1');

  assert.equal(result.currentLevel.index, 15);
  assert.equal(result.nextLevelProgress.pointsGap, 0);
  assert.equal(result.aiRecommendation.includes('أعلى مستوى'), true);
  assert.equal(getGamificationState().currentLevelIndex, 15);
});

test('getLevelDetails: existing gain/loss rule seeding and response formatting is unchanged', async (t) => {
  const { gamificationService, createManySpy } = await loadGamificationServiceWithFixture(t, {
    completedProjects: 0, totalPoints: 0, avgRating: 0, existingRules: []
  });

  const result = await gamificationService.getLevelDetails('provider-1');

  assert.equal(createManySpy.mock.callCount(), 1); // empty rules table seeded, as before
  const gainLabels = result.pointRules.gainRules.map((r: any) => r.label);
  assert.equal(gainLabels.includes('إكمال مشروع بنجاح'), true);
  const projectCompleteRule = result.pointRules.gainRules.find((r: any) => r.label === 'إكمال مشروع بنجاح');
  assert.equal(projectCompleteRule.points, '+50 نقطة');
  assert.equal(result.pointRules.lossRules.length > 0, true);
});

test('provider roadmap: 15 levels from the single ladder, each with its station colour (dark/light); the current one is flagged', async (t) => {
  const { gamificationService } = await loadGamificationServiceWithFixture(t, { completedProjects: 3, totalPoints: 101, avgRating: 3.5 });
  const r = await gamificationService.getLevelDetails('provider-1');
  assert.equal(r.roadmap.length, 15);
  assert.deepEqual(r.roadmap.map((l: any) => l.title).slice(0, 3), ['مبتدئ', 'منجز', 'منفذ']);
  assert.equal(r.roadmap[0].color.dark, '#94DEF9');
  assert.equal(r.roadmap[14].color.light, '#07108D');
  assert.equal(r.roadmap.filter((l: any) => l.isCurrent).length, 1);
  assert.equal(r.roadmap.find((l: any) => l.isCurrent).index, 2);
  assert.equal(r.currentStats.commissionRate, 4.8);
  assert.equal(r.nextLevelProgress.nextCommission, 4.6);
});

test('the recommendation text uses only real gaps and level names: no invented point values, no stale "مستكشف after 50 points"', async (t) => {
  const first = await loadGamificationServiceWithFixture(t, { completedProjects: 0, totalPoints: 0, avgRating: 0 });
  const a = await first.gamificationService.getLevelDetails('provider-1');
  assert.match(a.aiRecommendation, /منجز/);
  assert.doesNotMatch(a.aiRecommendation, /50 نقطة|مستكشف|\+15|\+10/);
});

test('the recommendation names what is really left (projects, points, rating) for the next level', async (t) => {
  const { gamificationService } = await loadGamificationServiceWithFixture(t, { completedProjects: 3, totalPoints: 101, avgRating: 3.5 });
  const r = await gamificationService.getLevelDetails('provider-1');
  assert.match(r.aiRecommendation, /منفذ/);
  assert.match(r.aiRecommendation, /3 مشروعًا إضافيًا/);
  assert.match(r.aiRecommendation, /150 نقطة/);
  assert.match(r.aiRecommendation, /3\.8/);
  assert.doesNotMatch(r.aiRecommendation, /\+15|\+10/);
});

test('client level view: level 1 "زائر" with 1% cashback for a new client, the whole 15-level client ladder, and the honest limitations (no fake progress)', async (t) => {
  const { getClientLevelDetails } = await loadGamificationServiceWithFixture(t, { completedProjects: 0, totalPoints: 0, avgRating: 0, clientPoints: 0 });
  const r = await getClientLevelDetails('client-1');
  assert.deepEqual([r.currentLevel.index, r.currentLevel.title, r.currentStats.cashbackRate], [1, 'زائر', 1]);
  assert.equal(r.roadmap.length, 15);
  assert.equal(r.roadmap[0].color.dark, '#97F7C7');
  assert.deepEqual([r.nextLevelProgress.title, r.nextLevelProgress.pointsGap, r.nextLevelProgress.projectsGap, r.nextLevelProgress.nextCashbackRate], ['مستكشف', 51, 2, 1.5]);
  assert.equal(r.currentStats.avgRating, null);
  assert.deepEqual(r.limitations, ['CLIENT_POINTS_NOT_AWARDED', 'CLIENT_RATING_NOT_AVAILABLE', 'CASHBACK_NOT_CREDITED_YET']);
});
