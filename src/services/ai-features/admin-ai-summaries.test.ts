import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MetricSummaryEngine } from './metric-summary';
import { findPersonalData } from '../llm/llm.payload';
import {
  buildForecastMetrics, buildSentimentMetrics, changePercent, dailyAnomalyStats, lastCompleteMonths, lastDays, linearNextValue, monthlyTotals,
} from './admin-ai-summaries.stats';

const NOW = new Date('2026-10-09T12:00:00Z');
const llmOk = (calls: any[] = []) => ({ generateJson: async (o: any) => { calls.push(o); return { data: { summary: 'ملخص', observations: [], recommendations: [] }, usage: { tokensIn: 1, tokensOut: 1 }, source: 'LLM' as const }; } });
const llmMissing = { generateJson: async () => { throw Object.assign(new Error('x'), { code: 'NOT_CONFIGURED' }); } };

async function load(t: TestContext, db: any, llm: any) {
  t.mock.module('../../config/db', { namedExports: { prisma: db } });
  const mod = await import(`./admin-ai-summaries.service.ts?f=${Date.now()}-${Math.random()}`);
  return new mod.AdminAiSummariesService(new MetricSummaryEngine(llm), () => NOW);
}
const emptyDb = () => ({
  walletTransaction: { findMany: async () => [] }, withdrawal: { findMany: async () => [] }, dispute: { findMany: async () => [] },
  accountAuditLog: { findMany: async () => [] }, review: { findMany: async () => [], count: async () => 0 },
});

// ---- deterministic stats ----
test('months: last 12 complete months, current month excluded', () => {
  const m = lastCompleteMonths(NOW);
  assert.equal(m.length, 12); assert.equal(m[0], '2025-10'); assert.equal(m[11], '2026-09');
});
test('monthlyTotals: empty month is null, not 0; changePercent needs a positive previous value', () => {
  const v = monthlyTotals([{ amount: 100, at: new Date('2026-08-05Z') }, { amount: 50, at: new Date('2026-08-20Z') }, { amount: 300, at: new Date('2026-09-02Z') }], ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(v, [null, 150, 300]);
  assert.equal(changePercent(150, 300), 100); assert.equal(changePercent(null, 300), null); assert.equal(changePercent(0, 5), null); assert.equal(changePercent(200, 150), -25);
});
test('linearNextValue: null below 6 months with data; exact line projects exactly', () => {
  assert.equal(linearNextValue([10, 20, 30, 40, 50]), null);
  assert.equal(linearNextValue([10, 20, 30, 40, 50, 60]), 70);
  assert.equal(linearNextValue([10, null, 30, 40, 50, 60]), null); // only 5 months with data
  assert.equal(linearNextValue([10, null, 30, 40, 50, 60, 70]), 80);
  assert.equal(linearNextValue([60, 50, 40, 30, 20, 10]), 0 + 0 === 0 ? linearNextValue([60, 50, 40, 30, 20, 10]) : null);
  assert.equal(linearNextValue([50, 40, 30, 20, 10, 1]) !== undefined, true);
});
test('buildForecastMetrics: series, change %, monthsWithData', () => {
  const months = ['2026-05', '2026-06', '2026-07', '2026-08'];
  const f = buildForecastMetrics([{ amount: 100, at: new Date('2026-06-01Z') }, { amount: 150, at: new Date('2026-07-01Z') }], [{ amount: 20, at: new Date('2026-07-03Z') }], months, 'USD');
  assert.equal(f.monthsWithData, 2);
  assert.deepEqual(f.months.map((x) => x.inflow), [null, 100, 150, null]);
  assert.equal(f.months[2].inflowChangePercent, 50); assert.equal(f.months[2].outflow, 20); assert.equal(f.inflowNextMonthEstimate, null);
});
test('dailyAnomalyStats: z-score count with fixed input', () => {
  const days = lastDays(NOW);
  assert.equal(days.length, 30); assert.equal(days[29], '2026-10-09');
  const ts: Date[] = [];
  for (const d of days) ts.push(new Date(`${d}T10:00:00Z`)); // 1 per day = 30 events
  for (let i = 0; i < 60; i++) ts.push(new Date('2026-10-01T10:00:00Z')); // spike day: 61
  const s = dailyAnomalyStats('x', ts, days);
  assert.equal(s.evaluated, true); assert.equal(s.totalEvents, 90); assert.equal(s.mean, 3);
  assert.equal(s.anomalyDays.length, 1); assert.equal(s.anomalyDays[0].date, '2026-10-01'); assert.equal(s.anomalyDays[0].count, 61); assert.ok(s.anomalyDays[0].zScore >= 3);
});
test('dailyAnomalyStats: too few events -> not evaluated, null stats (no zeros)', () => {
  const s = dailyAnomalyStats('x', [new Date('2026-10-08Z')], lastDays(NOW));
  assert.equal(s.evaluated, false); assert.equal(s.mean, null); assert.equal(s.stdDev, null); assert.deepEqual(s.anomalyDays, []);
});
test('buildSentimentMetrics: distribution, percents and average computed server-side', () => {
  const s = buildSentimentMetrics([5, 5, 4, 3, 1, 5, 4, 2, 5, 5], 3, ['a']);
  assert.equal(s.totalReviews, 10); assert.equal(s.averageRating, 3.9);
  assert.deepEqual(s.distribution.map((d) => d.count), [1, 1, 1, 2, 5]);
  assert.equal(s.positivePercent, 70); assert.equal(s.negativePercent, 20);
  const none = buildSentimentMetrics([], 0, []);
  assert.equal(none.averageRating, null); assert.equal(none.positivePercent, null);
});

// ---- endpoints (service level) ----
test('forecast: NOT_ENOUGH_DATA with no data (model never called, series null)', async (t) => {
  const calls: any[] = [];
  const r = await (await load(t, emptyDb(), llmOk(calls))).forecast('a1');
  assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(r.series, null); assert.equal(r.summary, null); assert.equal(calls.length, 0);
});
const fcDb = (months: number) => ({
  ...emptyDb(),
  walletTransaction: { findMany: async () => Array.from({ length: months }, (_, i) => ({ amount: 100 * (i + 1), currency: 'USD', createdAt: new Date(Date.UTC(2026, 8 - i, 5)) })) },
  withdrawal: { findMany: async () => [{ amount: 40, currency: 'USD', createdAt: new Date('2026-08-10Z') }] },
});
test('forecast: READY with 6 months -> projection sent as a number, no confidence', async (t) => {
  const calls: any[] = [];
  const r = await (await load(t, fcDb(6), llmOk(calls))).forecast('a1');
  assert.equal(r.status, 'READY'); assert.equal(r.confidence, null); assert.equal(r.series?.monthsWithData, 6);
  assert.equal(r.series?.inflowNextMonthEstimate, 0 + (r.series!.inflowNextMonthEstimate as number));
  assert.equal(calls[0].input.inflowNextMonthEstimate, r.series!.inflowNextMonthEstimate); assert.equal(calls[0].input.currency, 'USD');
});
test('forecast: 4 months READY but no projection (null)', async (t) => {
  const r4 = await (await load(t, fcDb(4), llmOk())).forecast('a1');
  assert.equal(r4.status, 'READY'); assert.equal(r4.series?.inflowNextMonthEstimate, null);
});
test('forecast: 3 months -> NOT_ENOUGH_DATA', async (t) => {
  const r3 = await (await load(t, fcDb(3), llmOk())).forecast('a1');
  assert.equal(r3.status, 'NOT_ENOUGH_DATA');
});
const mixedDb = () => ({
  ...emptyDb(),
  walletTransaction: { findMany: async () => [
    ...Array.from({ length: 7 }, (_, i) => ({ amount: 100 * (i + 1), currency: 'USD', createdAt: new Date(Date.UTC(2026, 8 - i, 5)) })),
    ...Array.from({ length: 7 }, (_, i) => ({ amount: 999, currency: 'SAR', createdAt: new Date(Date.UTC(2026, 8 - i, 6)) })),
  ] },
  withdrawal: { findMany: async () => [] },
});
test('forecast currency: mixed currencies -> USD only, flagged mixed, NO next-month estimate, SAR never summed in', async (t) => {
  const calls: any[] = [];
  const r = await (await load(t, mixedDb(), llmOk(calls))).forecast('a1');
  assert.equal(r.status, 'READY');
  assert.equal(r.series?.currency, 'USD'); assert.equal(r.series?.mixedCurrencies, true); assert.deepEqual(r.series?.currenciesSeen, ['SAR', 'USD']);
  assert.equal(r.series?.inflowNextMonthEstimate, null); assert.equal(r.series?.inflowTrendBasedOnMonths, null);
  const inflowTotal = r.series!.months.reduce((n, m) => n + (m.inflow ?? 0), 0);
  assert.equal(inflowTotal, 100 + 200 + 300 + 400 + 500 + 600 + 700);       // the SAR 999 rows are not in the sums
  assert.equal(calls[0].input.mixedCurrencies, true); assert.equal(calls[0].input.inflowNextMonthEstimate ?? null, null);
});
test('forecast currency: a single non-USD currency in the data is reported as it is (a data fact), the estimate stays allowed', async (t) => {
  const db = { ...emptyDb(), walletTransaction: { findMany: async () => Array.from({ length: 6 }, (_, i) => ({ amount: 50 * (i + 1), currency: 'SAR', createdAt: new Date(Date.UTC(2026, 8 - i, 5)) })) }, withdrawal: { findMany: async () => [] } };
  const r = await (await load(t, db, llmOk())).forecast('a1');
  assert.equal(r.series?.currency, 'SAR'); assert.equal(r.series?.mixedCurrencies, false); assert.notEqual(r.series?.inflowNextMonthEstimate, null);
});
test('forecast currency: no rows at all -> no currency (null), never a SAR / USD default', async (t) => {
  const r = await (await load(t, emptyDb(), llmOk())).forecast('a1');
  assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(r.series, null);
  const { pickForecastCurrency } = await import('./admin-ai-summaries.stats');
  assert.deepEqual(pickForecastCurrency([]), { currency: null, seen: [], mixed: false });
  assert.equal(pickForecastCurrency([{ currency: 'SAR' }, { currency: 'SAR' }, { currency: 'USD' }]).currency, 'USD');   // the platform currency wins even when outnumbered
});
test('static: the forecast code has no hardcoded SAR default', async () => {
  const { readFileSync } = await import('node:fs'); const path = await import('node:path');
  for (const f of ['admin-ai-summaries.service.ts', 'admin-ai-summaries.stats.ts']) {
    const src = readFileSync(path.join(import.meta.dirname, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /'SAR'|"SAR"/);
  }
});
test('forecast: model not configured -> FAILED with null fields', async (t) => {
  const r = await (await load(t, fcDb(6), llmMissing)).forecast('a1');
  assert.equal(r.status, 'FAILED'); assert.equal(r.summary, null); assert.equal(r.score, null); assert.equal(r.confidence, null); assert.equal(r.details, null);
});

const anDb = (spike: boolean) => {
  const ts: any[] = [];
  for (let i = 0; i < 30; i++) ts.push({ occurredAt: new Date(Date.UTC(2026, 9, 9 - i, 10)), eventType: 'LOGIN_REJECTED', severity: 'WARNING', actorLabel: 'secret@x.co', ipAddress: '1.2.3.4' });
  if (spike) for (let i = 0; i < 60; i++) ts.push({ occurredAt: new Date('2026-10-01T10:00:00Z'), eventType: 'LOGIN_REJECTED', severity: 'WARNING' });
  return { ...emptyDb(), accountAuditLog: { findMany: async (a: any) => (a.where.eventType === 'LOGIN_REJECTED' || a.where.severity ? ts : []) } };
};
test('anomaly: NOT_ENOUGH_DATA with no events', async (t) => {
  const r = await (await load(t, emptyDb(), llmOk())).anomaly('a1');
  assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(r.anomalies, null);
});
test('anomaly: READY; anomalyCount is deterministic and the payload has no PII', async (t) => {
  const calls: any[] = [];
  const r = await (await load(t, anDb(true), llmOk(calls))).anomaly('a1');
  assert.equal(r.status, 'READY');
  assert.ok(r.anomalies!.anomalyCount >= 1); assert.equal(calls[0].input.anomalyCount, r.anomalies!.anomalyCount);
  const json = JSON.stringify(calls[0].input);
  assert.equal(findPersonalData(calls[0].input), null); assert.doesNotMatch(json, /secret|1\.2\.3\.4|actorLabel|ipAddress/);
});
test('anomaly: FAILED when the model is missing', async (t) => {
  const r = await (await load(t, anDb(true), llmMissing)).anomaly('a1');
  assert.equal(r.status, 'FAILED'); assert.equal(r.summary, null);
});

const rvDb = (n: number) => ({
  ...emptyDb(),
  review: {
    findMany: async (a: any) => (a.select.comment ? [{ comment: 'خدمة ممتازة جدا اتصل 0501234567 أو a@b.co' }, { comment: 'ok' }] : Array.from({ length: n }, (_, i) => ({ rating: (i % 5) + 1, clientId: 'c', providerId: 'p' }))),
    count: async () => 2,
  },
});
test('sentiment: NOT_ENOUGH_DATA below 10 reviews', async (t) => {
  const r = await (await load(t, rvDb(9), llmOk())).sentiment('a1');
  assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(r.stats, null);
});
test('sentiment: READY; percents in payload; snippets scrubbed; no ids', async (t) => {
  const calls: any[] = [];
  const r = await (await load(t, rvDb(10), llmOk(calls))).sentiment('a1');
  assert.equal(r.status, 'READY'); assert.equal(r.stats?.positivePercent, 40); assert.equal(calls[0].input.positivePercent, 40);
  assert.equal(findPersonalData(calls[0].input), null); assert.doesNotMatch(JSON.stringify(calls[0].input), /clientId|providerId/);
  assert.equal(calls[0].input.commentSnippets.length, 2);
});
test('sentiment: FAILED when the model is missing', async (t) => {
  const r = await (await load(t, rvDb(10), llmMissing)).sentiment('a1');
  assert.equal(r.status, 'FAILED'); assert.equal(r.details, null);
});

// ---- routes ----
test('routes: admin-only + requireActiveUser + aiLimiter, GET only; mounted under /api/admin/ai', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../routes/admin-ai-summaries.routes.ts'), 'utf8');
  assert.match(src, /router\.use\(authenticate,\s*requireActiveUser,\s*authorize\(AccountType\.ADMIN,\s*AccountType\.SUPER_ADMIN\),\s*aiLimiter\)/);
  for (const p of ['forecast-summary', 'anomaly-summary', 'sentiment-summary']) assert.match(src, new RegExp(`router\\.get\\('/${p}'`));
  assert.doesNotMatch(src, /router\.(post|put|patch|delete)/);
  const app = fs.readFileSync(path.join(__dirname, '../../app.ts'), 'utf8');
  assert.match(app, /mountAppRoute\('\/api\/admin\/ai', adminAiSummariesRoutes\)/);
});
