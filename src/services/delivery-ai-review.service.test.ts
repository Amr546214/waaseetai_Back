import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientWith } from './ai-features/ai-feature.test-helpers';
import { LlmError, LlmErrorCode, LLM_UNAVAILABLE_MESSAGE } from './llm/llm.errors';

// Delivery review (#19/#24) through the internal LlmClient: real fake-provider LlmClient, mocked database.

const delivery = (o: any = {}) => ({ note: 'أرفقت شاشة تسجيل الدخول ولوحة التحكم', files: ['https://cdn.example.com/u/login-screen.png?sig=abc', JSON.stringify({ name: 'dashboard.fig', url: 'https://cdn.example.com/secret/xyz' })], submittedAt: new Date('2026-03-01T10:00:00Z'), ...o });
const CONTRACT = {
  project: { title: 'متجر', description: 'متجر إلكتروني', requirements: ['شاشة تسجيل الدخول', 'لوحة تحكم', 'بوابة دفع'] },
  stages: [{ title: 'التصميم', description: 'تصميم الواجهات', deliveries: [delivery({ note: 'أول تسليم', files: [] }), delivery()] }],
};

type State = { contract?: any };
async function load(t: TestContext, respond: (i: any) => unknown, state: State = {}, calls: any[] = [], config?: any) {
  const prisma: any = { contract: { findFirst: async () => ('contract' in state ? state.contract : CONTRACT) } };
  t.mock.module('../config/db', { namedExports: { prisma } });
  const { DeliveryReviewService } = await import(`./ai-features/delivery-review.service.ts?f=${Date.now()}-${Math.random()}`);
  const holder = { fn: respond };
  const svc = new DeliveryReviewService(clientWith((i) => holder.fn(i), calls, config));
  return Object.assign(svc, { state, setRespond(fn: (i: any) => unknown) { holder.fn = fn; } });
}

// deterministic "model": marks a requirement as met when its keyword appears in the delivery note, quoting that keyword
const KEYWORDS: Record<string, string> = { 'شاشة تسجيل الدخول': 'تسجيل الدخول', 'لوحة تحكم': 'لوحة التحكم', 'بوابة دفع': 'بوابة دفع' };
const honest = (i: any) => {
  const note: string = i.delivery.note;
  const met = (i.project.requirements as string[]).filter((r) => KEYWORDS[r] && note.includes(KEYWORDS[r])).map((r) => ({ requirement: r, evidence: KEYWORDS[r] }));
  return { summary: `ملاحظة التسليم تتناول ${met.length} من ${i.project.requirements.length} متطلبات`, met, observations: [{ text: `التسليم رقم ${i.delivery.revisionNumber}`, basedOn: ['delivery.revisionNumber'] }], questionsForReviewer: ['هل تم اختبار لوحة التحكم؟'] };
};

test('payload: stage/delivery/project fields, file NAME + EXTENSION only (no URL), project-scope requirements, contentRead:false, revisionNumber from order', async (t) => {
  const calls: any[] = [];
  const svc = await load(t, honest, {}, calls);
  await svc.review('u1', 'p1', 's1');
  const sent = JSON.parse(calls[0].user);
  assert.deepEqual(sent.delivery.files, [{ name: 'login-screen.png', ext: 'png' }, { name: 'dashboard.fig', ext: 'fig' }]);
  assert.equal(sent.delivery.revisionNumber, 2);
  assert.equal(sent.requirementsScope, 'PROJECT');
  assert.equal(sent.contentRead, false);
  assert.deepEqual(sent.project.requirements, ['شاشة تسجيل الدخول', 'لوحة تحكم', 'بوابة دفع']);
  assert.doesNotMatch(calls[0].user, /cdn\.example\.com|sig=abc|secret/);
});

test('quotes the delivery note and the sent requirements; lists unmet requirements from requirements[]; contentRead is the fixed false', async (t) => {
  const svc = await load(t, honest);
  const r = await svc.review('u1', 'p1', 's1');
  assert.equal(r.generationSource, 'LLM');
  assert.equal(r.contentRead, false);
  assert.match(r.contentNotice, /لا يقرأ.*محتوى الملفات/);
  assert.equal(r.requirementsScope, 'PROJECT');
  assert.deepEqual(r.met.map((m: any) => m.requirement), ['شاشة تسجيل الدخول', 'لوحة تحكم']);
  assert.deepEqual(r.unmetRequirements, ['بوابة دفع']);
  assert.ok(r.potentialGaps.includes('غير موثّق في التسليم: بوابة دفع'));
  assert.equal(r.reviewedInputs.attachmentContent, false);
});

test('the model cannot flip contentRead: it is not part of the output schema and the result always carries false', async (t) => {
  const svc = await load(t, (i: any) => ({ ...honest(i), contentRead: true }));
  const r = await svc.review('u1', 'p1', 's1');
  assert.equal(r.contentRead, false);
});

test('changing the input (the note) changes the output', async (t) => {
  const svc = await load(t, honest);
  const a = await svc.review('u1', 'p1', 's1');
  svc.state.contract = { ...CONTRACT, stages: [{ ...CONTRACT.stages[0], deliveries: [delivery({ note: 'أرفقت لوحة التحكم فقط', files: [] })] }] };
  const b = await svc.review('u2', 'p1', 's1');
  assert.notDeepEqual(a.met, b.met);
  assert.notDeepEqual(a.unmetRequirements, b.unmetRequirements);
});

test('no delivery, or a delivery with neither a note nor files: no model call and nothing invented', async (t) => {
  const calls: any[] = [];
  const svc = await load(t, honest, { contract: { ...CONTRACT, stages: [{ ...CONTRACT.stages[0], deliveries: [] }] } }, calls);
  const r1 = await svc.review('u1', 'p1', 's1');
  assert.equal(r1.insufficientData, true);
  assert.equal(r1.message, 'لا يوجد تسليم لهذه المرحلة');
  svc.state.contract = { ...CONTRACT, stages: [{ ...CONTRACT.stages[0], deliveries: [delivery({ note: '', files: [] })] }] };
  const r2 = await svc.review('u1', 'p1', 's1');
  assert.equal(r2.insufficientData, true);
  assert.equal(r2.generationSource, null);
  assert.equal(r2.contentRead, false);
  assert.equal(calls.length, 0);
});

test('a requirement that was not sent, or an evidence quote that is not in the note, is rejected (503)', async (t) => {
  const svc = await load(t, honest);
  svc.setRespond((i: any) => ({ ...honest(i), met: [{ requirement: 'ميزة غير مطلوبة', evidence: 'لوحة التحكم' }] }));
  await assert.rejects(svc.review('u1', 'p1', 's1'), (e: any) => e.statusCode === 503);
  svc.setRespond((i: any) => ({ ...honest(i), met: [{ requirement: 'لوحة تحكم', evidence: 'تم اختبار كل الشاشات' }] }));
  await assert.rejects(svc.review('u2', 'p1', 's1'), (e: any) => e.statusCode === 503);
  svc.setRespond((i: any) => ({ ...honest(i), summary: 'اكتمل 12 متطلباً' }));
  await assert.rejects(svc.review('u3', 'p1', 's1'), (e: any) => e.statusCode === 503);
});

test('model failure → fixed 503; env missing → 503 NOT_CONFIGURED; stage not found / not a participant → 404', async (t) => {
  const failing = await load(t, () => new LlmError(LlmErrorCode.TIMEOUT, 'slow'));
  await assert.rejects(failing.review('u1', 'p1', 's1'), (e: any) => e.statusCode === 503 && e.message === LLM_UNAVAILABLE_MESSAGE);
  failing.state.contract = null;
  await assert.rejects(failing.review('u1', 'p1', 's1'), (e: any) => e.statusCode === 404);
});

test('env missing → 503 NOT_CONFIGURED', async (t) => {
  const svc = await load(t, honest, {}, [], null);
  await assert.rejects(svc.review('u1', 'p1', 's1'), (e: any) => e.statusCode === 503 && e.code === 'NOT_CONFIGURED');
});

test('the review is never cached and never writes: the service source has no prisma write and the call is cache:false', () => {
  const src = readFileSync(new URL('./ai-features/delivery-review.service.ts', import.meta.url), 'utf8');
  assert.match(src, /cache: false/);
  assert.doesNotMatch(src, /\.(create|update|updateMany|delete|upsert)\(/);
});

test('normal delivery workflow methods are still present on the progress service', async (t) => {
  t.mock.module('../config/db', { namedExports: { prisma: new Proxy({}, { get: () => { throw new Error('db'); } }) } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('./email.service', { namedExports: { emailService: {} } });
  t.mock.module('./affiliate-commission.service', { namedExports: { createCommissionsForStageReleaseEvent: async () => undefined } });
  const { projectProgressService: svc } = await import(`./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`);
  for (const m of ['reviewDelivery', 'submitDelivery', 'getProjectProgress', 'getDeliveryAiReview']) assert.equal(typeof svc[m], 'function', m);
});
