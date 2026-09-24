import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// F10 (evaluateAccreditationSample) — Batch: F9+F10 Vision migration to the
// shared Gemini foundation. `prisma`, `geminiClient`, and `fetchRemoteImage`
// are all mocked; no real DB/network call ever happens.

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

function validEvaluationFixture(overrides: Partial<any> = {}) {
  return {
    aiScore: 88,
    status: 'AI_VERIFIED',
    aiQualityRating: 'EXCELLENT',
    feedbackAr: 'تقييم حقيقي من Gemini',
    strengths: ['قوة 1'],
    recommendations: ['توصية 1'],
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

async function loadService(t: TestContext, opts: {
  providerProfile?: any;
  providerSpecialty?: any;
  isConfigured?: boolean;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
  generateStructuredWithImage?: (prompt: string, options: any) => Promise<any>;
  fetchRemoteImage?: (url: string, options?: any) => Promise<any>;
}) {
  const accreditationCreateSpy = t.mock.fn(async (args: any) => ({ id: 'sample-1', aiAuditedAt: new Date('2026-01-01'), ...args.data }));
  const providerSpecialtyUpdateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const tx = {
    accreditationSample: { create: accreditationCreateSpy },
    providerSpecialty: { update: providerSpecialtyUpdateSpy }
  };
  const prismaMock: any = {
    providerProfile: { findUnique: async () => (opts.providerProfile === undefined ? providerProfileFixture() : opts.providerProfile) },
    providerSpecialty: { findFirst: async () => (opts.providerSpecialty === undefined ? providerSpecialtyFixture() : opts.providerSpecialty) },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    isConfigured: () => opts.isConfigured ?? true,
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); }),
    generateStructuredWithImage: opts.generateStructuredWithImage ?? (async () => { throw new Error('generateStructuredWithImage not stubbed for this test'); })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const fetchRemoteImageMock = opts.fetchRemoteImage ?? (async (url: string) => ({ mimeType: 'image/png', data: Buffer.from(`bytes-for-${url}`) }));
  t.mock.module('../utils/remote-image-fetch', { namedExports: { fetchRemoteImage: fetchRemoteImageMock } });

  const moduleUrl = `./accreditation-ai.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { accreditationAiService } = await import(moduleUrl);
  return { accreditationAiService, accreditationCreateSpy, providerSpecialtyUpdateSpy };
}

test('evaluateAccreditationSample: a genuine validated AI_VERIFIED success persists the real score and upgrades the ProviderSpecialty', async (t) => {
  const evaluation = validEvaluationFixture();
  let capturedImages: any;
  const { accreditationAiService, accreditationCreateSpy, providerSpecialtyUpdateSpy } = await loadService(t, {
    generateStructuredWithImage: async (_prompt, options) => {
      capturedImages = options.images;
      assert.equal(options.validate(evaluation), true, 'the real validator must accept a well-formed evaluation');
      return { data: evaluation, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
    }
  });

  const result = await accreditationAiService.evaluateAccreditationSample(BASE_DTO);

  assert.equal(result.evaluation.aiScore, 88);
  assert.equal(result.evaluation.status, 'AI_VERIFIED');
  assert.equal(capturedImages.length, 1);

  const createArgs = accreditationCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(createArgs.aiScore, 88);
  assert.equal(createArgs.status, 'AI_VERIFIED');
  assert.equal(providerSpecialtyUpdateSpy.mock.callCount(), 1, 'ProviderSpecialty is only upgraded when AI_VERIFIED');
});

test('evaluateAccreditationSample: a genuine validated but below-threshold score is REJECTED honestly, without upgrading ProviderSpecialty', async (t) => {
  const evaluation = validEvaluationFixture({ aiScore: 60, status: 'REJECTED', aiQualityRating: 'POOR' });
  const { accreditationAiService, accreditationCreateSpy, providerSpecialtyUpdateSpy } = await loadService(t, {
    generateStructuredWithImage: async () => ({ data: evaluation, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  });

  const result = await accreditationAiService.evaluateAccreditationSample(BASE_DTO);

  assert.equal(result.evaluation.status, 'REJECTED');
  assert.equal(accreditationCreateSpy.mock.calls[0].arguments[0].data.status, 'REJECTED');
  assert.equal(providerSpecialtyUpdateSpy.mock.callCount(), 0);
});

test('evaluateAccreditationSample: an unfetchable attachment image is skipped (best-effort) and evaluation proceeds text-only', async (t) => {
  const evaluation = validEvaluationFixture();
  let withImageCalled = false;
  let structuredCalled = false;
  const { accreditationAiService } = await loadService(t, {
    fetchRemoteImage: async () => { throw new Error('image fetch failed'); },
    generateStructured: async () => { structuredCalled = true; return { data: evaluation, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; },
    generateStructuredWithImage: async () => { withImageCalled = true; throw new Error('should never be called'); }
  });

  await accreditationAiService.evaluateAccreditationSample(BASE_DTO);

  assert.equal(structuredCalled, true);
  assert.equal(withImageCalled, false);
});

test('evaluateAccreditationSample: Gemini not configured routes to the existing honest manual-review path (score 0), never a fake positive score', async (t) => {
  const { accreditationAiService, accreditationCreateSpy, providerSpecialtyUpdateSpy } = await loadService(t, { isConfigured: false });

  const result = await accreditationAiService.evaluateAccreditationSample(BASE_DTO);

  assert.equal(result.evaluation.status, 'MANUAL_REVIEW');
  assert.equal(result.evaluation.aiScore, 0);
  const createArgs = accreditationCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(createArgs.status, 'MANUAL_REVIEW');
  assert.equal(createArgs.aiScore, 0);
  assert.equal(providerSpecialtyUpdateSpy.mock.callCount(), 0);
});

test('evaluateAccreditationSample: Gemini throwing routes to the same honest manual-review path, never a fabricated evaluation', async (t) => {
  const { accreditationAiService, accreditationCreateSpy } = await loadService(t, {
    generateStructuredWithImage: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  const result = await accreditationAiService.evaluateAccreditationSample(BASE_DTO);

  assert.equal(result.evaluation.status, 'MANUAL_REVIEW');
  assert.equal(result.evaluation.aiScore, 0);
  assert.doesNotMatch(JSON.stringify(result), /التزام ممتاز بالبنية المعمارية|85/, 'the old silently-patched fallback values must never reappear');
  assert.equal(accreditationCreateSpy.mock.callCount(), 1, 'the sample row is still recorded with the honest manual-review outcome');
});

test('evaluateAccreditationSample: a malformed Gemini response (missing/invalid aiScore) is rejected by the real validator, not silently patched to 85', async (t) => {
  const malformed = { status: 'AI_VERIFIED', aiQualityRating: 'EXCELLENT', feedbackAr: 'x', strengths: [], recommendations: [] }; // aiScore missing entirely
  const { accreditationAiService } = await loadService(t, {
    generateStructuredWithImage: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await accreditationAiService.evaluateAccreditationSample(BASE_DTO);

  assert.equal(result.evaluation.status, 'MANUAL_REVIEW');
  assert.equal(result.evaluation.aiScore, 0);
});

test('evaluateAccreditationSample: a malformed Gemini response (fabricated-looking hardcoded strengths) is still rejected when other fields are invalid', async (t) => {
  const malformed = { aiScore: 999, status: 'AI_VERIFIED', aiQualityRating: 'EXCELLENT', feedbackAr: 'x', strengths: ['التزام ممتاز بالبنية المعمارية'], recommendations: [] };
  const { accreditationAiService } = await loadService(t, {
    generateStructuredWithImage: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await accreditationAiService.evaluateAccreditationSample(BASE_DTO);
  assert.equal(result.evaluation.status, 'MANUAL_REVIEW');
});

// ── ownership ──────────────────────────────────────────────────────────────

test('evaluateAccreditationSample: throws when the provider profile does not exist, without ever calling Gemini', async (t) => {
  let called = false;
  const { accreditationAiService } = await loadService(t, {
    providerProfile: null,
    generateStructuredWithImage: async () => { called = true; throw new Error('should never be called'); }
  });

  await assert.rejects(() => accreditationAiService.evaluateAccreditationSample(BASE_DTO));
  assert.equal(called, false);
});

test('evaluateAccreditationSample: throws when the specialty is not linked to this provider profile, without ever calling Gemini', async (t) => {
  let called = false;
  const { accreditationAiService } = await loadService(t, {
    providerSpecialty: null,
    generateStructuredWithImage: async () => { called = true; throw new Error('should never be called'); }
  });

  await assert.rejects(() => accreditationAiService.evaluateAccreditationSample(BASE_DTO));
  assert.equal(called, false);
});

test('evaluateAccreditationSample: throws when the specialty has not passed its technical test yet, without ever calling Gemini', async (t) => {
  let called = false;
  const { accreditationAiService } = await loadService(t, {
    providerSpecialty: providerSpecialtyFixture({ isPassed: false }),
    generateStructuredWithImage: async () => { called = true; throw new Error('should never be called'); }
  });

  await assert.rejects(() => accreditationAiService.evaluateAccreditationSample(BASE_DTO));
  assert.equal(called, false);
});
