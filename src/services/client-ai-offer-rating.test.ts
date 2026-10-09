import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { computeClientAiOfferRating } from './client-ai-offer-rating';

test('no scored offers -> aiRating null, source none, no confidence (never 0 or a made-up number)', () => {
  assert.deepEqual(computeClientAiOfferRating([]), { aiRating: null, aiConfidence: null, aiRatingSource: 'none', aiRatingUpdatedAt: null, aiRatedOffersCount: 0 });
  assert.equal(computeClientAiOfferRating([{ aiMatchScore: null, createdAt: new Date() }]).aiRating, null);
});

test('the rating is the average real score as stars out of 5 (score / 20), one decimal, with count and latest date', () => {
  const r = computeClientAiOfferRating([
    { aiMatchScore: 90, createdAt: new Date('2026-10-01T10:00:00Z') },
    { aiMatchScore: 80, createdAt: new Date('2026-10-05T10:00:00Z') },
    { aiMatchScore: null, createdAt: new Date('2026-10-09T10:00:00Z') },
  ]);
  assert.equal(r.aiRating, 4.3); // (90+80)/2 = 85 -> 4.25 -> 4.3
  assert.equal(r.aiRatedOffersCount, 2);
  assert.equal(r.aiRatingSource, 'waseet_ai_offer_quality');
  assert.equal(r.aiRatingUpdatedAt, '2026-10-05T10:00:00.000Z');
  assert.equal(r.aiConfidence, null); // WaseetAI reports no accuracy: none is claimed
});

test('out-of-range / non-numeric scores are ignored', () => {
  const r = computeClientAiOfferRating([{ aiMatchScore: 150, createdAt: new Date() }, { aiMatchScore: -5, createdAt: new Date() }, { aiMatchScore: NaN, createdAt: new Date() }, { aiMatchScore: 100, createdAt: new Date() }]);
  assert.equal(r.aiRating, 5);
  assert.equal(r.aiRatedOffersCount, 1);
});

async function loadService(t: TestContext, scored: Array<{ aiMatchScore: number; createdAt: Date }>) {
  const findManyCalls: any[] = [];
  const prismaMock: any = {
    project: { count: async () => 0, aggregate: async () => ({ _sum: { budgetFixed: 0, budgetMax: 0 } }), findMany: async () => [] },
    proposal: { count: async () => 0, findMany: async (args: any) => { findManyCalls.push(args); return args?.where?.aiMatchScore ? scored : []; } },
    escrow: { aggregate: async () => ({ _sum: { amount: 0 } }) },
    user: { findUnique: async () => ({ activeRole: 'CLIENT', profileCompletionPercent: 0, currentLevel: null, currentPoints: 0, pointsToNextLevel: 100, clientProfile: null }) },
    contract: { findFirst: async () => null },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const mod = await import(`./dashboard.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service: mod.dashboardService as { getClientStats: (id: string) => Promise<any> }, findManyCalls };
}

test('getClientStats: summary carries the real AI offer rating fields from the client\'s own scored proposals', async t => {
  const { service, findManyCalls } = await loadService(t, [{ aiMatchScore: 96, createdAt: new Date('2026-10-02T00:00:00Z') }, { aiMatchScore: 92, createdAt: new Date('2026-10-03T00:00:00Z') }]);
  const r = await service.getClientStats('client-1');
  assert.equal(r.summary.aiRating, 4.7);
  assert.equal(r.summary.aiRatedOffersCount, 2);
  assert.equal(r.summary.aiRatingSource, 'waseet_ai_offer_quality');
  assert.equal(r.summary.aiConfidence, null);
  assert.equal(r.summary.aiRatingUpdatedAt, '2026-10-03T00:00:00.000Z');
  const q = findManyCalls.find(a => a?.where?.aiMatchScore);
  assert.deepEqual(q.where, { project: { clientId: 'client-1' }, aiMatchScore: { not: null } });
});

test('getClientStats: a client with no AI-scored offers gets aiRating null (not 0)', async t => {
  const { service } = await loadService(t, []);
  const r = await service.getClientStats('client-1');
  assert.equal(r.summary.aiRating, null);
  assert.equal(r.summary.aiRatingSource, 'none');
  assert.equal(r.summary.aiRatedOffersCount, 0);
});
