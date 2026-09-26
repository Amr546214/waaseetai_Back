import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// F12 (AI Assessment REST) — Batch: F12+F13+F14 assessment pipeline
// migration to the shared Gemini foundation. `prisma`, `geminiClient`, and
// `aiAssessmentAnalyzerService` are all mocked; no real DB/network call
// happens.

function providerSpecialtyFixture(overrides: Partial<any> = {}) {
  return {
    id: 'spec-1',
    specialtyId: 'specialty-1',
    providerProfileId: 'profile-1',
    subSpecialties: ['React'],
    specialty: { nameAr: 'تطوير الويب', name: 'web', category: { nameAr: 'تقنية' } },
    providerProfile: { user: {}, portfolioItems: [], certificates: [] },
    workSamples: [],
    ...overrides
  };
}

function validQuestion(id: number) {
  return {
    id,
    textAr: `سؤال ${id}`,
    options: [{ id: 'a', text: 'أ' }, { id: 'b', text: 'ب' }, { id: 'c', text: 'ج' }, { id: 'd', text: 'د' }],
    correctAnswer: 'b',
    explanation: 'شرح',
    assessmentArea: 'التخصص الرئيسي'
  };
}

async function loadService(t: TestContext, opts: {
  providerSpecialty?: any;
  attempt?: any;
  generate20Questions?: (input: any) => Promise<any>;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
  createSpy?: any;
}) {
  const createSpy = opts.createSpy ?? t.mock.fn(async (args: any) => ({ id: 'attempt-1', ...args.data }));
  const updateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const tx = {
    assessmentAttempt: { update: updateSpy },
    providerSpecialty: { update: updateSpy, count: async () => 0 },
    user: { update: async () => ({}) }
  };
  const prismaMock: any = {
    providerSpecialty: { findFirst: async () => (opts.providerSpecialty === undefined ? providerSpecialtyFixture() : opts.providerSpecialty) },
    assessmentAttempt: {
      create: createSpy,
      findUnique: async () => (opts.attempt === undefined ? null : opts.attempt)
    },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const analyzerMock = {
    generate20Questions: opts.generate20Questions ?? (async () => ({
      questions: Array.from({ length: 20 }, (_, i) => validQuestion(i + 1)),
      subSpecialtiesSnapshot: ['React'],
      analyzedAssetsSnapshot: [],
      generationSource: 'GEMINI'
    })),
    generateFallback20Questions: () => Array.from({ length: 20 }, (_, i) => validQuestion(i + 1))
  };
  t.mock.module('./ai-assessment-analyzer.service', { namedExports: { aiAssessmentAnalyzerService: analyzerMock } });

  const moduleUrl = `./ai-assessment.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { aiAssessmentService } = await import(moduleUrl);
  return { aiAssessmentService, createSpy, updateSpy };
}

test('generateAssessment: a real Gemini success persists real snapshot metadata + generationSource and returns sanitized questions', async (t) => {
  const { aiAssessmentService, createSpy } = await loadService(t, {});

  const result = await aiAssessmentService.generateAssessment('spec-1', 'user-1');

  assert.equal(result.generationSource, 'GEMINI');
  assert.equal(result.questions.length, 20);
  assert.equal('correctAnswer' in result.questions[0], false, 'correctAnswer must be stripped before reaching the frontend');
  assert.equal('explanation' in result.questions[0], false, 'explanation must be stripped before reaching the frontend');

  const createArgs = createSpy.mock.calls[0].arguments[0].data;
  assert.deepEqual(createArgs.subSpecialtiesSnapshot, ['React']);
  assert.equal(createArgs.analyzedAssetsSnapshot.generationSource, 'GEMINI');
});

test('generateAssessment: a static-fallback generation is honestly persisted and returned as STATIC_FALLBACK', async (t) => {
  const { aiAssessmentService, createSpy } = await loadService(t, {
    generate20Questions: async () => ({
      questions: Array.from({ length: 20 }, (_, i) => validQuestion(i + 1)),
      subSpecialtiesSnapshot: ['React'],
      analyzedAssetsSnapshot: [],
      generationSource: 'STATIC_FALLBACK'
    })
  });

  const result = await aiAssessmentService.generateAssessment('spec-1', 'user-1');

  assert.equal(result.generationSource, 'STATIC_FALLBACK');
  assert.equal(createSpy.mock.calls[0].arguments[0].data.analyzedAssetsSnapshot.generationSource, 'STATIC_FALLBACK');
});

test('generateAssessment: throws when the provider specialty is not owned by the current user, without generating anything', async (t) => {
  let called = false;
  const { aiAssessmentService } = await loadService(t, {
    providerSpecialty: null,
    generate20Questions: async () => { called = true; throw new Error('should never be called'); }
  });

  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'someone-else'));
  assert.equal(called, false);
});

function attemptFixture(overrides: Partial<any> = {}) {
  return {
    id: 'attempt-1',
    providerSpecialtyId: 'spec-1',
    providerProfileId: 'profile-1',
    status: 'IN_PROGRESS',
    startedAt: new Date(),
    timeLimitMinutes: 15,
    questionsPayload: Array.from({ length: 4 }, (_, i) => validQuestion(i + 1)),
    providerSpecialty: {
      providerProfileId: 'profile-1',
      specialty: { nameAr: 'تطوير الويب' },
      providerProfile: { userId: 'user-1' }
    },
    ...overrides
  };
}

test('submitAssessment: a real validated Gemini feedback success is used and persisted', async (t) => {
  const feedback = { feedbackAr: 'ملاحظة حقيقية', strengths: ['قوة'], weaknesses: [] };
  const { aiAssessmentService, updateSpy } = await loadService(t, {
    attempt: attemptFixture(),
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(feedback), true);
      return { data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1');

  assert.equal(result.feedbackAr, 'ملاحظة حقيقية');
  assert.equal(result.isPassed, true);
  const updateArgs = updateSpy.mock.calls.find((c: any) => c.arguments[0].data.feedbackAr)?.arguments[0];
  assert.equal(updateArgs.data.feedbackAr, 'ملاحظة حقيقية');
});

test('submitAssessment: Gemini feedback failure falls back to the deterministic real-outcome feedback (score/pass are always real, never fabricated)', async (t) => {
  const { aiAssessmentService } = await loadService(t, {
    attempt: attemptFixture(),
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  const result = await aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1');

  assert.equal(result.isPassed, true);
  assert.equal(result.score, 100);
  assert.match(result.feedbackAr, /ممتاز/);
});

test('submitAssessment: passes an explicit, non-truncating maxOutputTokens (live-Gemini truncation regression)', async (t) => {
  const feedback = { feedbackAr: 'ملاحظة حقيقية', strengths: ['قوة'], weaknesses: [] };
  const { aiAssessmentService } = await loadService(t, {
    attempt: attemptFixture(),
    generateStructured: async (_prompt, options) => {
      assert.equal(typeof options.maxOutputTokens, 'number');
      assert.ok(options.maxOutputTokens > 0, 'maxOutputTokens must be a defined positive number');
      assert.ok(options.maxOutputTokens >= 1000, 'must retain enough headroom to avoid the observed live truncation at 500');
      return { data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  await aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1');
});

test('submitAssessment: throws when the attempt does not belong to the calling user', async (t) => {
  const { aiAssessmentService } = await loadService(t, { attempt: attemptFixture({ providerSpecialty: { ...attemptFixture().providerSpecialty, providerProfile: { userId: 'someone-else' } } }) });

  await assert.rejects(() => aiAssessmentService.submitAssessment('attempt-1', {}, 'user-1'));
});
