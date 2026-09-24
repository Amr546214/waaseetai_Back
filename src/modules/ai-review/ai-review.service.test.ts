import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from '../../services/ai/gemini/gemini.errors';

// ai-review.service.ts's constructor eagerly does
// `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` for the dead HTTP
// twins (enhanceDescription/suggestText), which stay on OpenAI in this
// batch — same established pattern as other test files in this codebase for
// the same reason. Has no effect on the F1a (Gemini) tests below.
process.env.OPENAI_API_KEY = 'test-key';

async function loadService(t: TestContext, opts: {
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('../../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./ai-review.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { AiReviewService } = await import(moduleUrl);
  return new AiReviewService();
}

// ── suggestMilestones ────────────────────────────────────────────────────

function validMilestonesFixture(overrides: Partial<any> = {}) {
  return {
    milestones: [
      { title: 'مرحلة 1', description: 'وصف 1', estimatedDays: 4, percentage: 40 },
      { title: 'مرحلة 2', description: 'وصف 2', estimatedDays: 6, percentage: 60 }
    ],
    ...overrides
  };
}

test('suggestMilestones: a real validated Gemini success is mapped through as-is', async (t) => {
  const fixture = validMilestonesFixture();
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(fixture), true, 'the real validator must accept well-formed milestones');
      return { data: fixture, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.suggestMilestones({ title: 'مشروع', description: 'وصف' });

  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'مرحلة 1');
  assert.equal(result[1].percentage, 60);
});

test('suggestMilestones: percentages not summing to exactly 100 are corrected on the last milestone (preserved business rule)', async (t) => {
  const fixture = validMilestonesFixture({
    milestones: [
      { title: 'مرحلة 1', description: 'وصف 1', estimatedDays: 4, percentage: 40 },
      { title: 'مرحلة 2', description: 'وصف 2', estimatedDays: 6, percentage: 50 }
    ]
  });
  const service = await loadService(t, {
    generateStructured: async () => ({ data: fixture, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  });

  const result = await service.suggestMilestones({ title: 'مشروع' });

  assert.equal(result.reduce((sum: number, m: any) => sum + m.percentage, 0), 100);
  assert.equal(result[1].percentage, 60);
});

test('suggestMilestones: Gemini unavailable throws an AppError(503) instead of a domain-keyword-matched fallback', async (t) => {
  const service = await loadService(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  await assert.rejects(
    () => service.suggestMilestones({ title: 'تطوير تطبيق جوال' }),
    (err: any) => { assert.equal(err.statusCode, 503); return true; }
  );
});

test('suggestMilestones: a malformed Gemini response (empty milestones array) is rejected by the real validator', async (t) => {
  const malformed = { milestones: [] };
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  await assert.rejects(
    () => service.suggestMilestones({ title: 'مشروع' }),
    (err: any) => { assert.equal(err.statusCode, 503); return true; }
  );
});

// ── analyzeProjectModel ──────────────────────────────────────────────────

function validAnalysisFixture(overrides: Partial<any> = {}) {
  return {
    clarityScore: 88,
    feasibilityScore: 91,
    marketFitRating: 'High',
    executiveSummary: 'ملخص تنفيذي حقيقي',
    strengths: ['قوة 1', 'قوة 2'],
    gapsAndRisks: ['خطر 1'],
    recommendedImprovements: ['تحسين 1'],
    suggestedMilestones: [
      { title: 'مرحلة 1', estimatedDays: 5, description: 'وصف', percentage: 50 },
      { title: 'مرحلة 2', estimatedDays: 5, description: 'وصف', percentage: 50 }
    ],
    suggestedPricingStrategy: { recommendedRange: '4000 - 6000 ريال', reasoning: 'مبرر حقيقي' },
    ...overrides
  };
}

test('analyzeProjectModel: a real validated Gemini success is returned as-is', async (t) => {
  const fixture = validAnalysisFixture();
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(fixture), true, 'the real validator must accept a well-formed analysis');
      return { data: fixture, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.analyzeProjectModel({ title: 'مشروع', description: 'وصف' });

  assert.equal(result.clarityScore, 88);
  assert.equal(result.marketFitRating, 'High');
});

test('analyzeProjectModel: Gemini unavailable throws an AppError(503) instead of the canned getFallbackAnalysis result', async (t) => {
  const service = await loadService(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  await assert.rejects(
    () => service.analyzeProjectModel({ title: 'مشروع', description: 'وصف' }),
    (err: any) => {
      assert.equal(err.statusCode, 503);
      // The old fallback always claimed clarityScore: 92 — proves no such
      // object exists anywhere on the rejection.
      assert.equal('clarityScore' in err, false);
      return true;
    }
  );
});

test('analyzeProjectModel: a malformed Gemini response (out-of-range clarityScore) is rejected by the real validator', async (t) => {
  const malformed = validAnalysisFixture({ clarityScore: 250 });
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  await assert.rejects(
    () => service.analyzeProjectModel({ title: 'مشروع', description: 'وصف' }),
    (err: any) => { assert.equal(err.statusCode, 503); return true; }
  );
});

test('analyzeProjectModel: a malformed Gemini response (unrecognized marketFitRating) is rejected by the real validator', async (t) => {
  const malformed = validAnalysisFixture({ marketFitRating: 'VeryHigh' });
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  await assert.rejects(
    () => service.analyzeProjectModel({ title: 'مشروع', description: 'وصف' }),
    (err: any) => { assert.equal(err.statusCode, 503); return true; }
  );
});
