import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// The ADVISORY AI review of an accreditation sample, through the real production path (nothing is skipped under test):
// `prisma` is mocked and the AI client / proof reader are the module's own injectable dependencies.

const DTO = {
  userId: 'user-1', providerSpecialtyId: 'spec-1', title: 'نظام مخزون', description: 'وصف تقني حقيقي وكامل للمشروع',
  technologiesUsed: ['React'], attachments: [] as string[], proofIds: ['up-1', 'up-2', 'up-3']
};
const PROOFS = [
  { id: 'up-1', privateRef: 'private:image:png:waseetai/accreditation/user-1/proofs/p1', fileName: 'screen.png' },
  { id: 'up-2', privateRef: 'private:raw:pdf:waseetai/accreditation/user-1/proofs/p2', fileName: 'report.pdf' },
  { id: 'up-3', privateRef: 'private:raw:zip:waseetai/accreditation/user-1/proofs/p3', fileName: 'source.zip' },
];
const META = [
  { id: 'up-1', mimeType: 'image/png', bytes: 1000 },
  { id: 'up-2', mimeType: 'application/pdf', bytes: 5000 },
  { id: 'up-3', mimeType: 'application/zip', bytes: 9000 },
];

async function load(t: TestContext, opts: { review?: (body: any) => Promise<any>; readProof?: (ref: string, mime: string) => Promise<string>; updateManyCount?: number } = {}) {
  const reviewCalls: any[] = [];
  const updateManyCalls: any[] = [];
  const created: any = { id: 'sample-1', revision: 3, status: 'MANUAL_REVIEW', aiScore: null };
  const prismaMock: any = {
    providerProfile: { findUnique: async () => ({ id: 'profile-1', userId: 'user-1' }) },
    providerSpecialty: {
      findFirst: async () => ({ id: 'spec-1', specialtyId: 'catalog-spec-9', providerProfileId: 'profile-1', isActive: true, isPassed: true, specialty: { nameAr: 'تطوير الويب', category: { nameAr: 'تقنية' } } }),
      updateMany: async () => ({ count: 1 }),
    },
    accreditationSample: {
      findFirst: async () => null,
      updateMany: async (args: any) => { updateManyCalls.push(args); return { count: opts.updateManyCount ?? 1 }; },
      findUnique: async () => ({ ...created, aiScore: 77, aiQualityRating: 'Good', aiFeedbackAr: 'ملخص', status: 'MANUAL_REVIEW' }),
    },
    accreditationProofUpload: { findMany: async (args: any) => (args?.select?.mimeType ? META : PROOFS.map(p => ({ ...p, status: 'COMPLETED', userId: 'user-1', providerSpecialtyId: 'spec-1', sampleId: null }))) },
    $transaction: async (fn: any) => fn({
      $executeRaw: async () => 0,
      accreditationSample: { create: async () => created, findFirst: async () => null, update: async () => created },
      accreditationProofUpload: { updateMany: async () => ({ count: 3 }) },
      accreditationSampleEvent: { create: async () => ({}) },
      providerSpecialty: { updateMany: async () => ({ count: 1 }) },
    }),
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./accreditation-proof.service', { namedExports: {
    resolveProofsForSubmission: async () => ({ uploads: PROOFS, urls: PROOFS.map(p => p.privateRef) }),
    buildAdminProofList: async () => [], publicLegacyAttachments: () => [],
  } });
  const mod = await import(`./accreditation-ai.service.ts?fixture=${Date.now()}-${Math.random()}`);
  mod.accreditationAiDeps.client = { isConfigured: () => true, reviewAccreditation: async (body: any) => { reviewCalls.push(body); return (opts.review ?? (async () => ({})))(body); } };
  mod.accreditationAiDeps.readProof = opts.readProof ?? (async (_ref: string, mime: string) => `data:${mime};base64,QUJD`);
  return { svc: mod.accreditationAiService, reviewCalls, updateManyCalls, created };
}

const evidenceReview = async () => ({ inspected: true, status: 'MANUAL_REVIEW', evaluation: { aiScore: 77, aiQualityRating: 'Good', feedbackAr: 'ملخص مبني على الملفات' }, feedback: { summary: 'ملخص' } });

test('the user\'s OWN proof content and the specialty reach the AI service; files it cannot read are reported, not guessed', async (t) => {
  const { svc, reviewCalls } = await load(t, { review: evidenceReview });
  await svc.submitAccreditationSample(DTO);
  assert.equal(reviewCalls.length, 1);
  const body = reviewCalls[0];
  assert.deepEqual(body.attachments, ['data:image/png;base64,QUJD', 'data:application/pdf;base64,QUJD']);
  assert.deepEqual(body.unreadAttachments, ['source.zip']);
  assert.equal(body.specialtyName, 'تطوير الويب');
  assert.equal(body.specialtyId, 'catalog-spec-9');
  assert.equal(body.sampleId, 'sample-1');
});

test('a proof that cannot be read from storage goes to unreadAttachments and the review still runs', async (t) => {
  const { svc, reviewCalls } = await load(t, { review: evidenceReview, readProof: async (ref) => { if (ref.includes('/p2')) throw new Error('HTTP_404'); return 'data:image/png;base64,QUJD'; } });
  await svc.submitAccreditationSample(DTO);
  assert.deepEqual(reviewCalls[0].attachments, ['data:image/png;base64,QUJD']);
  assert.deepEqual(reviewCalls[0].unreadAttachments, ['report.pdf', 'source.zip']);
});

test('an evidence-based answer is stored ONLY for the same revision, still waiting for review and undecided; the sample stays MANUAL_REVIEW', async (t) => {
  const { svc, updateManyCalls } = await load(t, { review: evidenceReview });
  const res = await svc.submitAccreditationSample(DTO);
  assert.equal(updateManyCalls.length, 1);
  const { where, data } = updateManyCalls[0];
  assert.deepEqual([where.id, where.revision, where.status, where.decidedAt], ['sample-1', 3, 'MANUAL_REVIEW', null]);
  assert.equal(data.aiScore, 77);
  assert.equal(data.aiQualityRating, 'Good');
  assert.equal(res.sample.status, 'MANUAL_REVIEW');
  assert.equal(res.aiEvaluation.available, true);
});

test('a LATE answer (the sample was decided or resubmitted meanwhile) is dropped and never overwrites the newer state', async (t) => {
  const { svc, updateManyCalls } = await load(t, { review: evidenceReview, updateManyCount: 0 });
  const res = await svc.submitAccreditationSample(DTO);
  assert.equal(updateManyCalls.length, 1);
  assert.equal(res.evaluation, null);
  assert.equal(res.aiEvaluation.available, false);
  assert.equal(res.aiEvaluation.superseded, true);
  assert.equal(res.sample.aiScore, null, 'the returned sample is the stored one, without the late score');
});

test('an answer that read no evidence never writes a score or rating (a written description\'s clarity is not a quality score)', async (t) => {
  const { svc, updateManyCalls } = await load(t, { review: async () => ({ inspected: false, evaluation: { aiScore: 88, aiQualityRating: 'Excellent', feedbackAr: 'وصف مرتب لكن لم تُقرأ أدلة' } }) });
  await svc.submitAccreditationSample(DTO);
  assert.equal(updateManyCalls.length, 1);
  assert.equal('aiScore' in updateManyCalls[0].data, false);
  assert.equal('aiQualityRating' in updateManyCalls[0].data, false);
  assert.equal(updateManyCalls[0].data.aiFeedbackAr, 'وصف مرتب لكن لم تُقرأ أدلة');
});

test('an AI service failure leaves the stored MANUAL_REVIEW sample and reports the review as unavailable', async (t) => {
  const { svc, updateManyCalls } = await load(t, { review: async () => { throw new Error('upstream down'); } });
  const res = await svc.submitAccreditationSample(DTO);
  assert.equal(updateManyCalls.length, 0);
  assert.equal(res.evaluation, null);
  assert.equal(res.aiEvaluation.available, false);
  assert.equal(res.sample.status, 'MANUAL_REVIEW');
});
