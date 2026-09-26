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
    specialtyTestSession: { findMany: async () => [] },
    providerSkillAssessment: { findMany: async () => [] },
    assessmentAttempt: { findMany: async () => [] },
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

test('getTop3MatchingProjects: deterministic fallback ranks and returns at most 3, sorted by score descending', async (t) => {
  const service = await loadService(t, {
    openProjects: [
      baseProject({ id: 'proj-1', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-2', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-3', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-4', specialty: 'تطوير الويب' })
    ],
    isConfigured: false
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.equal(result.length, 3);
  for (let i = 0; i < result.length - 1; i++) {
    assert.ok(result[i].aiMatchScore >= result[i + 1].aiMatchScore);
  }
  result.forEach((item: any) => assert.equal(item.generationSource, 'DETERMINISTIC'));
});

test('DB failure during candidate gathering is handled honestly (empty result, never a crash or fabricated match)', async (t) => {
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        user: { findUnique: async () => { throw new Error('DB connection lost'); } },
        providerProfile: { findUnique: async () => null },
        providerSpecialty: { findMany: async () => [baseProviderSpecialty()] },
        specialtyTestSession: { findMany: async () => [] },
        providerSkillAssessment: { findMany: async () => [] },
        assessmentAttempt: { findMany: async () => [] },
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
