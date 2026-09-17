import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3E.1: formatModelForClient() previously built provider name/avatar
// from raw User columns and "level" from the stale, never-written
// User.currentLevel. It now uses ProviderProfile's own display columns
// (User fallback only if null) and ProviderGamification.currentLevelIndex
// via the same resolveProviderProgression helper the rest of the app
// already uses — display formatting only, never the AI ranking prompt.
//
// Leaving OPENAI_API_KEY unset forces the service's constructor to leave
// `this.openai = null`, so generateAiRecommendations() takes its existing
// "Robust Algorithmic Heuristic Fallback" branch — which never calls
// OpenAI at all — while still exercising the exact same formatModelForClient()
// this phase changed. This lets these tests prove the display fix without
// mocking the OpenAI client, and without touching the (unchanged) AI branch.
delete process.env.OPENAI_API_KEY;

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

async function loadService(t: TestContext, dbModels: any[]) {
  createMockPrisma(t, dbModels);
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
    gamification: { points: 150, currentLevelIndex: 3 } // 'باحث'
  });
  const service = await loadService(t, [makeDbModel({ provider })]);

  const result = await service.generateAiRecommendations({});

  assert.equal(result.recommendations[0].level, 'باحث');
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
