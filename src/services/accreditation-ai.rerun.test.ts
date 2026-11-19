import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Admin re-run of the advisory AI review on an existing sample, through the real service path (prisma mocked; the AI client / proof reader are the
// module's injectable dependencies).

const UPLOADS = [{ id: 'up-1', privateRef: 'private:image:png:waseetai/accreditation/u1/proofs/p1', fileName: 'screen.png' }];
const sampleRow = (over: any = {}) => ({
  id: 's1', revision: 2, status: 'AI_VERIFIED', decidedAt: new Date(), aiScore: null, aiQualityRating: null, title: 'نظام', description: 'وصف طويل كفاية للنموذج',
  technologiesUsed: ['React'], projectUrl: null, githubUrl: null, providerSpecialtyId: 'ps1',
  providerProfile: { userId: 'u1' }, providerSpecialty: { specialtyId: 'sp1', specialty: { nameAr: 'تطوير الويب' } }, proofUploads: UPLOADS, ...over,
});

async function load(t: TestContext, opts: { sample?: any; review?: () => Promise<any>; updateCount?: number; configured?: boolean } = {}) {
  const updates: any[] = []; const events: any[] = []; const audits: any[] = []; const reviews: any[] = [];
  const prismaMock: any = {
    accreditationSample: {
      findUnique: async () => (opts.sample === undefined ? sampleRow() : opts.sample),
      updateMany: async (args: any) => { updates.push(args); return { count: opts.updateCount ?? 1 }; },
    },
    accreditationSampleEvent: { create: async (a: any) => { events.push(a); return {}; } },
    accountAuditLog: { create: async (a: any) => { audits.push(a); return {}; } },
    providerSpecialty: { updateMany: async () => { throw new Error('the specialty must never be touched by a re-run'); } },
    accreditationProofUpload: { findMany: async () => [{ id: 'up-1', mimeType: 'image/png', bytes: 100 }] },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const mod = await import(`./accreditation-ai.service.ts?fixture=${Date.now()}-${Math.random()}`);
  mod.accreditationAiDeps.client = { isConfigured: () => opts.configured ?? true, reviewAccreditation: async (b: any) => { reviews.push(b); return (opts.review ?? (async () => ({})))(); } };
  mod.accreditationAiDeps.readProof = async (_r: string, mime: string) => `data:${mime};base64,QUJD`;
  return { svc: mod.accreditationAiService, updates, events, audits, reviews };
}
const scored = async () => ({ inspected: true, evaluation: { aiScore: 81.4, aiQualityRating: 'Good', feedbackAr: 'ملخص مبني على الملفات' }, feedback: {} });
const ACTOR = { id: 'admin-1', role: 'ADMIN' } as any;

test('an approved sample gets its AI score: only advisory fields are written, same revision, decision and specialty untouched', async t => {
  const { svc, updates, events, audits, reviews } = await load(t, { review: scored });
  const out = await svc.adminRerunAiReview('s1', ACTOR);
  assert.equal(out.updated, true); assert.equal(out.aiScore, 81); assert.equal(out.aiQualityRating, 'Good');
  assert.equal(reviews[0].specialtyName, 'تطوير الويب'); assert.equal(reviews[0].attachments.length, 1);
  assert.deepEqual(updates[0].where, { id: 's1', revision: 2 });
  assert.deepEqual(Object.keys(updates[0].data).sort(), ['aiAuditedAt', 'aiFeedbackAr', 'aiQualityRating', 'aiScore']);
  assert.equal(events[0].data.kind, 'AI_RERUN'); assert.equal(events[0].data.actorId, 'admin-1');
  assert.equal(audits[0].data.eventType, 'ACCREDITATION_AI_RERUN');
});

test('no readable evidence: no score is invented and an existing score is not erased', async t => {
  const unread = async () => ({ inspected: false, evaluation: { aiScore: null, feedbackAr: null }, feedback: {} });
  const { svc, updates } = await load(t, { review: unread, sample: sampleRow({ aiScore: 70, aiQualityRating: 'Good' }) });
  const out = await svc.adminRerunAiReview('s1', ACTOR);
  assert.equal(out.updated, false); assert.equal(out.aiScore, 70); assert.equal(updates.length, 0);
});

test('feedback without a score updates the note only and keeps the old score', async t => {
  const noScore = async () => ({ inspected: false, evaluation: { aiScore: null, feedbackAr: 'تعذّرت القراءة' }, feedback: {} });
  const { svc, updates } = await load(t, { review: noScore, sample: sampleRow({ aiScore: 70 }) });
  const out = await svc.adminRerunAiReview('s1', ACTOR);
  assert.equal(out.updated, true); assert.equal(out.scored, false); assert.equal(out.aiScore, 70);
  assert.ok(!('aiScore' in updates[0].data));
});

test('guard: a missing sample is 404', async t => {
  await assert.rejects((await load(t, { sample: null })).svc.adminRerunAiReview('x', ACTOR), (e: any) => e.statusCode === 404);
});
test('guard: a sample without proof files is 422', async t => {
  await assert.rejects((await load(t, { sample: sampleRow({ proofUploads: [] }) })).svc.adminRerunAiReview('s1', ACTOR), (e: any) => e.statusCode === 422);
});
test('guard: AI not configured is 503', async t => {
  await assert.rejects((await load(t, { configured: false })).svc.adminRerunAiReview('s1', ACTOR), (e: any) => e.statusCode === 503);
});
test('guard: an AI failure is 502 and writes nothing', async t => {
  const failing = await load(t, { review: async () => { throw new Error('boom'); } });
  await assert.rejects(failing.svc.adminRerunAiReview('s1', ACTOR), (e: any) => e.statusCode === 502);
  assert.equal(failing.updates.length, 0); assert.equal(failing.events.length, 0);
});
test('guard: a revision that changed while the AI ran is 409 and records no event', async t => {
  const stale = await load(t, { review: scored, updateCount: 0 });
  await assert.rejects(stale.svc.adminRerunAiReview('s1', ACTOR), (e: any) => e.statusCode === 409);
  assert.equal(stale.events.length, 0);
});

test('a second re-run of the same sample while one is running is refused', async t => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const { svc } = await load(t, { review: async () => { await gate; return scored(); } });
  const first = svc.adminRerunAiReview('s1', ACTOR);
  await new Promise(r => setTimeout(r, 20));
  await assert.rejects(svc.adminRerunAiReview('s1', ACTOR), (e: any) => e.statusCode === 409);
  release(); await first;
});
