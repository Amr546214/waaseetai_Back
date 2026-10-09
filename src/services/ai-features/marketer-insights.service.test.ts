import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MetricSummaryEngine } from './metric-summary';

const llmOk = (calls: any[]) => ({ generateJson: async (o: any) => { calls.push(o); return { data: { summary: 'ملخص', observations: [{ text: 'قناة X', basedOn: ['channels'] }], recommendations: [] }, usage: { tokensIn: 1, tokensOut: 1 }, source: 'LLM' as const }; } });
const llmMissing = { generateJson: async () => { throw Object.assign(new Error('x'), { code: 'NOT_CONFIGURED' }); } };

async function load(t: TestContext, o: { channels?: any[]; groups?: any[]; commissions?: any[]; count?: number } = {}) {
  const prisma = {
    affiliateProfile: { findUnique: async () => ({ id: 'aff-secret', currentLevel: 'L1', referralSlug: 's', referrals: [], commissionLogs: o.commissions ?? [], channelMetrics: o.channels ?? [] }) },
    referral: { groupBy: async () => o.groups ?? [], count: async () => o.count ?? 0 },
  };
  t.mock.module('../../config/db', { namedExports: { prisma } });
  const { MarketerOverviewService } = await import(`../marketer-overview.service.ts?f=${Date.now()}-${Math.random()}`);
  return new MarketerOverviewService();
}

test('READY: channels, referral statuses, commissions and trend reach the model; no ids', async (t) => {
  const svc = await load(t, { channels: [{ channel: 'X_TWITTER', visitors: 50, conversionPercentage: 4, id: 'chan-secret', clients: 2 }], groups: [{ status: 'CONVERTED', _count: { _all: 2 } }, { status: 'PENDING', _count: { _all: 3 } }], commissions: [{ amount: 10 }, { amount: 15 }], count: 1 });
  const calls: any[] = [];
  const r = await svc.getAiInsights('u1', new MetricSummaryEngine(llmOk(calls) as any));
  assert.equal(r.status, 'READY'); assert.equal(r.score, null);
  assert.equal(calls[0].feature, 'marketer-insights');
  assert.deepEqual(calls[0].input.channels, [{ channel: 'X_TWITTER', visitors: 50, conversionPercentage: 4 }]);
  assert.deepEqual(calls[0].input.referrals.byStatus, [{ status: 'CONVERTED', count: 2 }, { status: 'PENDING', count: 3 }]);
  assert.equal(calls[0].input.referrals.total, 5);
  assert.deepEqual(calls[0].input.commissions, { approvedCount: 2, approvedTotal: 25 });
  assert.doesNotMatch(JSON.stringify(calls[0].input), /secret|u1/);
});

test('NOT_ENOUGH_DATA: no channels and fewer than 3 referrals -> model never called; nulls not 0', async (t) => {
  const svc = await load(t, { groups: [{ status: 'PENDING', _count: { _all: 2 } }] });
  const calls: any[] = [];
  const r = await svc.getAiInsights('u1', new MetricSummaryEngine(llmOk(calls) as any));
  assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(r.summary, null); assert.equal(calls.length, 0);
  const m = (await import('./marketer-insights.service')).buildMarketerInsightsMetrics({ channels: [], referralsByStatus: [], referralsLast30Days: 0, referralsPrevious30Days: 0, approvedCommissionAmounts: [] });
  assert.equal(m.referrals.total, null); assert.equal(m.referrals.last30Days, null); assert.equal(m.commissions.approvedTotal, null); assert.equal(m.commissions.approvedCount, null);
});

test('enough data via >=3 referrals alone', async (t) => {
  const svc = await load(t, { groups: [{ status: 'PENDING', _count: { _all: 3 } }] });
  const r = await svc.getAiInsights('u1', new MetricSummaryEngine(llmOk([]) as any));
  assert.equal(r.status, 'READY');
});

test('FAILED when the model is NOT_CONFIGURED', async (t) => {
  const svc = await load(t, { channels: [{ channel: 'TIKTOK', visitors: 5, conversionPercentage: 1 }] });
  const r = await svc.getAiInsights('u1', new MetricSummaryEngine(llmMissing as any));
  assert.equal(r.status, 'FAILED'); assert.equal(r.summary, null); assert.equal(r.details, null); assert.equal(r.confidence, null);
});

test('route wiring and old rule-based generator removed', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'marketer-overview.routes.ts'), 'utf8');
  assert.ok(routes.includes("router.get('/ai-insights', aiLimiter, marketerOverviewController.getAiInsights);"));
  assert.match(routes, /router\.use\(authenticate, requireActiveUser\);\s*router\.use\(authorize\('MARKETING_BROKER'\)\);/);
  const svc = fs.readFileSync(path.join(__dirname, '..', 'marketer-overview.service.ts'), 'utf8');
  assert.doesNotMatch(svc, /ابدأ ببوست تفاعلي|تحقق أفضل معدل تحويل/);
});
