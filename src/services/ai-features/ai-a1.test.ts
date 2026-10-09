import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { aiFailed, aiNotEnoughData, aiPending, aiReady, isRealAi, parseStoredAiResult } from './ai-result';
import { businessModelAuditResult } from './business-model-audit-result';

// --- the reusable AI result contract -------------------------------------------------------------------------------------------
test('contract: missing values are null (never 0), only READY with a real source counts as AI', () => {
  for (const r of [aiNotEnoughData(), aiPending(), aiFailed('GEMINI')]) {
    assert.equal(r.score, null); assert.equal(r.confidence, null); assert.equal(r.summary, null); assert.equal(isRealAi(r), false);
  }
  assert.equal(aiNotEnoughData().generatedAt, null);
  assert.ok(aiFailed('GEMINI').generatedAt);
  const ready = aiReady({ source: 'WASEET_AI', score: 0, summary: ' جيد ' });
  assert.equal(ready.score, 0);                          // a REAL zero stays 0
  assert.equal(ready.summary, 'جيد');
  assert.equal(ready.confidence, null);                  // no confidence unless the vendor gives one
  assert.equal(isRealAi(ready), true);
  assert.equal(isRealAi(aiReady({ source: 'RULES', score: 5 })), false);
  assert.equal(aiReady({ source: 'WASEET_AI', score: NaN as any }).score, null);
});

test('contract: a stored result is read back defensively', () => {
  assert.equal(parseStoredAiResult(null), null);
  assert.equal(parseStoredAiResult({ status: 'WHATEVER', source: 'GEMINI' }), null);
  assert.equal(parseStoredAiResult({ status: 'READY', source: 'GEMINI', score: '90' })?.score, null);
  assert.equal(parseStoredAiResult(aiReady({ source: 'GEMINI', summary: 'x' }))?.status, 'READY');
});

// --- business model stored audit -----------------------------------------------------------------------------------------------
test('business model: no audit => PENDING with null score; stored WaseetAI report => READY, nothing derived or invented', () => {
  const none = businessModelAuditResult({ aiAuditScore: null, aiAuditReport: null });
  assert.deepEqual([none.status, none.score, none.summary], ['PENDING', null, null]);
  const real = businessModelAuditResult({ aiAuditScore: 82, aiAuditReport: { source: 'WASEET_AI', isApproved: true, score: 82, summary: 'نموذج واضح', strengths: ['مراحل واضحة'], issues: ['لا توجد ضمانات'], recommendations: ['أضف ضمانًا'] } });
  assert.equal(real.status, 'READY'); assert.equal(real.source, 'WASEET_AI'); assert.equal(real.score, 82);
  assert.deepEqual(real.details, { isApproved: true, strengths: ['مراحل واضحة'], issues: ['لا توجد ضمانات'], recommendations: ['أضف ضمانًا'] });
  assert.equal(real.generatedAt, null);                  // the audit stores no timestamp: none is invented
  assert.equal(real.confidence, null);
  const zero = businessModelAuditResult({ aiAuditScore: 0, aiAuditReport: { source: 'WASEET_AI', score: 0, summary: 'ضعيف' } });
  assert.equal(zero.status, 'READY'); assert.equal(zero.score, 0);          // a real 0 is shown as 0
  const foreign = businessModelAuditResult({ aiAuditScore: 90, aiAuditReport: { source: 'SOMETHING_ELSE', score: 90 } });
  assert.equal(foreign.status, 'NOT_ENOUGH_DATA'); assert.equal(foreign.score, null);
});

// --- profile change AI pre-review -----------------------------------------------------------------------------------------------
function makeDb(t: TestContext, request: any) {
  const state: any = { request: { metadata: { changes: { firstName: 'سارة' }, requiresHumanReview: true }, aiAuditStatus: null, aiConfidence: null, aiRecommendation: null, status: 'PENDING_HUMAN_REVIEW', providerId: 'u1', fieldName: 'FULL_NAME', fieldLabel: 'الاسم', category: 'CLIENT_BASIC_INFO', currentValue: 'Nora Quest', requestedValue: 'سارة العتيبي', otpVerifiedAt: null, id: 'r1', ...request } };
  const db: any = {
    user: { findUnique: async () => ({ createdAt: new Date(Date.now() - 40 * 86_400_000) }) },
    profileModificationRequest: {
      findUnique: async () => state.request,
      findMany: async () => [{ status: 'REJECTED' }, { status: 'APPROVED' }],
      count: async () => 0,
      update: async (a: any) => { state.request = { ...state.request, ...a.data }; return state.request; },
    },
  };
  t.mock.module('../../config/db', { namedExports: { prisma: db } });
  t.mock.module('../../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {} } } });
  return state;
}
async function loadService(t: TestContext, request: any, llm: any) {
  const state = makeDb(t, request);
  const mod = await import(`./profile-change-review.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { state, service: new mod.ProfileChangeReviewService(llm), mod };
}
const okLlm = (assessment: 'CONSISTENT' | 'NEEDS_CLOSE_REVIEW', calls: any[] = []) => ({ generateJson: async (o: any) => { calls.push(o); return { data: { assessment, summary: 'ملخص أولي للمراجع', observations: [{ text: 'الصيغة صحيحة', basedOn: ['change.formatValid'] }] }, usage: { tokensIn: 1, tokensOut: 1 }, source: 'LLM' as const }; } });
const downLlm = { generateJson: async () => { throw Object.assign(new Error('not configured'), { code: 'NOT_CONFIGURED' }); } };

test('pre-review READY: stored in metadata.aiReview + the existing columns, the request status is untouched, confidence stays null', async (t) => {
  const calls: any[] = [];
  const { state, service } = await loadService(t, {}, okLlm('CONSISTENT', calls));
  const result = await service.reviewStoredRequest('r1');
  assert.equal(result?.status, 'READY');
  assert.equal(state.request.status, 'PENDING_HUMAN_REVIEW');              // the human decision is untouched
  assert.equal(state.request.aiAuditStatus, 'PASSED');
  assert.equal(state.request.aiConfidence, null);
  assert.match(state.request.aiRecommendation, /القرار للمراجع/);
  assert.equal(state.request.metadata.aiReview.source, 'GEMINI');
  assert.deepEqual(state.request.metadata.changes, { firstName: 'سارة' });  // existing metadata is kept
  // the model never sees the actual old / new values: only derived facts
  const sent = JSON.stringify(calls[0].input);
  assert.doesNotMatch(sent, /Nora|Quest|سارة|العتيبي/);
  assert.match(sent, /similarityPercent/);
});

test('pre-review that needs a closer look maps to NEEDS_HUMAN_REVIEW (never REJECTED)', async (t) => {
  const { state, service } = await loadService(t, {}, okLlm('NEEDS_CLOSE_REVIEW'));
  await service.reviewStoredRequest('r1');
  assert.equal(state.request.aiAuditStatus, 'NEEDS_HUMAN_REVIEW');
  assert.equal(state.request.status, 'PENDING_HUMAN_REVIEW');
});

test('AI unavailable: the request still waits for the team, aiReview is FAILED, and NO fake AI field is written', async (t) => {
  const { state, service } = await loadService(t, {}, downLlm);
  const result = await service.reviewStoredRequest('r1');
  assert.equal(result?.status, 'FAILED');
  assert.equal(state.request.status, 'PENDING_HUMAN_REVIEW');
  assert.equal(state.request.aiAuditStatus, null);
  assert.equal(state.request.aiRecommendation, null);
  assert.equal(state.request.aiConfidence, null);
  assert.equal(state.request.metadata.aiReview.status, 'FAILED');
  assert.equal(state.request.metadata.aiReview.summary, null);
});

for (const category of ['CLIENT_PASSWORD_CHANGE', 'DOCUMENTS', 'BANKING']) {
  test(`a ${category} request is never analysed (no model call at all)`, async (t) => {
    const calls: any[] = [];
    const { state, service } = await loadService(t, { category }, okLlm('CONSISTENT', calls));
    assert.equal(await service.reviewStoredRequest('r1'), null);
    assert.equal(calls.length, 0);
    assert.equal(state.request.metadata.aiReview, undefined);
  });
}

test('a decided request is not pre-reviewed any more', async (t) => {
  const calls: any[] = [];
  const { service } = await loadService(t, { status: 'APPROVED' }, okLlm('CONSISTENT', calls));
  assert.equal(await service.reviewStoredRequest('r1'), null);
  assert.equal(calls.length, 0);
});

test('lists: legacy fake AI columns are hidden unless a real stored pre-review backs them; the raw metadata is never returned', async (t) => {
  const { mod } = await loadService(t, {}, okLlm('CONSISTENT'));
  const legacyFake = { id: 'a', metadata: { changes: { x: 1 } }, aiAuditStatus: 'PASSED', aiConfidence: 90, aiRecommendation: 'تم تأكيد هوية…' };
  const out: any = mod.withHonestAiReview(legacyFake);
  assert.equal(out.aiAuditStatus, null); assert.equal(out.aiConfidence, null); assert.equal(out.aiRecommendation, null);
  assert.equal(out.aiReview, null); assert.equal('metadata' in out, false);
  const real = mod.withHonestAiReview({ id: 'b', metadata: { aiReview: aiReady({ source: 'GEMINI', summary: 'ملخص', recommendation: 'توصية', details: { assessment: 'CONSISTENT', observations: [{ text: 'ملاحظة', basedOn: ['x'] }] } }) }, aiAuditStatus: 'PASSED', aiConfidence: 90, aiRecommendation: 'توصية' }) as any;
  assert.equal(real.aiAuditStatus, 'PASSED'); assert.equal(real.aiConfidence, null);
  assert.equal(real.aiReview.status, 'READY'); assert.equal(real.aiReview.summary, 'ملخص'); assert.deepEqual(real.aiReview.observations, ['ملاحظة']);
  const failed: any = mod.withHonestAiReview({ id: 'c', metadata: { aiReview: aiFailed('GEMINI') }, aiAuditStatus: null });
  assert.equal(failed.aiReview.status, 'FAILED'); assert.deepEqual(failed.aiReview.observations, []);
});
