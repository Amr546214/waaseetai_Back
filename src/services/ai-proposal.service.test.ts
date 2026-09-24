import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// F4 (evaluateAndSuggestProposal) — Batch A migration to the shared Gemini
// foundation, plus the recommendedAdvantages -> suggestedAdvantages field
// rename. `prisma` (via ../utils/prisma.client) and `geminiClient` are both
// mocked; no real DB/network call ever happens.

function projectFixture(overrides: Partial<any> = {}) {
  return {
    title: 'تطوير متجر إلكتروني',
    description: 'وصف حقيقي للمشروع',
    budgetMin: 3000,
    budgetMax: 6000,
    budgetFixed: null,
    deliveryDays: 20,
    requirements: ['React', 'Stripe'],
    specialty: 'تطوير الويب',
    ...overrides
  };
}

function validFeedbackFixture(overrides: Partial<any> = {}) {
  return {
    suggestedTitle: 'عنوان مقترح احترافي',
    suggestedMessage: 'رسالة عرض مقترحة حقيقية من Gemini تفوق 20 حرفاً بسهولة',
    qualityScore: 87,
    qualityTag: 'GOOD',
    priceAudit: {
      recommendedMin: 3200,
      recommendedMax: 6200,
      priceTag: 'FAIR',
      justification: 'مبرر تسعير حقيقي'
    },
    suggestedAdvantages: ['ميزة 1', 'ميزة 2', 'ميزة 3'],
    ...overrides
  };
}

async function loadService(t: TestContext, opts: {
  project?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const prismaMock: any = {
    project: { findUnique: async () => (opts.project === undefined ? projectFixture() : opts.project) }
  };
  t.mock.module('../utils/prisma.client', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./ai-proposal.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return mod.aiProposalService;
}

test('evaluateAndSuggestProposal: a real validated Gemini success is returned with the canonical suggestedAdvantages field', async (t) => {
  const feedback = validFeedbackFixture();
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(feedback), true, 'the real validator must accept well-formed feedback');
      return { data: feedback, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
    }
  });

  const result = await service.evaluateAndSuggestProposal('project-1', 'عنوان حالي', 'رسالة حالية', ['ميزة موجودة']);

  assert.equal(result.suggestedTitle, feedback.suggestedTitle);
  assert.deepEqual(result.suggestedAdvantages, feedback.suggestedAdvantages);
  assert.equal((result as any).recommendedAdvantages, undefined, 'the old field name must not exist on the response');
});

test('evaluateAndSuggestProposal: suggestedTitle is clamped to 80 chars and suggestedAdvantages to 5 entries', async (t) => {
  const longTitle = 'ا'.repeat(120);
  const manyAdvantages = ['1', '2', '3', '4', '5', '6', '7'];
  const feedback = validFeedbackFixture({ suggestedTitle: longTitle, suggestedAdvantages: manyAdvantages });
  const service = await loadService(t, {
    generateStructured: async () => ({ data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  });

  const result = await service.evaluateAndSuggestProposal('project-1');

  assert.equal(result.suggestedTitle.length, 80);
  assert.equal(result.suggestedAdvantages.length, 5);
});

test('evaluateAndSuggestProposal: Gemini unavailable throws an AppError(503) instead of returning fabricated data', async (t) => {
  const service = await loadService(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  await assert.rejects(
    () => service.evaluateAndSuggestProposal('project-1', 'title', 'message', []),
    (err: any) => {
      assert.equal(err.statusCode, 503);
      assert.equal(typeof err.message, 'string');
      return true;
    }
  );
});

test('evaluateAndSuggestProposal: a malformed Gemini response is rejected by the real validator, never silently patched with fabricated data', async (t) => {
  const malformed = { suggestedTitle: '', qualityScore: 999, suggestedAdvantages: [] };
  const service = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) {
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      }
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  await assert.rejects(
    () => service.evaluateAndSuggestProposal('project-1'),
    (err: any) => { assert.equal(err.statusCode, 503); return true; }
  );
});

test('evaluateAndSuggestProposal: throws a 404 AppError when the project does not exist, without calling Gemini', async (t) => {
  let called = false;
  const service = await loadService(t, {
    project: null,
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });

  await assert.rejects(
    () => service.evaluateAndSuggestProposal('missing-project'),
    (err: any) => { assert.equal(err.statusCode, 404); return true; }
  );
  assert.equal(called, false);
});
