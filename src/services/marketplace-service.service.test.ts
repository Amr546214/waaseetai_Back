import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3E.1: getMarketplaceModels()/getMarketplaceModelById() previously
// built provider name/avatar from the raw, shared User columns and provider
// "level" from the stale, never-written User.currentLevel — even though
// ProviderProfile has its own independent Phase 3A/3D.1 display columns and
// ProviderGamification.currentLevelIndex is the real, persisted (Phase
// 3D.3A) progression cache. These tests exercise the fixed listing/detail
// formatting and the level filter's Prisma WHERE clause against a small,
// realistic in-memory simulation of Prisma's filtering semantics — precise
// enough to prove pagination/total stay correct under level filtering
// without ever touching a real DB.

function makeService(overrides: any = {}) {
  return {
    id: overrides.id || 'service-1',
    title: overrides.title || 'خدمة تجريبية',
    description: 'وصف',
    status: 'PUBLISHED',
    totalAmount: 100,
    totalDays: 5,
    aiScore: 80,
    aiAuditScore: 80,
    aiClarityScore: 0,
    aiFeasibilityScore: 0,
    aiReviewSummary: '',
    viewsCount: 0,
    salesCount: 0,
    isFeatured: false,
    discountPercentage: null,
    offerEndsAt: null,
    gallery: [],
    tags: [],
    specialty: { name: 'Design', nameAr: 'تصميم', slug: 'design', category: { nameAr: 'فئة', slug: 'cat' } },
    stages: [],
    portfolioItem: null,
    accreditationSample: null,
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

// Minimal, realistic-enough simulation of Prisma's filtering semantics for
// the exact WHERE shapes getMarketplaceModels() can construct on
// `whereClause.provider` — proves the filter is expressed entirely inside
// the WHERE clause (never post-fetch), so findMany() and count() below stay
// consistent with each other under identical filtering.
function matchesProviderFilter(provider: any, whereProvider: any): boolean {
  if (!whereProvider) return true;
  if (whereProvider.OR) {
    return whereProvider.OR.some((cond: any) => matchesProviderFilter(provider, cond));
  }
  if ('gamification' in whereProvider && whereProvider.gamification === null) {
    return provider.gamification === null || provider.gamification === undefined;
  }
  if (whereProvider.gamification?.currentLevelIndex?.in) {
    return Boolean(provider.gamification) && whereProvider.gamification.currentLevelIndex.in.includes(provider.gamification.currentLevelIndex);
  }
  return true;
}

function createMockPrisma(t: TestContext, services: any[]) {
  const findManySpy = t.mock.fn(async (args: any) => {
    const matched = services.filter(s => matchesProviderFilter(s.provider, args.where?.provider));
    const skip = args.skip || 0;
    const take = args.take ?? matched.length;
    return matched.slice(skip, skip + take);
  });
  const countSpy = t.mock.fn(async (args: any) => services.filter(s => matchesProviderFilter(s.provider, args.where?.provider)).length);

  const prismaMock: any = {
    serviceCatalog: {
      findMany: findManySpy,
      count: countSpy,
      findUnique: async (args: any) => services.find(s => s.id === args.where.id) || null,
      update: async (args: any) => ({ viewsCount: 1 })
    },
    review: { aggregate: async () => ({ _count: { _all: 0 }, _avg: { rating: null } }) }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./marketplace-ai.service', { namedExports: { marketplaceAiService: {} } });

  return { findManySpy, countSpy };
}

async function loadService(t: TestContext, services: any[]) {
  const mocks = createMockPrisma(t, services);
  const moduleUrl = `./marketplace-service.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { MarketplaceService } = await import(moduleUrl);
  return { marketplaceService: new MarketplaceService(), ...mocks };
}

// --- Identity (Parts 2) -------------------------------------------------

test('getMarketplaceModels: uses ProviderProfile name/avatar over legacy User when both are present', async (t) => {
  const provider = makeProvider({
    providerProfile: { firstName: 'Provider', lastName: 'Persona', avatarUrl: 'https://provider.example/a.png', isVerified: true }
  });
  const { marketplaceService } = await loadService(t, [makeService({ provider })]);

  const result = await marketplaceService.getMarketplaceModels({});

  assert.equal(result.models[0].provider.name, 'Provider Persona');
  assert.equal(result.models[0].provider.avatar, 'https://provider.example/a.png');
});

test('getMarketplaceModels: falls back to legacy User name/avatar when ProviderProfile display fields are missing', async (t) => {
  const provider = makeProvider(); // providerProfile display fields are all null by default
  const { marketplaceService } = await loadService(t, [makeService({ provider })]);

  const result = await marketplaceService.getMarketplaceModels({});

  assert.equal(result.models[0].provider.name, 'Legacy Name');
  assert.equal(result.models[0].provider.avatar, 'https://legacy.example/avatar.png');
});

test('getMarketplaceModelById: uses ProviderProfile name/avatar over legacy User', async (t) => {
  const provider = makeProvider({
    providerProfile: { firstName: 'Provider', lastName: 'Persona', avatarUrl: 'https://provider.example/a.png', isVerified: true }
  });
  const { marketplaceService } = await loadService(t, [makeService({ id: 'service-1', provider })]);

  const result = await marketplaceService.getMarketplaceModelById('service-1');

  assert.equal(result.provider.name, 'Provider Persona');
  assert.equal(result.provider.avatar, 'https://provider.example/a.png');
});

// --- Level display (Part 3) ----------------------------------------------

test('getMarketplaceModels: level uses canonical ProviderGamification progression, not legacy User.currentLevel', async (t) => {
  const provider = makeProvider({
    currentLevel: 'مستكشف - المستوى 1', // stale legacy value — must NOT be what's shown
    gamification: { points: 150, currentLevelIndex: 3 } // LEVEL_MATRIX[2] = 'منفذ'
  });
  const { marketplaceService } = await loadService(t, [makeService({ provider })]);

  const result = await marketplaceService.getMarketplaceModels({});

  assert.equal(result.models[0].level, 'منفذ');
});

test('getMarketplaceModelById: level uses canonical ProviderGamification progression', async (t) => {
  const provider = makeProvider({ gamification: { points: 751, currentLevelIndex: 6 } }); // 'متمكن'
  const { marketplaceService } = await loadService(t, [makeService({ id: 'service-1', provider })]);

  const result = await marketplaceService.getMarketplaceModelById('service-1');

  assert.equal(result.level, 'متمكن');
});

test('getMarketplaceModels: legacy User.currentLevel is used ONLY as the explicit fallback when ProviderGamification is genuinely absent', async (t) => {
  const provider = makeProvider({ currentLevel: 'مستكشف - المستوى 1', gamification: null });
  const { marketplaceService } = await loadService(t, [makeService({ provider })]);

  const result = await marketplaceService.getMarketplaceModels({});

  // No ProviderGamification row at all -> falls back to legacy currentLevel,
  // exactly matching resolveProviderProgression's own documented fallback.
  assert.equal(result.models[0].level, 'مستكشف - المستوى 1');
});

test('getMarketplaceModels: an existing ProviderGamification row always overrides legacy User.currentLevel, even if they disagree', async (t) => {
  const provider = makeProvider({
    currentLevel: 'مستكشف - المستوى 1', // deliberately stale/disagreeing legacy value
    gamification: { points: 0, currentLevelIndex: 1 } // LEVEL_MATRIX[0] = 'مبتدئ'
  });
  const { marketplaceService } = await loadService(t, [makeService({ provider })]);

  const result = await marketplaceService.getMarketplaceModels({});

  assert.equal(result.models[0].level, 'مبتدئ');
});

// --- Level filter (Part 4) -------------------------------------------------

test('getMarketplaceModels (level filter): filters by the canonical ProviderGamification-derived level, not legacy User.currentLevel', async (t) => {
  const levelOneProvider = makeProvider({ id: 'p1', gamification: { points: 0, currentLevelIndex: 1 } }); // 'مبتدئ'
  const levelThreeProvider = makeProvider({ id: 'p2', gamification: { points: 150, currentLevelIndex: 3 } }); // 'منفذ'
  const services = [
    makeService({ id: 's1', provider: levelOneProvider }),
    makeService({ id: 's2', provider: levelThreeProvider })
  ];
  const { marketplaceService } = await loadService(t, services);

  const result = await marketplaceService.getMarketplaceModels({ level: 'منفذ' });

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, 's2');
  assert.equal(result.total, 1);
});

test('getMarketplaceModels (level filter): different requested levels produce differentiated result sets', async (t) => {
  const levelOneProvider = makeProvider({ id: 'p1', gamification: { points: 0, currentLevelIndex: 1 } });
  const levelThreeProvider = makeProvider({ id: 'p2', gamification: { points: 150, currentLevelIndex: 3 } });
  const services = [
    makeService({ id: 's1', provider: levelOneProvider }),
    makeService({ id: 's2', provider: levelThreeProvider })
  ];
  const { marketplaceService } = await loadService(t, services);

  const zaerResult = await marketplaceService.getMarketplaceModels({ level: 'مبتدئ' });
  const baaithResult = await marketplaceService.getMarketplaceModels({ level: 'منفذ' });

  assert.equal(zaerResult.models.map((m: any) => m.id).join(','), 's1');
  assert.equal(baaithResult.models.map((m: any) => m.id).join(','), 's2');
});

test('getMarketplaceModels (level filter): a provider with no ProviderGamification row is included when filtering for the base level (matches its displayed fallback level)', async (t) => {
  const noGamificationProvider = makeProvider({ id: 'p1', currentLevel: 'أي شيء', gamification: null });
  const { marketplaceService } = await loadService(t, [makeService({ id: 's1', provider: noGamificationProvider })]);

  const result = await marketplaceService.getMarketplaceModels({ level: 'مبتدئ' });

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, 's1');
});

test('getMarketplaceModels (level filter): pagination and total remain correct — count() and findMany() agree under the same WHERE filter', async (t) => {
  const services = Array.from({ length: 5 }, (_, i) =>
    makeService({ id: `s${i}`, provider: makeProvider({ id: `p${i}`, gamification: { points: 150, currentLevelIndex: 3 } }) })
  );
  // One extra, non-matching service that must be excluded from both the page and the total.
  services.push(makeService({ id: 's-other', provider: makeProvider({ id: 'p-other', gamification: { points: 0, currentLevelIndex: 1 } }) }));

  const { marketplaceService } = await loadService(t, services);

  const result = await marketplaceService.getMarketplaceModels({ level: 'منفذ', page: 1, limit: 2 });

  // Total reflects the FULL filtered count (5), not just the page size —
  // proving count() and findMany() were filtered identically at the DB
  // level, not via in-memory post-pagination filtering.
  assert.equal(result.total, 5);
  assert.equal(result.models.length, 2);
  assert.equal(result.totalPages, 3);
  assert.ok(result.models.every((m: any) => m.id !== 's-other'));
});

test('getMarketplaceModels (level filter): an unrecognized level title matches nothing (fail-closed, same as the old behavior for any value no provider held)', async (t) => {
  const provider = makeProvider({ gamification: { points: 150, currentLevelIndex: 3 } });
  const { marketplaceService } = await loadService(t, [makeService({ provider })]);

  const result = await marketplaceService.getMarketplaceModels({ level: 'garbage-level-title' });

  assert.equal(result.models.length, 0);
  assert.equal(result.total, 0);
});

// --- Cross-role isolation ---------------------------------------------------

test('getMarketplaceModels: no ClientProfile/AffiliateProfile data participates in Provider marketplace display', async (t) => {
  const provider = makeProvider({ providerProfile: { firstName: 'Provider', lastName: 'Persona', avatarUrl: null, isVerified: true } });
  const { marketplaceService } = await loadService(t, [makeService({ provider })]);

  const result = await marketplaceService.getMarketplaceModels({});

  // The provider select shape never requests clientProfile/affiliateProfile
  // at all — nothing in the mock even defines those models, so any attempt
  // to read them would have thrown.
  assert.equal(result.models[0].provider.name, 'Provider Persona');
});

// --- Removed fake AI audit ---------------------------------------------------

// Final AI cleanup batch: auditServiceWithAI() previously simulated an "AI
// audit" with a fake `let score = 95` plus a fabricated 800ms latency and no
// real analysis at all. Removed entirely along with its controller/route.
// This guards against it silently reappearing.
test('MarketplaceService: the removed fake auditServiceWithAI method must never reappear', async (t) => {
  const { marketplaceService } = await loadService(t, []);
  assert.equal((marketplaceService as any).auditServiceWithAI, undefined);
});

// Final AI cleanup batch: getCenterData() (behind the dead GET /center route,
// zero frontend caller) fabricated a fake aiAnalysis feed, hardcoded
// aiScore/aiClarityScore/aiFeasibilityScore fallbacks (85/88/85), and a
// hardcoded `rating: 4.8` on every service. Removed entirely along with its
// controller method and route.
test('MarketplaceService: the removed dead getCenterData method (fake aiAnalysis/rating) must never reappear', async (t) => {
  const { marketplaceService } = await loadService(t, []);
  assert.equal((marketplaceService as any).getCenterData, undefined);
});
