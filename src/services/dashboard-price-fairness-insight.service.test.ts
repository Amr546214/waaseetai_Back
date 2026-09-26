import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 7 — the client dashboard's "AI Insights" card was a
// fully static, hardcoded "96%" with a fixed Arabic sentence and zero
// backend behind it at all (client-overview.component.html). This replaces
// it with `priceFairnessInsight`: a deterministic aggregate of the client's
// own proposals' real, already-Gemini-computed `aiPriceTag` field (see
// ai-proposal.service.ts). This file is NOT calling Gemini — it only proves
// the aggregation logic in dashboard.service.ts::getClientStats.

async function loadService(t: TestContext, opts: { proposalsWithPriceTag?: Array<{ aiPriceTag: string }> } = {}) {
  const proposalFindManyArgs: any[] = [];
  const prismaMock: any = {
    project: {
      count: async () => 0,
      aggregate: async () => ({ _sum: { budgetFixed: 0, budgetMax: 0 } }),
      findMany: async () => [],
    },
    proposal: {
      count: async () => 0,
      findMany: async (args: any) => {
        // getClientStats calls proposal.findMany twice: once for
        // "latestProposals" (take: 3, no aiPriceTag filter) and once for
        // the new price-fairness aggregate (aiPriceTag: { not: null }).
        proposalFindManyArgs.push(args);
        if (args?.where?.aiPriceTag) {
          return opts.proposalsWithPriceTag ?? [];
        }
        return [];
      },
    },
    escrow: { aggregate: async () => ({ _sum: { amount: 0 } }) },
    user: { findUnique: async () => ({ activeRole: 'CLIENT', profileCompletionPercent: 0, currentLevel: null, currentPoints: 0, pointsToNextLevel: 100, clientProfile: null }) },
    contract: { findFirst: async () => null },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./dashboard.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.dashboardService as { getClientStats: (userId: string) => Promise<any> }, proposalFindManyArgs };
}

test('getClientStats: priceFairnessInsight is null when the client has zero proposals with AI price data yet (honest, not zero-fabricated)', async t => {
  const { service } = await loadService(t, { proposalsWithPriceTag: [] });
  const result = await service.getClientStats('client-1');
  assert.equal(result.priceFairnessInsight, null);
});

test('getClientStats: priceFairnessInsight computes a real percentage from the client\'s own real aiPriceTag values', async t => {
  const { service } = await loadService(t, {
    proposalsWithPriceTag: [
      { aiPriceTag: 'FAIR' },
      { aiPriceTag: 'FAIR' },
      { aiPriceTag: 'FAIR' },
      { aiPriceTag: 'UNDERPRICED' },
    ],
  });
  const result = await service.getClientStats('client-1');
  assert.deepEqual(result.priceFairnessInsight, {
    fairPricePercentage: 75,
    evaluatedOffersCount: 4,
    summaryText: '75% من عروضك المقيَّمة بالذكاء الاصطناعي ضمن النطاق العادل لأسعار السوق',
  });
});

test('getClientStats: priceFairnessInsight is 0% (not null) when every evaluated proposal is off-market, not a silently-omitted field', async t => {
  const { service } = await loadService(t, {
    proposalsWithPriceTag: [{ aiPriceTag: 'OVERPRICED' }, { aiPriceTag: 'UNDERPRICED' }],
  });
  const result = await service.getClientStats('client-1');
  assert.equal(result.priceFairnessInsight.fairPricePercentage, 0);
  assert.equal(result.priceFairnessInsight.evaluatedOffersCount, 2);
});

test('getClientStats: the aiPriceTag aggregate query is scoped to this client\'s own projects only', async t => {
  const { service, proposalFindManyArgs } = await loadService(t, { proposalsWithPriceTag: [] });
  await service.getClientStats('client-42');
  const aggregateQuery = proposalFindManyArgs.find(a => a?.where?.aiPriceTag);
  assert.ok(aggregateQuery, 'expected a proposal.findMany call filtering by aiPriceTag');
  assert.deepEqual(aggregateQuery.where.project, { clientId: 'client-42' });
  assert.deepEqual(aggregateQuery.where.aiPriceTag, { not: null });
});
