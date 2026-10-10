import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.3A: rateRequest() already recalculated authoritative avgRating and
// mirrored it onto User.ratingAverage/ProviderGamification.avgRating. Since
// avgRating is one of the three LEVEL_MATRIX qualification gates, a rating
// change alone can move a provider's level even with no new points — so this
// now also re-derives points/completedProjects from their own authoritative
// sources and persists currentLevelIndex/currentCommission via the same
// shared pure helper, all inside the SAME existing transaction. The rating
// formula/Review semantics and User.currentLevel/currentPoints/
// pointsToNextLevel are untouched.

function createRateRequestMockPrisma(t: TestContext, opts: {
  avgRating: number;
  totalPoints?: number;
  completedProjectsCount?: number;
} = { avgRating: 0 }) {
  const contract = {
    id: 'contract-1',
    providerId: 'provider-1',
    clientId: 'client-1',
    projectId: 'project-1',
    status: 'COMPLETED',
    project: { id: 'project-1', status: 'COMPLETED' }
  };

  let userState: any = { id: 'provider-1', ratingAverage: 0 };
  let gamificationState: any = { providerId: 'provider-1', points: 0, completedProjects: 0, avgRating: 0, currentLevelIndex: 1, currentCommission: 15.0 };

  const userUpdateSpy = t.mock.fn((args: any) => { userState = { ...userState, ...args.data }; return { ...userState }; });
  const gamificationUpdateManySpy = t.mock.fn((args: any) => {
    gamificationState = { ...gamificationState, ...args.data };
    return { count: 1 };
  });
  const reviewCreateSpy = t.mock.fn(async (args: any) => ({ id: 'review-1', ...args.data }));

  const tx = {
    review: {
      create: reviewCreateSpy,
      aggregate: async () => ({ _avg: { rating: opts.avgRating } })
    },
    user: { update: userUpdateSpy },
    pointTransaction: { aggregate: async () => ({ _sum: { amount: opts.totalPoints ?? 0 } }) },
    project: { count: async () => opts.completedProjectsCount ?? 0 },
    providerGamification: { updateMany: gamificationUpdateManySpy }
  };

  const prismaMock = {
    clientRequest: { findUnique: async () => null },
    contract: { findUnique: async () => ({ ...contract }) },
    review: { findFirst: async () => null },
    $transaction: async (fn: any) => fn(tx)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return {
    userUpdateSpy, gamificationUpdateManySpy, reviewCreateSpy,
    getUserState: () => userState,
    getGamificationState: () => gamificationState
  };
}

async function loadRatingServiceWithFixture(t: TestContext, opts: Parameters<typeof createRateRequestMockPrisma>[1]) {
  const mocks = createRateRequestMockPrisma(t, opts);
  const moduleUrl = `./rating.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { ratingService } = await import(moduleUrl);
  return { ratingService, ...mocks };
}

test('rateRequest: recalculates authoritative avgRating from the live Review aggregate and mirrors it to User.ratingAverage', async (t) => {
  const { ratingService, userUpdateSpy } = await loadRatingServiceWithFixture(t, { avgRating: 4.2 });

  await ratingService.rateRequest('contract-1', 'client-1', 'client', { rating: 5, comment: 'ممتاز' });

  assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.ratingAverage, 4.2);
});

test('rateRequest: can promote a provider when a rating change makes all 3 thresholds newly satisfied', async (t) => {
  // points/completedProjects already clear level 2 (101/3); only avgRating was missing.
  const { ratingService, getGamificationState } = await loadRatingServiceWithFixture(t, {
    avgRating: 3.5, totalPoints: 101, completedProjectsCount: 3
  });

  await ratingService.rateRequest('contract-1', 'client-1', 'client', { rating: 4, comment: 'جيد جداً' });

  assert.equal(getGamificationState().currentLevelIndex, 2);
  assert.equal(getGamificationState().currentCommission, 4.8);
});

test('rateRequest: a dropped authoritative rating results in the correct lower qualified level', async (t) => {
  // points/completedProjects still clear level 2, but avgRating has now dropped below 3.5.
  const { ratingService, getGamificationState } = await loadRatingServiceWithFixture(t, {
    avgRating: 3.0, totalPoints: 101, completedProjectsCount: 3
  });

  await ratingService.rateRequest('contract-1', 'client-1', 'client', { rating: 2, comment: 'كان يمكن أن يكون أفضل' });

  assert.equal(getGamificationState().currentLevelIndex, 1);
});

test('rateRequest: ProviderGamification writes points/completedProjects/avgRating/currentLevelIndex/currentCommission together, all synchronized', async (t) => {
  const { ratingService, getGamificationState } = await loadRatingServiceWithFixture(t, {
    avgRating: 4.6, totalPoints: 1001, completedProjectsCount: 21
  });

  await ratingService.rateRequest('contract-1', 'client-1', 'client', { rating: 5 });

  const state = getGamificationState();
  assert.equal(state.points, 1001);
  assert.equal(state.completedProjects, 21);
  assert.equal(state.avgRating, 4.6);
  // Level 6 requires points>=1001, completedProjects>=21, avgRating>=4.2 — all met.
  assert.equal(state.currentLevelIndex, 6);
  assert.equal(state.currentCommission, 4.0);
});

test('rateRequest: never writes User.currentLevel/currentPoints/pointsToNextLevel', async (t) => {
  const { ratingService, userUpdateSpy } = await loadRatingServiceWithFixture(t, { avgRating: 4.0 });

  await ratingService.rateRequest('contract-1', 'client-1', 'client', { rating: 4 });

  for (const call of userUpdateSpy.mock.calls) {
    assert.equal('currentLevel' in call.arguments[0].data, false);
    assert.equal('currentPoints' in call.arguments[0].data, false);
    assert.equal('pointsToNextLevel' in call.arguments[0].data, false);
  }
});
