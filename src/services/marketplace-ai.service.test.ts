import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// Phase 3E.1: formatModelForClient() previously built provider name/avatar
// from raw User columns and "level" from the stale, never-written
// User.currentLevel. It now uses ProviderProfile's own display columns
// (User fallback only if null) and ProviderGamification.currentLevelIndex
// via the same resolveProviderProgression helper the rest of the app
// already uses — display formatting only, never the AI ranking prompt.
//
// F6 Gemini migration (security follow-up batch): `geminiClient` is always
// mocked (never the real module), and isConfigured() defaults to false so
// generateAiRecommendations() takes its existing "honest deterministic
// fallback" branch — which never calls Gemini at all — for every test that
// doesn't explicitly opt into the Gemini branch. This lets the display
// tests keep working unchanged, and lets the Gemini-branch tests below
// override isConfigured/generateStructured per test.

function makeDbModel(overrides: any = {}) {
  return {
    id: overrides.id || 'model-1',
    title: 'نموذج تجريبي',
    description: 'وصف',
    totalAmount: 100,
    totalDays: 5,
    aiScore: 80,
    aiAuditScore: 80,
    aiClarityScore: 0,
    aiFeasibilityScore: 0,
    viewsCount: 0,
    specialty: { name: 'Design', nameAr: 'تصميم', slug: 'design', category: { nameAr: 'فئة', slug: 'cat' } },
    stages: [],
    portfolioItem: null,
    reviews: [],
    provider: overrides.provider,
    ...overrides
  };
}

function makeProvider(overrides: any = {}) {
  return {
    id: overrides.id || 'provider-1',
    firstName: 'Legacy',
    lastName: 'Name',
    avatarUrl: 'https://legacy.example/avatar.png',
    email: 'provider@example.com',
    currentLevel: 'مستكشف - المستوى 1',
    providerProfile: { firstName: null, lastName: null, avatarUrl: null, isVerified: false },
    gamification: null,
    ...overrides
  };
}

function createMockPrisma(t: TestContext, dbModels: any[]) {
  const prismaMock: any = {
    serviceCatalog: { findMany: async () => dbModels }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
}

async function loadService(t: TestContext, dbModels: any[], opts: {
  isConfigured?: boolean;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
} = {}) {
  createMockPrisma(t, dbModels);

  const geminiClientMock = {
    isConfigured: () => opts.isConfigured ?? false,
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./marketplace-ai.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { MarketplaceAiService } = await import(moduleUrl);
  return new MarketplaceAiService();
}

test('formatModelForClient (via generateAiRecommendations heuristic fallback): returns ProviderProfile identity over legacy User', async (t) => {
  const provider = makeProvider({
    providerProfile: { firstName: 'Provider', lastName: 'Persona', avatarUrl: 'https://provider.example/a.png', isVerified: true }
  });
  const service = await loadService(t, [makeDbModel({ provider })]);

  const result = await service.generateAiRecommendations({});

  assert.equal(result.recommendations[0].provider.name, 'Provider Persona');
  assert.equal(result.recommendations[0].provider.avatar, 'https://provider.example/a.png');
});

test('formatModelForClient: falls back to legacy User identity when ProviderProfile display fields are missing', async (t) => {
  const provider = makeProvider();
  const service = await loadService(t, [makeDbModel({ provider })]);

  const result = await service.generateAiRecommendations({});

  assert.equal(result.recommendations[0].provider.name, 'Legacy Name');
  assert.equal(result.recommendations[0].provider.avatar, 'https://legacy.example/avatar.png');
});

test('formatModelForClient: returns the canonical ProviderGamification-derived level, not legacy User.currentLevel', async (t) => {
  const provider = makeProvider({
    currentLevel: 'مستكشف - المستوى 1', // stale, must not be what's shown
    gamification: { points: 150, currentLevelIndex: 3 } // 'منفذ'
  });
  const service = await loadService(t, [makeDbModel({ provider })]);

  const result = await service.generateAiRecommendations({});

  assert.equal(result.recommendations[0].level, 'منفذ');
});

test('formatModelForClient: legacy User.currentLevel is used ONLY as the explicit fallback when ProviderGamification is genuinely absent', async (t) => {
  const provider = makeProvider({ currentLevel: 'مستكشف - المستوى 1', gamification: null });
  const service = await loadService(t, [makeDbModel({ provider })]);

  const result = await service.generateAiRecommendations({});

  assert.equal(result.recommendations[0].level, 'مستكشف - المستوى 1');
});

test('AI ranking payload (modelsSummary) is unaffected: it never includes provider name/level fields at all', async (t) => {
  // This documents/locks in the existing, already-correct separation: the
  // heuristic (and OpenAI) ranking logic only ever sees title/description/
  // category/totalAmount/totalDays/aiScore — never provider identity or
  // level — so this phase's display fix cannot change ranking/selection.
  const providerA = makeProvider({ id: 'pa', gamification: { points: 0, currentLevelIndex: 1 } });
  const providerB = makeProvider({ id: 'pb', gamification: { points: 7201, currentLevelIndex: 15 } });
  const service = await loadService(t, [
    makeDbModel({ id: 'm1', aiScore: 50, aiAuditScore: 50, provider: providerA }),
    makeDbModel({ id: 'm2', aiScore: 90, aiAuditScore: 90, provider: providerB })
  ]);

  const result = await service.generateAiRecommendations({ limit: 2 });

  // Heuristic fallback ranks purely by aiScore/order — provider level (1 vs
  // 15) has no bearing on which model is ranked first.
  assert.equal(result.recommendations[0].id, 'm1');
  assert.equal(result.recommendations[0].aiScore, 50);
  assert.equal(result.recommendations[1].id, 'm2');
  assert.equal(result.recommendations[1].aiScore, 90);
});

test('generateAiRecommendations: no Gemini call at all when GEMINI_API_KEY is not configured — honest DETERMINISTIC fallback', async (t) => {
  const service = await loadService(t, [makeDbModel()], { isConfigured: false });

  const result = await service.generateAiRecommendations({});

  assert.equal(result.generationSource, 'DETERMINISTIC');
});

test('generateAiRecommendations: a real validated Gemini success is honestly labeled GEMINI and uses the AI-selected id/score/reason', async (t) => {
  const model = makeDbModel({ id: 'm1' });
  const service = await loadService(t, [model], {
    isConfigured: true,
    generateStructured: async (_prompt, options) => {
      const payload = {
        bannerInsight: 'اختيارات مخصصة لك',
        smartSearchTags: ['تصميم', 'تطوير'],
        recommendations: [{ id: 'm1', aiMatchPercentage: 95, aiRecommendationReason: 'تطابق ممتاز مع بحثك' }]
      };
      assert.equal(options.validate(payload), true, 'the real validator must accept a well-formed, non-hallucinated payload');
      return { data: payload, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.generateAiRecommendations({});

  assert.equal(result.generationSource, 'GEMINI');
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].id, 'm1');
  assert.equal(result.recommendations[0].aiScore, 95);
  assert.equal(result.recommendations[0].aiRecommendationReason, 'تطابق ممتاز مع بحثك');
});

test('generateAiRecommendations: a hallucinated model id (not among the supplied candidates) is rejected by the validator, falling back honestly', async (t) => {
  const model = makeDbModel({ id: 'm1' });
  const service = await loadService(t, [model], {
    isConfigured: true,
    generateStructured: async (_prompt, options) => {
      const hallucinated = {
        bannerInsight: 'x',
        smartSearchTags: ['x'],
        recommendations: [{ id: 'model-that-does-not-exist', aiMatchPercentage: 95, aiRecommendationReason: 'x' }]
      };
      assert.equal(options.validate(hallucinated), false, 'the validator must reject an id outside the candidate set');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });

  const result = await service.generateAiRecommendations({});

  assert.equal(result.generationSource, 'DETERMINISTIC');
  assert.equal(result.recommendations[0].id, 'm1');
});

test('generateAiRecommendations: malformed Gemini output (missing required fields) falls back honestly', async (t) => {
  const service = await loadService(t, [makeDbModel({ id: 'm1' })], {
    isConfigured: true,
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'malformed JSON'); }
  });

  const result = await service.generateAiRecommendations({});

  assert.equal(result.generationSource, 'DETERMINISTIC');
});

test('generateAiRecommendations: Gemini provider unavailable/timeout falls back honestly, never throwing to the caller', async (t) => {
  const service = await loadService(t, [makeDbModel({ id: 'm1' })], {
    isConfigured: true,
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.TIMEOUT, 'timed out'); }
  });

  const result = await service.generateAiRecommendations({});

  assert.equal(result.generationSource, 'DETERMINISTIC');
  assert.equal(result.recommendations.length, 1);
});

test('generateAiRecommendations: deterministic fallback result count respects the requested limit', async (t) => {
  const models = [makeDbModel({ id: 'm1' }), makeDbModel({ id: 'm2' }), makeDbModel({ id: 'm3' })];
  const service = await loadService(t, models, { isConfigured: false });

  const result = await service.generateAiRecommendations({ limit: 2 });

  assert.equal(result.recommendations.length, 2);
});

test('generateAiRecommendations: no result at all (empty DB) is honestly DETERMINISTIC, never fabricated', async (t) => {
  const service = await loadService(t, [], { isConfigured: true });

  const result = await service.generateAiRecommendations({});

  assert.equal(result.generationSource, 'DETERMINISTIC');
  assert.deepEqual(result.recommendations, []);
});

// ── AI Cleanup Batch 4 — Gemini reliability ─────────────────────────────
// Was 800: visible output for limit=5 is ≈550 tokens (≈1,100 at the server
// cap of 10) before reasoning tokens; DEV logs showed recurring malformed-
// JSON (truncation) fallbacks.
test('generateAiRecommendations: production call site uses the raised, non-truncating maxOutputTokens (1600)', async (t) => {
  let captured: any;
  const service = await loadService(t, [makeDbModel({ id: 'm1' })], {
    isConfigured: true,
    generateStructured: async (_prompt, options) => {
      captured = options;
      return { data: { bannerInsight: 'x', smartSearchTags: ['x'], recommendations: [{ id: 'm1', aiMatchPercentage: 90, aiRecommendationReason: 'سبب' }] } };
    }
  });
  await service.generateAiRecommendations({ limit: 5 });
  assert.equal(captured.maxOutputTokens, 1600);
  assert.ok(captured.maxOutputTokens > 800, 'must never regress to the truncating 800');
});

for (const [label, makeError] of [
  ['truncated (MAX_TOKENS) response', () => new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini structured response was truncated at the output token limit', undefined, { detail: 'TRUNCATED' })],
  ['503 retry exhaustion', () => new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'Gemini service is currently unavailable', undefined, { detail: 'UPSTREAM_UNAVAILABLE', retryable: true, httpStatus: 503 })],
] as const) {
  test(`generateAiRecommendations: ${label} falls back to the honestly-labeled DETERMINISTIC ranking, never a GEMINI-labeled/fabricated result`, async (t) => {
    const model = makeDbModel({ id: 'm1' });
    const service = await loadService(t, [model], { isConfigured: true, generateStructured: async () => { throw makeError(); } });
    const result = await service.generateAiRecommendations({ limit: 5 });
    assert.equal(result.generationSource, 'DETERMINISTIC');
    assert.equal(result.recommendations.length, 1);
    assert.equal(result.recommendations[0].id, 'm1', 'only real DB rows, never an invented model');
    assert.equal(result.recommendations[0].aiScore, model.aiScore ?? model.aiAuditScore ?? 0, 'score is the stored DB value, never an AI-looking invented percentage');
  });
}

// ── AI Cleanup Batch 5 — score semantics ─────────────────────────────────
test('Batch 5: deterministic fallback never relabels the stored AI quality score as a match percentage', async (t) => {
  const model = makeDbModel({ id: 'm1', aiScore: 88 });
  const service = await loadService(t, [model], { isConfigured: false });

  const result = await service.generateAiRecommendations({ limit: 5 });

  assert.equal(result.generationSource, 'DETERMINISTIC');
  assert.equal(result.recommendations[0].aiMatchPercentage, null, 'no match percentage exists without a real Gemini result');
  assert.equal(result.recommendations[0].aiScore, 88, 'the real stored quality score is preserved as-is');
});

test('Batch 5: a genuine Gemini recommendation keeps its real match percentage', async (t) => {
  const service = await loadService(t, [makeDbModel({ id: 'm1' })], {
    isConfigured: true,
    generateStructured: async () => ({ data: { bannerInsight: 'x', smartSearchTags: ['x'], recommendations: [{ id: 'm1', aiMatchPercentage: 73, aiRecommendationReason: 'سبب' }] } })
  });

  const result = await service.generateAiRecommendations({ limit: 5 });

  assert.equal(result.generationSource, 'GEMINI');
  assert.equal(result.recommendations[0].aiMatchPercentage, 73);
});
