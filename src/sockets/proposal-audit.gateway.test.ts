import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProposalAuditGateway, buildQualityAuditResult } from './proposal-audit.gateway';

import { AppError } from '../utils/app-error';
import type { ProposalEvaluation, ProposalEvaluationInput } from '../services/ai-proposal.service';

// Proposal audit = WaseetAI proposal-QUALITY review (proposals/enrich). The
// gateway never fabricates a result: on any failure only an
// `ai_audit_progress` FAILED event is emitted.

const EVALUATION: ProposalEvaluation = { qualityScore: 88, qualityTag: 'Strong', summary: 'خطة واضحة وسعر معقول' };

function setup(userId?: string, evaluate?: (i: ProposalEvaluationInput) => Promise<ProposalEvaluation>) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const calls: ProposalEvaluationInput[] = [];
  const socket: any = {
    id: `s-${Math.random()}`,
    userId,
    on: (event: string, h: any) => { handlers[event] = h; },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); }
  };
  new ProposalAuditGateway(async (input) => {
    calls.push(input);
    return evaluate ? evaluate(input) : EVALUATION;
  }).register(socket);
  return { handlers, emitted, calls };
}

const validPayload = (providerId = 'provider-1') => ({
  projectId: 'project-1',
  providerId,
  proposalDraft: { title: 't', message: 'm', price: 100, durationDays: 5, milestonesCount: 2 }
});

test('trigger_ai_audit: success emits ai_audit_result with quality only; nothing else is invented', async () => {
  const { handlers, emitted, calls } = setup('provider-1');
  await handlers['trigger_ai_audit'](validPayload());

  assert.deepEqual(calls, [{ projectId: 'project-1', title: 't', message: 'm', totalPrice: 100, deliveryDays: 5 }]);
  const result = emitted.find((e) => e.event === 'ai_audit_result')!.payload;
  assert.equal(result.finalMetrics.overallScore, 88);
  assert.equal(result.profileAudit.length, 1);
  assert.equal(result.profileAudit[0].badge, 'Strong');
  assert.equal(result.profileAudit[0].subtitle, 'خطة واضحة وسعر معقول');
  for (const k of ['profileMatch', 'messageClarity', 'priceCompetitiveness', 'timelineFeasibility', 'completeness']) {
    assert.equal(result.finalMetrics[k], null, k);
  }
  assert.deepEqual(result.triPartyComparison.aiRecommendation, { budget: 'غير مدعوم', duration: 'غير مدعوم', milestones: 'غير مدعوم' });
  assert.equal(result.triPartyComparison.client.budget, 'غير متاح');
  assert.deepEqual(result.acceptanceOdds, { statusText: 'غير مدعوم', description: 'غير مدعوم', topPercentage: 'غير مدعوم' });
  assert.match(result.triPartyNote, /لا يقيس توافقه مع المشروع ولا عدالة السعر/);
  assert.ok(!emitted.some((e) => e.payload?.status === 'FAILED'));
  assert.equal(emitted[emitted.length - 1].payload.status, 'COMPLETED');
});

test('trigger_ai_audit: WaseetAI failure emits FAILED only, never an ai_audit_result', async () => {
  const { handlers, emitted } = setup('provider-1', async () => { throw new AppError('تعذر تحليل العرض بالذكاء الاصطناعي حالياً.', 503); });
  await handlers['trigger_ai_audit'](validPayload());
  assert.ok(!emitted.some((e) => e.event === 'ai_audit_result'));
  const failed = emitted.find((e) => e.payload?.status === 'FAILED')!;
  assert.match(failed.payload.message, /تعذر تحليل العرض/);
});

test('trigger_ai_audit: an unexpected error is reported generically without leaking its message', async () => {
  const { handlers, emitted } = setup('provider-1', async () => { throw new Error('secret upstream detail'); });
  await handlers['trigger_ai_audit'](validPayload());
  assert.ok(!emitted.some((e) => e.event === 'ai_audit_result'));
  const failed = emitted.find((e) => e.payload?.status === 'FAILED')!;
  assert.doesNotMatch(JSON.stringify(failed.payload), /secret upstream detail/);
});

test('buildQualityAuditResult: status follows the vendor score; provider column echoes the draft only', () => {
  const draft = { title: 't', message: 'm', price: 250, durationDays: 7, milestonesCount: 3, selectedPortfolioIds: [] };
  const mk = (qualityScore: number) => buildQualityAuditResult(draft, { qualityScore, qualityTag: 'x', summary: 's' });
  assert.equal(mk(90).profileAudit[0].status, 'EXCELLENT');
  assert.equal(mk(60).profileAudit[0].status, 'GOOD');
  assert.equal(mk(10).profileAudit[0].status, 'WARNING');
  assert.deepEqual(mk(90).triPartyComparison.provider, { budget: '250 $', duration: '7 يوم', milestones: '3 مرحلة' });
});

test('trigger_ai_audit: unauthenticated socket is rejected and the evaluator is not called', async () => {
  const { handlers, emitted, calls } = setup(undefined);
  await handlers['trigger_ai_audit'](validPayload());
  assert.equal(emitted[0].payload.status, 'FAILED');
  assert.equal(calls.length, 0);
});

test('trigger_ai_audit: invalid payload and foreign providerId are rejected without calling the evaluator', async () => {
  const a = setup('provider-1');
  await a.handlers['trigger_ai_audit']({ nope: true });
  assert.equal(a.emitted[0].payload.status, 'FAILED');
  assert.equal(a.calls.length, 0);
  const b = setup('provider-1');
  await b.handlers['trigger_ai_audit'](validPayload('provider-2'));
  assert.equal(b.emitted[0].payload.status, 'FAILED');
  assert.equal(b.calls.length, 0);
});

test('trigger_ai_audit: a provider issuing more than 30 requests within the window is rate-limited on the next one', async () => {
  const providerId = `rate-limit-provider-${Date.now()}-${Math.random()}`;
  const { handlers, emitted, calls } = setup(providerId);
  for (let i = 0; i < 30; i++) await handlers['trigger_ai_audit'](validPayload(providerId));
  assert.equal(calls.length, 30);
  emitted.length = 0;

  await handlers['trigger_ai_audit'](validPayload(providerId));

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.status, 'FAILED');
  assert.match(emitted[0].payload.message, /تجاوز الحد المسموح/);
  assert.equal(calls.length, 30);
});

test('trigger_ai_audit: rejected requests never consume the rate-limit budget', async () => {
  const providerId = `budget-provider-${Date.now()}-${Math.random()}`;
  const { handlers, emitted } = setup(providerId);
  for (let i = 0; i < 40; i++) await handlers['trigger_ai_audit']({ nope: true });
  for (let i = 0; i < 40; i++) await handlers['trigger_ai_audit'](validPayload('someone-else'));
  emitted.length = 0;
  await handlers['trigger_ai_audit'](validPayload(providerId));
  assert.ok(emitted.some((e) => e.event === 'ai_audit_result'));
});

test('proposal-audit.gateway has no Gemini/direct-provider reference and no DB or raw client call', () => {
  const src = readFileSync(new URL('./proposal-audit.gateway.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /gemini|openai|generateStructured|prisma|waseetAiClient/i);
});
