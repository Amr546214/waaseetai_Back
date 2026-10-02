import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
// Provider dashboard matching widget: a deterministic rule engine over stored
// data. No AI call exists; `prisma` is fully mocked.

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
} = {}) {
  createMockPrisma(t, opts);

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

test('getTop3MatchingProjects: deterministic fallback returns at most 3, ties keep the candidate query\'s newest-first order, and exposes NO percentage', async (t) => {
  const service = await loadService(t, {
    // Candidate query is createdAt desc; equal rule scores must keep it.
    openProjects: [
      baseProject({ id: 'proj-1', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-2', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-3', specialty: 'تطوير الويب' }),
      baseProject({ id: 'proj-4', specialty: 'تطوير الويب' })
    ]
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
  const { AiMatchingEngineService } = await import(`./ai-matching-engine.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const result = await new AiMatchingEngineService().getTop3MatchingProjects('provider-1');

  assert.deepEqual(result.map((r: any) => r.id), ['proj-skill', 'proj-new']);
  result.forEach((r: any) => assert.equal(r.aiMatchScore, null));
});

// the canonical ai-assessment.service.ts submission flow). These tests prove
// the replacement: matching runs without either model on the mocked prisma
// client at all, and the current ProviderSpecialty fields — not a legacy
// session table — are what drive the deterministic score.
test('Batch 5: no invented budget/duration/rating/test-score defaults in the result', async (t) => {
  const service = await loadService(t, {
    providerSpecialties: [baseProviderSpecialty({ isPassed: true, latestScore: null, quizScore: null })],
    openProjects: [baseProject({ id: 'proj-1', budgetFixed: null, budgetMax: null, budgetMin: null, deliveryDays: null })]
  });

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.equal(result.length, 1);
  assert.equal(result[0].budget, null, 'no invented 2000/2500 budget');
  assert.equal(result[0].deliveryDays, undefined, 'no invented 7-day duration');
  assert.equal(result[0].aiMatchScore, null);
});

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
      openProjects: [baseProject({ specialty: 'تطوير الويب' })]
    });
    const result = await service.getTop3MatchingProjects('provider-1');
    assert.equal(result.length, 1);
    passedReasons = result[0].matchReasons;
  });

  await t.test('unpassed', async (st) => {
    const service = await loadService(st, {
      providerSpecialties: [baseProviderSpecialty({ isPassed: false, latestScore: null })],
      openProjects: [baseProject({ specialty: 'تطوير الويب' })]
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
  const moduleUrl = `./ai-matching-engine.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { AiMatchingEngineService } = await import(moduleUrl);
  const service = new AiMatchingEngineService();

  const result = await service.getTop3MatchingProjects('provider-1');

  assert.deepEqual(result, []);
});

test('ai-matching-engine.service has no Gemini usage and reports DETERMINISTIC only', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./ai-matching-engine.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gemini|generateStructured|generateStream/i);
  assert.doesNotMatch(src, /generationSource: '(?!DETERMINISTIC)/);
});
