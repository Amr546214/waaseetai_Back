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
    providerGamification: { upsert: upsertSpy }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return { upsertSpy, createManySpy, getGamificationState: () => gamificationState };
}

async function loadGamificationServiceWithFixture(t: TestContext, opts: Parameters<typeof createGetLevelDetailsMockPrisma>[1]) {
  const mocks = createGetLevelDetailsMockPrisma(t, opts);
  const moduleUrl = `./gamification.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { gamificationService } = await import(moduleUrl);
  return { gamificationService, ...mocks };
}

test('getLevelDetails: the returned current level index equals the persisted ProviderGamification.currentLevelIndex', async (t) => {
  const { gamificationService, getGamificationState } = await loadGamificationServiceWithFixture(t, {
    completedProjects: 2, totalPoints: 50, avgRating: 3.5
  });

  const result = await gamificationService.getLevelDetails('provider-1');

  assert.equal(result.currentLevel.index, 2);
  assert.equal(getGamificationState().currentLevelIndex, 2);
  assert.equal(result.currentLevel.index, getGamificationState().currentLevelIndex);
});

test('getLevelDetails: the persisted currentCommission equals the returned qualified level\'s commission rate', async (t) => {
  const { gamificationService, getGamificationState } = await loadGamificationServiceWithFixture(t, {
    completedProjects: 20, totalPoints: 751, avgRating: 4.2
  });

  const result = await gamificationService.getLevelDetails('provider-1');

  assert.equal(result.currentStats.commissionRate, 4.0);
  assert.equal(getGamificationState().currentCommission, 4.0);
  assert.equal(result.currentStats.commissionRate, getGamificationState().currentCommission);
});

test('getLevelDetails: max level resolves without any hardcoded max-index dependency (matrix-derived)', async (t) => {
  const { gamificationService, getGamificationState } = await loadGamificationServiceWithFixture(t, {
    completedProjects: 150, totalPoints: 7201, avgRating: 4.9
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
