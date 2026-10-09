import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientWith } from './ai-feature.test-helpers';

const SAMPLE = { title: 'متجر إلكتروني لبيع الملابس', description: 'تصميم وتطوير متجر كامل بتجربة دفع سلسة وإدارة مخزون. للتواصل owner@shop.com أو 0501234567 https://my-site.com/p', technologies: ['React', 'Node.js'], mimeType: 'application/pdf', proofs: [{ id: 'p1' }, { id: 'p2' }] };
const ROW = (samples: any[]) => ({ id: 'ps1', specialty: { nameAr: 'تطوير الويب', name: 'Web' }, workSamples: samples });

function fakeDb(owner: string, samples: any[]) {
  const logs: any[] = [];
  const db: any = {
    providerSpecialty: { findFirst: async (a: any) => (a.where.providerProfile.userId === owner && a.where.id === 'ps1' ? ROW(samples) : null) },
    aiAuditLog: {
      create: async ({ data }: any) => { const row = { ...data, createdAt: new Date(2026, 9, 1 + logs.length) }; logs.push(row); return row; },
      findFirst: async (a: any) => [...logs].filter((l) => l.modelVersion === a.where.modelVersion && l.evaluationResult === a.where.evaluationResult).sort((x, y) => +y.createdAt - +x.createdAt)[0] ?? null,
      findMany: async (a: any) => [...logs].filter((l) => l.modelVersion === a.where.modelVersion).sort((x, y) => +y.createdAt - +x.createdAt),
    },
    workSample: {},
  };
  return { db, logs };
}

// an honest "model": derives its answer only from the JSON it receives
const honest = (input: any) => ({
  summary: `يضم الملف ${input.samples.length} نماذج في ${input.specialty.name}`,
  strengths: [{ text: `النموذج «${input.samples[0].title}» مذكور بتقنيات محددة`, basedOn: ['samples[0].title', 'samples[0].technologies'] }],
  warnings: [], recommendations: [{ text: 'أضف وصفاً أطول لكل نموذج', basedOn: ['samples[0].description'] }],
});

const mocked = new WeakSet<object>();
async function load(t: TestContext, o: { owner?: string; samples?: any[]; respond?: (i: any) => unknown; config?: any; calls?: any[] } = {}) {
  if (!mocked.has(t)) { t.mock.module('../../config/db', { namedExports: { prisma: {} } }); mocked.add(t); }
  const { SpecialtyPortfolioReviewService } = await import(`./specialty-portfolio-review.service.ts?f=${Date.now()}-${Math.random()}`);
  const { db, logs } = fakeDb(o.owner ?? 'u1', o.samples ?? [SAMPLE]);
  const calls = o.calls ?? [];
  const llm = clientWith((i) => (o.respond ?? honest)(i), calls, o.config);
  return { svc: new SpecialtyPortfolioReviewService(llm, db), logs, calls };
}

test('owner can evaluate: READY result (no score, no confidence) is stored and returned', async (t) => {
  const { svc, logs } = await load(t);
  const r = await svc.evaluate('u1', 'ps1');
  assert.equal(r.status, 'READY'); assert.equal(r.source, 'GEMINI');
  assert.equal(r.score, null); assert.equal(r.confidence, null);
  assert.ok(r.summary && r.details.strengths.length === 1 && r.details.recommendations.length === 1);
  assert.equal(r.samplesCount, 1);
  assert.equal(logs.length, 1); assert.equal(logs[0].evaluationResult, 'READY'); assert.equal(logs[0].modelVersion, 'portfolio-review-v1');
});

test('GET latest returns the stored result; none stored -> NOT_ENOUGH_DATA with nothing in it', async (t) => {
  const { svc } = await load(t);
  const none = await svc.latest('u1', 'ps1');
  assert.equal(none.status, 'NOT_ENOUGH_DATA'); assert.equal(none.summary, null); assert.equal(none.details, null);
  await svc.evaluate('u1', 'ps1');
  const got = await svc.latest('u1', 'ps1');
  assert.equal(got.status, 'READY'); assert.ok(got.summary); assert.ok(got.generatedAt);
  assert.equal((await svc.history('u1', 'ps1')).length, 1);
});

test('non-owner is blocked (404) on evaluate, latest and history; nothing is called or stored', async (t) => {
  const { svc, logs, calls } = await load(t);
  for (const fn of [() => svc.evaluate('intruder', 'ps1'), () => svc.latest('intruder', 'ps1'), () => svc.history('intruder', 'ps1')]) {
    await assert.rejects(fn, (e: any) => e.statusCode === 404);
  }
  assert.equal(calls.length, 0); assert.equal(logs.length, 0);
});

test('no samples, or samples with nothing to judge -> NOT_ENOUGH_DATA and the model is never called', async (t) => {
  for (const samples of [[], [{ title: 'نموذج', description: 'قصير', technologies: [], mimeType: 'image/png', proofs: [] }]]) {
    const { svc, calls, logs } = await load(t, { samples });
    const r = await svc.evaluate('u1', 'ps1');
    assert.equal(r.status, 'NOT_ENOUGH_DATA'); assert.equal(r.source, 'NONE'); assert.equal(r.summary, null);
    assert.equal(calls.length, 0); assert.equal(logs.length, 0);
  }
});

test('LLM not configured -> FAILED (HTTP 200 shape), reason NOT_CONFIGURED, nothing stored, no raw error text', async (t) => {
  const { svc, logs } = await load(t, { config: null });
  const r = await svc.evaluate('u1', 'ps1');
  assert.equal(r.status, 'FAILED'); assert.equal(r.unavailableReason, 'NOT_CONFIGURED');
  assert.equal(r.summary, null); assert.equal(r.details, null); assert.equal(r.score, null);
  assert.equal(logs.length, 0);
  assert.doesNotMatch(JSON.stringify(r), /not configured|api.?key|prompt/i);
});

test('model failure or ungrounded output -> FAILED (reason ERROR), nothing stored', async (t) => {
  const bad = await load(t, { respond: () => new Error('boom') });
  const r1 = await bad.svc.evaluate('u1', 'ps1');
  assert.equal(r1.status, 'FAILED'); assert.equal(r1.unavailableReason, 'ERROR'); assert.equal(bad.logs.length, 0);
  const ungrounded = await load(t, { respond: () => ({ summary: 'ملخص', strengths: [{ text: 'يستخدم Kubernetes بنسبة 97٪', basedOn: ['samples[0].technologies'] }], warnings: [], recommendations: [] }) });
  const r2 = await ungrounded.svc.evaluate('u1', 'ps1');
  assert.equal(r2.status, 'FAILED'); assert.equal(ungrounded.logs.length, 0);
});

test('the model payload holds only the allowlisted sample metadata: no emails, phones, links, proof names or user data', async (t) => {
  const calls: any[] = [];
  const { svc } = await load(t, { calls });
  await svc.evaluate('u1', 'ps1');
  const sent = calls[0].user;
  assert.doesNotMatch(sent, /owner@shop\.com|0501234567|my-site\.com|https?:\/\//);
  assert.match(sent, /تطوير الويب/); assert.match(sent, /React/);
  const payload = JSON.parse(sent);
  assert.deepEqual(Object.keys(payload).sort(), ['samples', 'specialty']);
  assert.deepEqual(Object.keys(payload.samples[0]).sort(), ['description', 'fileType', 'proofFilesCount', 'technologies', 'title']);
});

test('concurrent evaluations of the same specialty share ONE model call', async (t) => {
  const { svc, calls, logs } = await load(t);
  const [a, b, c] = await Promise.all([svc.evaluate('u1', 'ps1'), svc.evaluate('u1', 'ps1'), svc.evaluate('u1', 'ps1')]);
  assert.equal(calls.length, 1); assert.equal(logs.length, 1);
  assert.equal(a.status, 'READY'); assert.deepEqual(b, a); assert.deepEqual(c, a);
});

test('asking again with unchanged samples reuses the stored result (no second model call, no second row)', async (t) => {
  const { svc, calls, logs } = await load(t);
  await svc.evaluate('u1', 'ps1');
  const again = await svc.evaluate('u1', 'ps1');
  assert.equal(again.status, 'READY'); assert.equal(calls.length, 1); assert.equal(logs.length, 1);
});

test('advisory only: the service never updates a specialty (no status / tier / badge write)', () => {
  const src = readFileSync(new URL('./specialty-portfolio-review.service.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /providerSpecialty\.(update|updateMany|upsert)|badgeGrantedAt|SpecialtyVerificationStatus/);
});
