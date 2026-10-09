import { test, mock, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MetricSummaryEngine } from './metric-summary';

const llmOk = (calls: any[]) => ({ generateJson: async (o: any) => { calls.push(o); return { data: { summary: 'ملخص', observations: [{ text: 'عدد الطلبات 4', basedOn: ['totals.requests'] }], recommendations: [] }, usage: { tokensIn: 1, tokensOut: 1 }, source: 'LLM' as const }; } });
const llmMissing = { generateJson: async () => { throw Object.assign(new Error('x'), { code: 'NOT_CONFIGURED' }); } };

const req = (i: number, over: any = {}) => ({ id: `secret-id-${i}`, title: `عنوان سري ${i}`, minBudget: 100, maxBudget: 500, status: 'OPEN', createdAt: new Date(), specialty: { nameAr: 'تصميم' }, proposals: [], ...over });

const state: { requests: any[]; reviews: any[] } = { requests: [], reviews: [] };
mock.module('../../config/db', { namedExports: { prisma: {
  clientProfile: { findUnique: async () => ({ id: 'cp-1' }) },
  clientRequest: { findMany: async () => state.requests },
  project: { findMany: async () => [] },
  review: { findMany: async () => state.reviews },
  dispute: { findMany: async () => [] },
  walletTransaction: { findMany: async () => [{ id: 'tx-secret', amount: 5 }] },
  escrow: { aggregate: async () => ({ _sum: { amount: null } }) },
} } });

async function load(_t: TestContext, o: { requests?: any[]; reviews?: any[] } = {}) {
  state.requests = o.requests ?? []; state.reviews = o.reviews ?? [];
  return import('./client-reports-summary.service');
}

test('READY with enough requests; only allowlisted numbers/labels reach the model', async (t) => {
  const m = await load(t, { requests: [req(1), req(2), req(3, { status: 'COMPLETED' }), req(4)], reviews: [{ rating: 4, createdAt: new Date() }] });
  const calls: any[] = [];
  const r = await m.summariseClientReports('u1', 'all', new MetricSummaryEngine(llmOk(calls) as any));
  assert.equal(r.status, 'READY'); assert.equal(r.source, 'GEMINI'); assert.equal(r.score, null);
  assert.equal(calls[0].feature, 'client-reports-summary');
  assert.equal(calls[0].input.period, 'كل الفترات');
  assert.equal(calls[0].input.totals.requests, 4);
  assert.deepEqual(calls[0].input.acceptanceBySpecialty, [{ specialty: 'تصميم', requests: 4, acceptanceRatePercent: 25 }]);
  assert.doesNotMatch(JSON.stringify(calls[0].input), /secret|tx-|cp-1|u1/);
});

test('NOT_ENOUGH_DATA below the request threshold: model never called', async (t) => {
  const m = await load(t, { requests: [req(1), req(2)] });
  const calls: any[] = [];
  const r = await m.summariseClientReports('u1', 'all', new MetricSummaryEngine(llmOk(calls) as any));
  assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(r.summary, null); assert.equal(calls.length, 0);
  assert.equal(m.CLIENT_REPORTS_MIN_REQUESTS, 3);
});

test('FAILED when the model is NOT_CONFIGURED: null fields, no throw', async (t) => {
  const m = await load(t, { requests: [req(1), req(2), req(3)] });
  const r = await m.summariseClientReports('u1', 'month', new MetricSummaryEngine(llmMissing as any));
  assert.equal(r.status, 'FAILED'); assert.equal(r.summary, null); assert.equal(r.details, null); assert.equal(r.score, null); assert.equal(r.confidence, null);
});

test('missing is null, never 0: empty data yields null totals, rating/spend null without reviews/completions', async (t) => {
  const m = await load(t);
  const empty = m.buildClientReportsMetrics(await (await import('../client-reports.service')).clientReportsService.getReports('u1', 'all'), 'all');
  assert.equal(empty.totals.requests, null); assert.equal(empty.totals.avgRating, null); assert.equal(empty.totals.totalSpent, null); assert.equal(empty.totals.disputes, null);
  const m2 = await load(t, { requests: [req(1), req(2), req(3)] });
  const calls: any[] = [];
  await m2.summariseClientReports('u1', 'all', new MetricSummaryEngine(llmOk(calls) as any));
  assert.equal(calls[0].input.totals.avgRating, null); assert.equal(calls[0].input.totals.totalSpent, null);
});

test('route wiring: /ai-summary behind authenticate, requireActiveUser and aiLimiter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'client-reports.routes.ts'), 'utf8');
  assert.ok(src.includes("router.get('/ai-summary', authenticate, requireActiveUser, aiLimiter, clientReportsAiSummary);"));
  assert.ok(src.includes("router.get('/', authenticate, requireActiveUser, clientReportsController.getReports);"));
});
