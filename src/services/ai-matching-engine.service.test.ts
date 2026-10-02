import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// F15 Gemini migration (security follow-up batch): the shared matching
// engine behind the provider dashboard's "aiMatchingProjects" widget (see
// provider-overview.service.ts#getAiMatchingProjects, consumed via
// GET /provider/statistics). `prisma` and `geminiClient` are fully mocked;
// no real DB/network call happens.
//
// Batch 8: the standalone duplicate route (`GET /provider/ai-matching-
// projects`, ai-matching.routes.ts/ai-matching.controller.ts) that called
// this exact same service method with zero real frontend caller has been
// removed — this service itself is untouched and still fully live via
// /provider/statistics above.

function baseProviderSpecialty(overrides: any = {}) {
  return {
    subSpecialties: [],
    latestScore: null,
    quizScore: null,
    isPassed: true,
    aiScore: null,
    specialty: { nameAr: 'تطوير الويب', name: 'Web', nameEn: 'Web' },
    ...overrides
  };
}

function baseProject(overrides: any = {}) {
  return {
    id: overrides.id || 'proj-1',
    title: 'مشروع تجريبي',
    description: 'وصف',
    specialty: 'تطوير الويب',
    subSpecialties: [],
    requirements: [],
    budgetFixed: 2000,
    budgetMax: null,
    budgetMin: null,
    deliveryDays: 10,
    provLevel: 'الكل',
    createdAt: new Date(),
    client: { firstName: 'أحمد', lastName: 'محمد' },
    ...overrides
  };
}

function createMockPrisma(t: TestContext, opts: {
  providerSpecialties?: any[];
  openProjects?: any[];
}) {
  const prismaMock: any = {
    user: { findUnique: async () => ({ id: 'provider-1', firstName: 'مقدم', lastName: 'خدمة', currentLevel: 'محترف', currentPoints: 100, profileCompletionPercent: 100, completedProjectsCount: 5, ratingAverage: 4.8 }) },
    providerProfile: { findUnique: async () => ({ skills: [], portfolioItems: [], rating: 4.8, headline: null, bio: null }) },
    providerSpecialty: { findMany: async () => (opts.providerSpecialties === undefined ? [baseProviderSpecialty()] : opts.providerSpecialties) },
    providerSkillAssessment: { findMany: async () => [] },
    accreditationSample: { findMany: async () => [] },
    project: { findMany: async () => (opts.openProjects === undefined ? [baseProject()] : opts.openProjects) }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
}

async function loadService(t: TestContext, opts: {
  providerSpecialties?: any[];
  openProjects?: any[];
  isConfigured?: boolean;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
} = {}) {
  createMockPrisma(t, opts);

  const geminiClientMock = {
    isConfigured: () => opts.isConfigured ?? false,
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./ai-matching-engine.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { AiMatchingEngineService } = await import(moduleUrl);
  return new AiMatchingEngineService();
}

test('getTop3MatchingProjects: no approved provider specialties returns empty (matching never starts before real specialty approval)', async (t) => {
  const service = await loadService(t, { providerSpecialties: [] });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.deepEqual(result, []);
});

test('getTop3MatchingProjects: no open candidate projects at all returns empty (strict DB mode, no fabricated projects)', async (t) => {
  const service = await loadService(t, { openProjects: [] });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.deepEqual(result, []);
});

test('getTop3MatchingProjects: no open project matches the provider\'s approved specialty returns empty', async (t) => {
  const service = await loadService(t, {
    providerSpecialties: [baseProviderSpecialty({ specialty: { nameAr: 'تصميم جرافيك', name: 'Graphic Design', nameEn: 'Graphic Design' } })],
    openProjects: [baseProject({ specialty: 'تطوير الويب' })]
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.deepEqual(result, []);
});

test('getTop3MatchingProjects: a real validated Gemini success is honestly labeled GEMINI and uses only the AI-selected project', async (t) => {
  const service = await loadService(t, {
    openProjects: [baseProject({ id: 'proj-1' }), baseProject({ id: 'proj-2' })],
    isConfigured: true,
    generateStructured: async (_prompt, options) => {
      const payload = { matches: [{ projectId: 'proj-1', aiMatchScore: 95, matchReasons: ['تطابق ممتاز'], aiAnalysis: 'تحليل حقيقي' }] };
      assert.equal(options.validate(payload), true, 'the real validator must accept a well-formed, non-hallucinated payload');
      return { data: payload, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'proj-1');
  assert.equal(result[0].aiMatchScore, 95);
  assert.equal(result[0].aiAnalysis, 'تحليل حقيقي');
  assert.equal(result[0].generationSource, 'GEMINI');
});

test('getTop3MatchingProjects: a hallucinated projectId (not among the supplied candidates) is rejected by the validator, falling back honestly', async (t) => {
  const service = await loadService(t, {
    openProjects: [baseProject({ id: 'proj-1' })],
    isConfigured: true,
    generateStructured: async (_prompt, options) => {
      const hallucinated = { matches: [{ projectId: 'project-that-does-not-exist', aiMatchScore: 95, matchReasons: ['x'], aiAnalysis: 'x' }] };
      assert.equal(options.validate(hallucinated), false, 'the validator must reject a projectId outside the candidate set');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'proj-1');
  assert.equal(result[0].generationSource, 'DETERMINISTIC');
  // The deterministic fallback must never claim to be Gemini-generated.
  assert.ok(!result[0].aiAnalysis?.includes('الذكاء الاصطناعي'), 'fallback aiAnalysis must not claim to be AI-generated');
});

test('getTop3MatchingProjects: malformed Gemini output (out-of-range score) falls back honestly', async (t) => {
  const service = await loadService(t, {
    openProjects: [baseProject({ id: 'proj-1' })],
    isConfigured: true,
    generateStructured: async (_prompt, options) => {
      const malformed = { matches: [{ projectId: 'proj-1', aiMatchScore: 500, matchReasons: ['x'], aiAnalysis: 'x' }] };
      assert.equal(options.validate(malformed), false);
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.equal(result[0].generationSource, 'DETERMINISTIC');
});

test('getTop3MatchingProjects: Gemini provider unavailable/timeout falls back to the deterministic engine, never throwing', async (t) => {
  const service = await loadService(t, {
    openProjects: [baseProject({ id: 'proj-1' })],
    isConfigured: true,
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.TIMEOUT, 'timed out'); }
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.equal(result.length, 1);
  assert.equal(result[0].generationSource, 'DETERMINISTIC');
});

test('getTop3MatchingProjects: duplicate projectIds in Gemini output are rejected by the validator', async (t) => {
  const service = await loadService(t, {
    openProjects: [baseProject({ id: 'proj-1' }), baseProject({ id: 'proj-2' })],
    isConfigured: true,
    generateStructured: async (_prompt, options) => {
      const dup = { matches: [
        { projectId: 'proj-1', aiMatchScore: 90, matchReasons: ['x'], aiAnalysis: 'x' },
        { projectId: 'proj-1', aiMatchScore: 85, matchReasons: ['y'], aiAnalysis: 'y' }
      ] };
      assert.equal(options.validate(dup), false, 'duplicate projectIds must be rejected');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });

  const result = await service.getTop3MatchingProjects('provider-1');
  assert.equal(result[0].generationSource, 'DETERMINISTIC');
});

test('getTop3MatchingProjects: deterministic fallback returns at most 3, ties keep the candidate query\'s newest-first order, and exposes NO percentage', async (t) => {
  const service = await loadService(t, {
    // Candidate query is createdAt desc; equal rule scores must keep it.
    openProjects: [
      baseProject({ id: 'proj-1', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-2', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-3', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-4', specialty: 'تطوير الويب' })
    ],
    isConfigured: false
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.deepEqual(result.map((r: any) => r.id), ['proj-1', 'proj-2', 'proj-3']);
  result.forEach((item: any) => {
    assert.equal(item.generationSource, 'DETERMINISTIC');
    assert.equal(item.aiMatchScore, null, 'the rule engine never exposes its heuristic as a percentage');
  });
});

// ── AI Cleanup Batch 5 ──────────────────────────────────────────────────
test('Batch 5: deterministic fallback still ranks a candidate whose requirements overlap the provider skills first (real ordering preserved)', async (t) => {
  // Provider has a real skill ('Angular') that only proj-skill requires;
  // proj-new is newer (first in the createdAt-desc candidate query).
  const prismaMock: any = {
    user: { findUnique: async () => ({ id: 'provider-1', firstName: 'م', lastName: 'خ', completedProjectsCount: 0, ratingAverage: null }) },
    providerProfile: { findUnique: async () => ({ skills: [{ name: 'Angular' }], portfolioItems: [], rating: 4.8, headline: null, bio: null }) },
    providerSpecialty: { findMany: async () => [baseProviderSpecialty()] },
    providerSkillAssessment: { findMany: async () => [] },
    accreditationSample: { findMany: async () => [] },
    project: { findMany: async () => [
      baseProject({ id: 'proj-new', specialty: 'تطوير الويب', requirements: [] }),
      baseProject({ id: 'proj-skill', specialty: 'تطوير الويب', requirements: ['angular'] })
    ] }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: { isConfigured: () => false, generateStructured: async () => { throw new Error('no'); } } } });
  const { AiMatchingEngineService } = await import(`./ai-matching-engine.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const result = await new AiMatchingEngineService().getTop3MatchingProjects('provider-1');

  assert.deepEqual(result.map((r: any) => r.id), ['proj-skill', 'proj-new']);
  result.forEach((r: any) => assert.equal(r.aiMatchScore, null));
});

test('Batch 5: a real Gemini score is shown exactly as returned (rounded) — never clamped up to 82', async (t) => {
  const service = await loadService(t, {
    openProjects: [baseProject({ id: 'proj-1' }), baseProject({ id: 'proj-2' })],
    isConfigured: true,
    generateStructured: async () => ({
      data: { matches: [
        { projectId: 'proj-2', aiMatchScore: 64.6, matchReasons: ['سبب'], aiAnalysis: 'تحليل' },
        { projectId: 'proj-1', aiMatchScore: 91, matchReasons: ['سبب'], aiAnalysis: 'تحليل' }
      ] }
    })
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.deepEqual(result.map((r: any) => [r.id, r.aiMatchScore, r.generationSource]), [
    ['proj-2', 65, 'GEMINI'],
    ['proj-1', 91, 'GEMINI']
  ], 'Gemini\'s own ranked order and its real (unclamped) scores are preserved');
});

test('Batch 5: production call site uses the raised, non-truncating maxOutputTokens (1600) and bounds the answer to 3 matches', async (t) => {
  let captured: any;
  const service = await loadService(t, {
    isConfigured: true,
    generateStructured: async (_prompt, options) => {
      captured = options;
      return { data: { matches: [{ projectId: 'proj-1', aiMatchScore: 90, matchReasons: ['x'], aiAnalysis: 'x' }] } };
    }
  });

  await service.getTop3MatchingProjects('provider-1');

  assert.equal(captured.maxOutputTokens, 1600);
  assert.ok(captured.maxOutputTokens > 800, 'must never regress to the truncating 800');
  assert.equal(captured.responseSchema.properties.matches.maxItems, '3');
});

for (const [label, makeError] of [
  ['truncated (MAX_TOKENS) response', () => new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini structured response was truncated at the output token limit', undefined, { detail: 'TRUNCATED' })],
  ['503 retry exhaustion', () => new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'Gemini service is currently unavailable', undefined, { detail: 'UPSTREAM_UNAVAILABLE', retryable: true, httpStatus: 503 })],
] as const) {
  test(`Batch 5: ${label} falls back to the honest DETERMINISTIC list — no GEMINI label and no fabricated percentage`, async (t) => {
    const service = await loadService(t, {
      openProjects: [baseProject({ id: 'proj-1' })],
      isConfigured: true,
      generateStructured: async () => { throw makeError(); }
    });

    const result = await service.getTop3MatchingProjects('provider-1');

    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'proj-1', 'only real candidate rows, never an invented project');
    assert.equal(result[0].generationSource, 'DETERMINISTIC');
    assert.equal(result[0].aiMatchScore, null);
  });
}

test('Batch 5: no invented budget/duration/rating/test-score defaults in the result or the AI input', async (t) => {
  let prompt = '';
  const service = await loadService(t, {
    providerSpecialties: [baseProviderSpecialty({ isPassed: true, latestScore: null, quizScore: null })],
    openProjects: [baseProject({ id: 'proj-1', budgetFixed: null, budgetMax: null, budgetMin: null, deliveryDays: null })],
    isConfigured: true,
    generateStructured: async (p) => { prompt = p; throw new GeminiProviderError(GeminiErrorCode.TIMEOUT, 'timed out'); }
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.equal(result[0].budget, null, 'no invented 2000/2500 budget');
  assert.equal(result[0].deliveryDays, undefined, 'no invented 7-day duration');
  const payload = JSON.parse(prompt);
  assert.equal(payload.candidateProjects[0].budget, null, 'no invented 1500 budget sent to Gemini');
  assert.equal(payload.candidateProjects[0].deliveryDays, null);
  assert.equal(payload.providerProfile.testsPassed[0].score, null, 'no invented test score of 80 sent to Gemini');
});

// Batch 4E: the matching engine's SpecialtyTestSession/AssessmentAttempt
// direct reads were removed as duplicates of ProviderSpecialty-derived
// qualification state (latestScore/isPassed, written atomically together by
// the canonical ai-assessment.service.ts submission flow). These tests prove
// the replacement: matching runs without either model on the mocked prisma
// client at all, and the current ProviderSpecialty fields — not a legacy
// session table — are what drive the deterministic score.
test('getTop3MatchingProjects: matching runs with no specialtyTestSession/assessmentAttempt models on the mocked prisma client at all', async (t) => {
  // createMockPrisma() (used by every test in this file) no longer defines
  // prisma.specialtyTestSession or prisma.assessmentAttempt. If the service
  // still queried either, this would throw synchronously ("Cannot read
  // properties of undefined") instead of returning a result.
  const service = await loadService(t, {
    providerSpecialties: [baseProviderSpecialty({ isPassed: true, latestScore: 95 })],
    openProjects: [baseProject({ specialty: 'تطوير الويب' })]
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.equal(result.length, 1);
});

test('getTop3MatchingProjects: a currently-approved ProviderSpecialty (isPassed + latestScore) drives the deterministic result — sourced directly, no legacy session table involved', async (t) => {
  // Batch 5: the fallback no longer exposes a numeric score, so the
  // ProviderSpecialty-derived signal is asserted through the real match
  // reason it produces instead of a percentage comparison.
  const TEST_REASON = 'اجتياز اختبارات وتقييمات المهارة بنجاح عالية';
  let passedReasons: string[] = [];
  let unpassedReasons: string[] = [];

  await t.test('passed', async (st) => {
    const service = await loadService(st, {
      providerSpecialties: [baseProviderSpecialty({ isPassed: true, latestScore: 95 })],
      openProjects: [baseProject({ specialty: 'تطوير الويب' })],
      isConfigured: false
    });
    const result = await service.getTop3MatchingProjects('provider-1');
    assert.equal(result.length, 1);
    passedReasons = result[0].matchReasons;
  });

  await t.test('unpassed', async (st) => {
    const service = await loadService(st, {
      providerSpecialties: [baseProviderSpecialty({ isPassed: false, latestScore: null })],
      openProjects: [baseProject({ specialty: 'تطوير الويب' })],
      isConfigured: false
    });
    const result = await service.getTop3MatchingProjects('provider-1');
    assert.equal(result.length, 1);
    unpassedReasons = result[0].matchReasons;
  });

  assert.ok(passedReasons.includes(TEST_REASON), 'a passed specialty with a real score is credited');
  assert.ok(!unpassedReasons.includes(TEST_REASON), 'an unpassed specialty is not');
});

test('DB failure during candidate gathering is handled honestly (empty result, never a crash or fabricated match)', async (t) => {
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        user: { findUnique: async () => { throw new Error('DB connection lost'); } },
        providerProfile: { findUnique: async () => null },
        providerSpecialty: { findMany: async () => [baseProviderSpecialty()] },
        providerSkillAssessment: { findMany: async () => [] },
        accreditationSample: { findMany: async () => [] },
        project: { findMany: async () => [baseProject()] }
      }
    }
  });
  const geminiClientMock = { isConfigured: () => false, generateStructured: async () => { throw new Error('not stubbed'); } };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });
  const moduleUrl = `./ai-matching-engine.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { AiMatchingEngineService } = await import(moduleUrl);
  const service = new AiMatchingEngineService();

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.deepEqual(result, []);
});
