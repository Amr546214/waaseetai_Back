import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Accreditation sample submission. AI evaluation is disabled until WaseetAI
// supports it: a submitted sample is stored for human review (MANUAL_REVIEW)
// with no AI fields. `prisma` is mocked; no real DB/network call happens.

function providerProfileFixture(overrides: Partial<any> = {}) {
  return { id: 'profile-1', userId: 'user-1', ...overrides };
}

function providerSpecialtyFixture(overrides: Partial<any> = {}) {
  return {
    id: 'spec-1',
    providerProfileId: 'profile-1',
    isActive: true,
    isPassed: true,
    ownershipCredibility: 60,
    specialty: { nameAr: 'تطوير الويب', nameEn: 'Web Dev', name: 'web', category: { nameAr: 'تقنية' } },
    ...overrides
  };
}

const BASE_DTO = {
  userId: 'user-1',
  providerSpecialtyId: 'spec-1',
  title: 'نظام إدارة المخزون',
  description: 'وصف تقني حقيقي وكامل للمشروع',
  technologiesUsed: ['React', 'Node.js'],
  attachments: ['https://cdn.example.com/proof1.png']
};

async function loadService(t: TestContext, opts: { providerProfile?: any; providerSpecialty?: any }) {
  const accreditationCreateSpy = t.mock.fn(async (args: any) => ({ id: 'sample-1', aiAuditedAt: null, ...args.data }));
  const providerSpecialtyUpdateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const providerSpecialtyUpdateManySpy = t.mock.fn(async () => ({ count: 1 }));
  const prismaMock: any = {
    providerProfile: { findUnique: async () => (opts.providerProfile === undefined ? providerProfileFixture() : opts.providerProfile) },
    providerSpecialty: {
      findFirst: async () => (opts.providerSpecialty === undefined ? providerSpecialtyFixture() : opts.providerSpecialty),
      update: providerSpecialtyUpdateSpy,
      updateMany: providerSpecialtyUpdateManySpy
    },
    accreditationSample: { create: accreditationCreateSpy },
    $transaction: async () => { throw new Error('submission must not need a transaction'); }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const moduleUrl = `./accreditation-ai.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accreditationAiService } = await import(moduleUrl);
  return { accreditationAiService, accreditationCreateSpy, providerSpecialtyUpdateSpy, providerSpecialtyUpdateManySpy };
}

test('submitAccreditationSample: stores the sample as MANUAL_REVIEW with no AI fields, reports AI unavailable, never AI_VERIFIED, never upgrades the specialty', async (t) => {
  const { accreditationAiService, accreditationCreateSpy, providerSpecialtyUpdateSpy, providerSpecialtyUpdateManySpy } = await loadService(t, {});

  const result = await accreditationAiService.submitAccreditationSample(BASE_DTO);

  assert.equal(accreditationCreateSpy.mock.callCount(), 1);
  const data = accreditationCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.status, 'MANUAL_REVIEW');
  for (const key of ['aiScore', 'aiQualityRating', 'aiFeedbackAr', 'aiStrengths', 'aiRecommendations', 'aiAuditedAt']) {
    assert.equal(key in data, false, `${key} must not be written`);
  }
  assert.equal(result.evaluation, null);
  assert.equal(result.aiEvaluation.available, false);
  assert.equal(result.aiEvaluation.code, 'AI_FEATURE_UNAVAILABLE');
  assert.equal(providerSpecialtyUpdateSpy.mock.callCount(), 0);
  assert.equal(providerSpecialtyUpdateManySpy.mock.callCount(), 0);
});

test('submitAccreditationSample: throws when the provider profile does not exist, writing nothing', async (t) => {
  const { accreditationAiService, accreditationCreateSpy } = await loadService(t, { providerProfile: null });
  await assert.rejects(() => accreditationAiService.submitAccreditationSample(BASE_DTO), /Provider profile not found/);
  assert.equal(accreditationCreateSpy.mock.callCount(), 0);
});

test('submitAccreditationSample: throws when the specialty is not linked to this provider', async (t) => {
  const { accreditationAiService, accreditationCreateSpy } = await loadService(t, { providerSpecialty: null });
  await assert.rejects(() => accreditationAiService.submitAccreditationSample(BASE_DTO));
  assert.equal(accreditationCreateSpy.mock.callCount(), 0);
});

test('submitAccreditationSample: throws when the specialty has not passed its technical test yet', async (t) => {
  const { accreditationAiService, accreditationCreateSpy } = await loadService(t, { providerSpecialty: providerSpecialtyFixture({ isPassed: false }) });
  await assert.rejects(() => accreditationAiService.submitAccreditationSample(BASE_DTO));
  assert.equal(accreditationCreateSpy.mock.callCount(), 0);
});

test('submitAccreditationSample: requires at least one piece of evidence', async (t) => {
  const { accreditationAiService, accreditationCreateSpy } = await loadService(t, {});
  await assert.rejects(() => accreditationAiService.submitAccreditationSample({ ...BASE_DTO, attachments: [] }));
  assert.equal(accreditationCreateSpy.mock.callCount(), 0);
});

test('accreditation-ai service and routes have no Gemini reference and no AI_VERIFIED assignment on submit', () => {
  const svc = readFileSync(new URL('./accreditation-ai.service.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const routes = readFileSync(new URL('../routes/accreditation-ai.routes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(svc, /gemini|remote-image-fetch|generateStructured/i);
  assert.doesNotMatch(routes, /gemini/i);
  assert.match(routes, /submitAccreditationSample/);
});

test('adminApproveSample/adminRejectSample: the existing manual/deterministic authority path remains intact and unchanged (requirement 3)', async (t) => {
  const sampleUpdateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const specialtyUpdateManySpy = t.mock.fn(async () => ({ count: 1 }));
  const tx = {
    accreditationSample: { update: sampleUpdateSpy },
    providerSpecialty: { updateMany: specialtyUpdateManySpy }
  };
  const prismaMock: any = {
    accreditationSample: {
      findUnique: async () => ({ id: 'sample-1', status: 'PENDING_AI_AUDIT', providerSpecialtyId: 'spec-1', aiScore: 60, aiFeedbackAr: 'ملاحظة' })
    },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const moduleUrl = `./accreditation-ai.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accreditationAiService } = await import(moduleUrl);

  await accreditationAiService.adminApproveSample('sample-1');
  assert.equal(sampleUpdateSpy.mock.calls[0].arguments[0].data.status, 'AI_VERIFIED');
  assert.equal(specialtyUpdateManySpy.mock.calls[0].arguments[0].data.status, 'APPROVED');
  assert.equal(specialtyUpdateManySpy.mock.calls[0].arguments[0].data.isPassed, true);

  await accreditationAiService.adminRejectSample('sample-1', 'سبب حقيقي للرفض');
  assert.equal(sampleUpdateSpy.mock.calls[1].arguments[0].data.status, 'REJECTED');
  assert.equal(specialtyUpdateManySpy.mock.calls[1].arguments[0].data.status, 'REJECTED');
});

// ── Phase 3 authority fix: F15 -> F16 explicit-confirmation workflow ──

test('adminApproveSample: an AI_VERIFIED sample whose ProviderSpecialty is NOT yet approved can still be explicitly approved by an admin, and badgeGrantedAt is populated', async (t) => {
  const sampleUpdateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const specialtyUpdateManySpy = t.mock.fn(async () => ({ count: 1 }));
  const tx = {
    accreditationSample: { update: sampleUpdateSpy },
    providerSpecialty: { updateMany: specialtyUpdateManySpy }
  };
  const prismaMock: any = {
    accreditationSample: {
      // The sample already carries the AI's own AI_VERIFIED label (a real
      // score >= 75 was recorded by evaluateAccreditationSample), but the
      // linked specialty has genuinely never been approved yet.
      findUnique: async () => ({
        id: 'sample-1', status: 'AI_VERIFIED', providerSpecialtyId: 'spec-1', aiScore: 88, aiFeedbackAr: 'ملاحظة',
        providerSpecialty: { status: 'TEST_REQUIRED' }
      })
    },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const moduleUrl = `./accreditation-ai.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accreditationAiService } = await import(moduleUrl);

  await accreditationAiService.adminApproveSample('sample-1');

  assert.equal(specialtyUpdateManySpy.mock.callCount(), 1, 'the explicit admin action is what performs the real upgrade');
  assert.equal(specialtyUpdateManySpy.mock.calls[0].arguments[0].data.status, 'APPROVED');
  assert.equal(specialtyUpdateManySpy.mock.calls[0].arguments[0].data.isPassed, true);
  assert.ok(specialtyUpdateManySpy.mock.calls[0].arguments[0].data.badgeGrantedAt instanceof Date, 'badgeGrantedAt is populated by the existing logic');
});

test('adminApproveSample: a second approval attempt is rejected based on the REAL ProviderSpecialty approval state, not the sample\'s own AI_VERIFIED label', async (t) => {
  const sampleUpdateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const specialtyUpdateManySpy = t.mock.fn(async () => ({ count: 1 }));
  const tx = {
    accreditationSample: { update: sampleUpdateSpy },
    providerSpecialty: { updateMany: specialtyUpdateManySpy }
  };
  const prismaMock: any = {
    accreditationSample: {
      // The specialty was already approved (e.g. by a prior admin action on
      // a different sample) — this must block re-approval even though this
      // particular sample's own status is still just AI_VERIFIED.
      findUnique: async () => ({
        id: 'sample-2', status: 'AI_VERIFIED', providerSpecialtyId: 'spec-1', aiScore: 90, aiFeedbackAr: 'ملاحظة',
        providerSpecialty: { status: 'APPROVED' }
      })
    },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const moduleUrl = `./accreditation-ai.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accreditationAiService } = await import(moduleUrl);

  await assert.rejects(
    () => accreditationAiService.adminApproveSample('sample-2'),
    (err: any) => { assert.equal(err.statusCode, 409); return true; }
  );
  assert.equal(sampleUpdateSpy.mock.callCount(), 0, 'no write should happen once the real specialty state already reflects approval');
  assert.equal(specialtyUpdateManySpy.mock.callCount(), 0);
});

test('adminRejectSample: rejecting one sample never downgrades a ProviderSpecialty that a different sample already had approved', async (t) => {
  const sampleUpdateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const specialtyUpdateManySpy = t.mock.fn(async (args: any) => ({ count: args.where.status?.not === 'APPROVED' ? 0 : 1 }));
  const tx = {
    accreditationSample: { update: sampleUpdateSpy },
    providerSpecialty: { updateMany: specialtyUpdateManySpy }
  };
  const prismaMock: any = {
    accreditationSample: {
      findUnique: async () => ({ id: 'sample-3', status: 'MANUAL_REVIEW', providerSpecialtyId: 'spec-1', aiFeedbackAr: '' })
    },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const moduleUrl = `./accreditation-ai.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accreditationAiService } = await import(moduleUrl);

  await accreditationAiService.adminRejectSample('sample-3', 'سبب حقيقي للرفض');

  assert.equal(sampleUpdateSpy.mock.calls[0].arguments[0].data.status, 'REJECTED');
  // The updateMany call itself already scopes to status:{not:'APPROVED'} —
  // asserting the exact where-clause here proves this reject path can never
  // touch an already-approved specialty, regardless of which sample it came from.
  assert.deepEqual(specialtyUpdateManySpy.mock.calls[0].arguments[0].where, { id: 'spec-1', status: { not: 'APPROVED' } });
});

// Final AI cleanup batch (F11): the dead proof-image socket handler this
// service used to back (`processProofImage`, hardcoding
// `authenticityScore: 92, qualityScore: 90, verdict: 'APPROVED'` on every
// call with zero real evaluation) has been removed entirely, along with its
// socket gateway. This guards against it silently reappearing.
test('accreditationAiService: the removed fake processProofImage method (hardcoded 92/90/APPROVED) must never reappear', async (t) => {
  const { accreditationAiService } = await loadService(t, {});
  assert.equal((accreditationAiService as any).processProofImage, undefined);
});
