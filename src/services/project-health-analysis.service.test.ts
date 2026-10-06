import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientWith } from './ai-features/ai-feature.test-helpers';
import { LlmError, LlmErrorCode, LLM_UNAVAILABLE_MESSAGE } from './llm/llm.errors';

// Project health (#18) through the internal LlmClient: real fake-provider LlmClient, mocked database, fixed clock.

const NOW = new Date('2026-03-31T00:00:00Z').getTime();
const day = (n: number) => new Date(NOW - n * 86_400_000);
const stage = (o: any = {}) => ({ stepOrder: 1, title: 'التصميم', status: 'APPROVED', days: 10, percentage: 50, updatedAt: day(20), deliveries: [{ status: 'APPROVED', updatedAt: day(20) }], ...o });
const CONTRACT = {
  projectId: 'p1', durationDays: 40, signedAt: day(30), createdAt: day(31), updatedAt: day(2),
  stages: [stage(), stage({ stepOrder: 2, title: 'التطوير', status: 'IN_PROGRESS', days: 25, percentage: 50, updatedAt: day(3), deliveries: [{ status: 'REVISION_REQUESTED', updatedAt: day(3) }, { status: 'REVISION_REQUESTED', updatedAt: day(4) }] })],
};

type State = { contract?: any; disputes?: number };
async function load(t: TestContext, respond: (i: any) => unknown, state: State = {}, calls: any[] = [], config?: any) {
  const prisma: any = {
    contract: { findFirst: async () => ('contract' in state ? state.contract : CONTRACT) },
    dispute: { count: async () => state.disputes ?? 0 },
  };
  t.mock.module('../config/db', { namedExports: { prisma } });
  const { ProjectHealthService } = await import(`./ai-features/project-health.service.ts?f=${Date.now()}-${Math.random()}`);
  const holder = { fn: respond };
  const svc = new ProjectHealthService(clientWith((i) => holder.fn(i), calls, config), () => NOW);
  return Object.assign(svc, { state, setRespond(fn: (i: any) => unknown) { holder.fn = fn; } });
}

const honest = (i: any) => ({
  riskLevelKey: i.slackDays < 0 ? 'HIGH' : 'LOW',
  confidence: 70,
  healthRating: i.slackDays < 0 ? 'متأخر عن الجدول' : 'ضمن الجدول',
  bullets: [
    { text: `مرّ ${i.daysElapsed} يوماً من أصل ${i.totalDays}`, basedOn: ['daysElapsed', 'totalDays'] },
    ...(i.revisionCount > 0 ? [{ text: `عدد طلبات التعديل ${i.revisionCount}`, basedOn: ['revisionCount'] }] : []),
  ],
});

test('grounded answer: quotes the schedule, revisions and slack that were sent; earlyDays is the computed slack', async (t) => {
  const calls: any[] = [];
  const svc = await load(t, honest, {}, calls);
  const r = await svc.analyze('u1', 'p1');
  const sent = JSON.parse(calls[0].user);
  assert.deepEqual({ totalDays: sent.totalDays, daysElapsed: sent.daysElapsed, revisionCount: sent.revisionCount, disputeCount: sent.disputeCount }, { totalDays: 40, daysElapsed: 30, revisionCount: 2, disputeCount: 0 });
  assert.equal(sent.slackDays, 40 - 30 - 25); // remaining (unapproved) stage days = 25
  assert.equal(sent.lastActivityDays, 2);
  assert.equal(r.generationSource, 'LLM');
  assert.equal(r.riskLevelKey, 'HIGH');
  assert.equal(r.riskLevel, 'مرتفع');
  assert.equal(r.earlyDays, -15);
  assert.deepEqual(r.bullets, ['مرّ 30 يوماً من أصل 40', 'عدد طلبات التعديل 2']);
  assert.equal(r.notes.lastActivityIsApproximate, true);
  assert.equal(r.matchPercentage, null);
});

test('changing the input changes the output', async (t) => {
  const svc = await load(t, honest);
  const a = await svc.analyze('u1', 'p1');
  svc.state.contract = { ...CONTRACT, durationDays: 90 };
  const b = await svc.analyze('u2', 'p1');
  assert.notEqual(a.riskLevelKey, b.riskLevelKey);
  assert.notDeepEqual(a.bullets, b.bullets);
});

test('no stage data: "لا توجد بيانات مراحل" immediately, no model call, nothing invented', async (t) => {
  const calls: any[] = [];
  const svc = await load(t, honest, { contract: { ...CONTRACT, stages: [] } }, calls);
  const r = await svc.analyze('u1', 'p1');
  assert.equal(r.insufficientData, true);
  assert.equal(r.message, 'لا توجد بيانات مراحل');
  assert.equal(r.generationSource, null);
  assert.equal(r.confidence, null);
  assert.equal(r.riskLevelKey, 'UNKNOWN');
  assert.equal(r.earlyDays, null);
  assert.equal(calls.length, 0);
});

test('model failure → fixed 503; env missing → 503 NOT_CONFIGURED', async (t) => {
  const svc = await load(t, () => new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'down'));
  await assert.rejects(svc.analyze('u1', 'p1'), (e: any) => e.statusCode === 503 && e.message === LLM_UNAVAILABLE_MESSAGE);
});

test('env missing → 503 NOT_CONFIGURED', async (t) => {
  const svc = await load(t, honest, {}, [], null);
  await assert.rejects(svc.analyze('u1', 'p1'), (e: any) => e.statusCode === 503 && e.code === 'NOT_CONFIGURED');
});

test('a number or basedOn path that was not sent is rejected (503)', async (t) => {
  const svc = await load(t, honest);
  svc.setRespond((i: any) => ({ ...honest(i), bullets: [{ text: 'تأخر 99 يوماً', basedOn: ['daysElapsed'] }] }));
  await assert.rejects(svc.analyze('u1', 'p1'), (e: any) => e.statusCode === 503);
  svc.setRespond((i: any) => ({ ...honest(i), bullets: [{ text: 'مرّ 30 يوماً', basedOn: ['paymentHistory'] }] }));
  await assert.rejects(svc.analyze('u2', 'p1'), (e: any) => e.statusCode === 503);
  svc.setRespond((i: any) => ({ ...honest(i), confidence: 140 }));
  await assert.rejects(svc.analyze('u3', 'p1'), (e: any) => e.statusCode === 503);
});

test('a project the caller is not part of → 404 (no model call)', async (t) => {
  const calls: any[] = [];
  const svc = await load(t, honest, { contract: null }, calls);
  await assert.rejects(svc.analyze('u1', 'p1'), (e: any) => e.statusCode === 404);
  assert.equal(calls.length, 0);
});

test('disputes are counted from the Dispute table and sent', async (t) => {
  const calls: any[] = [];
  const svc = await load(t, honest, { disputes: 3 }, calls);
  await svc.analyze('u1', 'p1');
  assert.equal(JSON.parse(calls[0].user).disputeCount, 3);
});

test('project-progress.service delegates to the in-house service and has no leftover disabled stub', () => {
  const src = readFileSync(new URL('./project-progress.service.ts', import.meta.url), 'utf8');
  assert.match(src, /projectHealthService\.analyze\(userId, key\)/);
  assert.doesNotMatch(src, /PROJECT_HEALTH_UNAVAILABLE_MESSAGE/);
});
