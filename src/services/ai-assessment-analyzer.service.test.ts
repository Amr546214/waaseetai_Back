import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// Shared assessment-generation engine (used by both F12 and F14) — Batch:
// F12+F13+F14 assessment pipeline migration to the shared Gemini foundation.
// `prisma` and `geminiClient` are mocked; no real DB/network call happens.

function validQuestion(id: number, overrides: Partial<any> = {}) {
  return {
    id,
    textAr: `سؤال حقيقي رقم ${id}`,
    options: [
      { id: 'a', text: 'خيار أ' },
      { id: 'b', text: 'خيار ب' },
      { id: 'c', text: 'خيار ج' },
      { id: 'd', text: 'خيار د' }
    ],
    correctAnswer: 'b',
    explanation: 'تعليل حقيقي',
    ...overrides
  };
}

function valid20Questions() {
  return Array.from({ length: 20 }, (_, i) => validQuestion(i + 1));
}

async function loadService(t: TestContext, opts: {
  providerSpecialty?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const prismaMock: any = {
    providerSpecialty: {
      findUnique: async () => (opts.providerSpecialty === undefined ? null : opts.providerSpecialty)
    }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./ai-assessment-analyzer.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { aiAssessmentAnalyzerService } = await import(moduleUrl);
  return aiAssessmentAnalyzerService;
}

const BASE_INPUT = {
  providerSpecialtyId: 'demo-spec-uuid-101', // sentinel that skips the DB lookup
  specialtyId: 'specialty-1',
  subSpecialties: ['React'],
  specialtyName: 'تطوير الويب',
  categoryName: 'تقنية'
};

test('generate20Questions: a real validated Gemini success returns exactly 20 real questions with generationSource GEMINI', async (t) => {
  const fixture = { questions: valid20Questions() };
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(fixture), true, 'the real validator must accept a well-formed 20-question payload');
      return { data: fixture, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.generate20Questions(BASE_INPUT);

  assert.equal(result.generationSource, 'GEMINI');
  assert.equal(result.questions.length, 20);
  assert.equal(result.questions[0].assessmentArea, 'التخصص الرئيسي');
  assert.equal(result.questions[19].assessmentArea, 'مهارات العميل والصفقات');
});

test('generate20Questions: Gemini unavailable falls back to the static bank, honestly labeled STATIC_FALLBACK', async (t) => {
  const service = await loadService(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  const result = await service.generate20Questions(BASE_INPUT);

  assert.equal(result.generationSource, 'STATIC_FALLBACK');
  assert.equal(result.questions.length, 20);
});

test('generate20Questions: fewer than 20 validated questions from Gemini is treated as failure, falling back honestly (never a partial "success")', async (t) => {
  const partial = { questions: valid20Questions().slice(0, 12) };
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      // The real validator requires >=10 for the malformed-JSON-shape check
      // to even parse, but the service itself additionally requires a full
      // 20 before accepting the Gemini result as real.
      assert.equal(options.validate(partial), true);
      return { data: partial, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.generate20Questions(BASE_INPUT);

  assert.equal(result.generationSource, 'STATIC_FALLBACK');
  assert.equal(result.questions.length, 20);
});

test('generate20Questions: a malformed response (duplicate option ids) is rejected by the real validator', async (t) => {
  const malformed = {
    questions: valid20Questions().map((q, idx) => idx === 0
      ? { ...q, options: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }, { id: 'c', text: 'z' }, { id: 'd', text: 'w' }] }
      : q)
  };
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.generate20Questions(BASE_INPUT);
  assert.equal(result.generationSource, 'STATIC_FALLBACK');
});

test('generate20Questions: a malformed response (correctAnswer not among the options) is rejected by the real validator', async (t) => {
  const malformed = { questions: valid20Questions().map((q, idx) => idx === 0 ? { ...q, correctAnswer: 'z' } : q) };
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.generate20Questions(BASE_INPUT);
  assert.equal(result.generationSource, 'STATIC_FALLBACK');
});

test('generate20Questions: a malformed response (wrong option count) is rejected by the real validator', async (t) => {
  const malformed = { questions: valid20Questions().map((q, idx) => idx === 0 ? { ...q, options: q.options.slice(0, 3) } : q) };
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.generate20Questions(BASE_INPUT);
  assert.equal(result.generationSource, 'STATIC_FALLBACK');
});

test('generateFallback20Questions: is a genuine deterministic static bank — calling it twice with the same input yields identical output', async () => {
  // Pure function, no mocking needed — never calls Gemini, so importing the
  // real (unmocked) module here is safe.
  const { aiAssessmentAnalyzerService } = await import('./ai-assessment-analyzer.service.ts');
  const first = aiAssessmentAnalyzerService.generateFallback20Questions('تطوير الويب', ['React'], []);
  const second = aiAssessmentAnalyzerService.generateFallback20Questions('تطوير الويب', ['React'], []);
  assert.deepEqual(first, second);
  assert.equal(first.length, 20);
});
