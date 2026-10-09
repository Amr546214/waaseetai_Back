import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricSummaryEngine } from './metric-summary';

const input = (over: any = {}) => ({
  feature: 'test-feature', userId: 'u1', metrics: { totals: { requests: 12, accepted: 5 }, bySpecialty: [{ name: 'تصميم', requests: 7 }] },
  allow: { totals: { requests: 'number', accepted: 'number' }, bySpecialty: [{ name: 'string', requests: 'number' }] } as any,
  paths: ['totals.requests', 'totals.accepted', 'bySpecialty'], minUsedPaths: 2, system: 'لخّص.', ...over,
});
const llmOk = (calls: any[] = []) => ({ generateJson: async (o: any) => { calls.push(o); return { data: { summary: 'ملخص من البيانات', observations: [{ text: 'عدد الطلبات 12', basedOn: ['totals.requests'] }], recommendations: [{ text: 'ركّز على التصميم', basedOn: ['bySpecialty'] }] }, usage: { tokensIn: 1, tokensOut: 1 }, source: 'LLM' as const }; } });
const llmMissing = { generateJson: async () => { throw Object.assign(new Error('x'), { code: 'NOT_CONFIGURED' }); } };

test('READY: summary + observations + recommendations, source GEMINI, no score / confidence', async () => {
  const calls: any[] = [];
  const r = await new MetricSummaryEngine(llmOk(calls) as any).summarise(input());
  assert.equal(r.status, 'READY'); assert.equal(r.source, 'GEMINI');
  assert.equal(r.summary, 'ملخص من البيانات');
  assert.equal(r.score, null); assert.equal(r.confidence, null);
  assert.equal(r.details?.observations[0].text, 'عدد الطلبات 12');
  assert.ok(r.generatedAt);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input.totals, { requests: 12, accepted: 5 });
});

test('NOT_ENOUGH_DATA: too few real fields -> the model is never called, nothing invented', async () => {
  const calls: any[] = [];
  const r = await new MetricSummaryEngine(llmOk(calls) as any).summarise(input({ metrics: { totals: { requests: null, accepted: null }, bySpecialty: [] } }));
  assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(r.summary, null); assert.equal(r.score, null); assert.equal(r.generatedAt, null);
  assert.equal(calls.length, 0);
});

test('NOT_ENOUGH_DATA: a custom data check can refuse too (e.g. fewer than N records)', async () => {
  const calls: any[] = [];
  const r = await new MetricSummaryEngine(llmOk(calls) as any).summarise(input({ hasEnoughData: (p: any) => p.totals.requests >= 30 }));
  assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(calls.length, 0);
});

test('FAILED when the model is not configured (dev without LLM_*): no fake fields, no throw', async () => {
  const r = await new MetricSummaryEngine(llmMissing as any).summarise(input());
  assert.equal(r.status, 'FAILED'); assert.equal(r.summary, null); assert.equal(r.score, null); assert.equal(r.confidence, null); assert.equal(r.details, null);
});

test('fields outside the allowlist never reach the model', async () => {
  const calls: any[] = [];
  await new MetricSummaryEngine(llmOk(calls) as any).summarise(input({ metrics: { totals: { requests: 3, accepted: 1, email: 'a@b.co' }, secret: 'x', bySpecialty: [{ name: 'تصميم', requests: 2, phone: '0500000000' }] } }));
  assert.doesNotMatch(JSON.stringify(calls[0].input), /a@b\.co|secret|0500000000/);
});
