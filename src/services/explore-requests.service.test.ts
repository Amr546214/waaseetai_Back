import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Regression coverage for the Explore Requests visibility fix: browsing OPEN
// requests must not be gated by ProviderSpecialty.status = APPROVED (or by
// having any ProviderSpecialty row at all). Only the request's own OPEN
// status, and the optional specialty category filter, may hide a request.

function buildClientRequestFixtures() {
  return [
    {
      id: 'cr-open-design',
      title: 'تصميم هوية بصرية كاملة',
      description: 'وصف الطلب المفتوح',
      specialtyId: 'spec-design',
      specialty: { id: 'spec-design', nameAr: 'تصميم جرافيك', name: null, nameEn: null },
      subSpecialties: [],
      requiredSkills: [],
      minBudget: 1000,
      maxBudget: 3000,
      expectedDurationDays: 14,
      proposalsCount: 0,
      preferredProviderType: 'INDIVIDUAL',
      createdAt: new Date(),
      status: 'OPEN',
      proposals: []
    },
    {
      id: 'cr-closed-design',
      title: 'طلب تصميم مغلق',
      description: 'طلب لم يعد متاحاً لاستقبال العروض',
      specialtyId: 'spec-design',
      specialty: { id: 'spec-design', nameAr: 'تصميم جرافيك', name: null, nameEn: null },
      subSpecialties: [],
      requiredSkills: [],
      minBudget: 500,
      maxBudget: 1500,
      expectedDurationDays: 7,
      proposalsCount: 0,
      preferredProviderType: 'INDIVIDUAL',
      createdAt: new Date(),
      status: 'CLOSED',
      proposals: []
    }
  ];
}

function createExploreMockPrisma(t: TestContext, opts: { providerSpecialties?: any[] } = {}) {
  const fixtures = buildClientRequestFixtures();

  const prismaMock: any = {
    providerProfile: {
      findUnique: async () => ({ providerSpecialties: opts.providerSpecialties ?? [] })
    },
    clientRequest: {
      findMany: async (args: any) => fixtures.filter(cr => cr.status === args?.where?.status)
    },
    project: {
      findMany: async () => []
    }
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  return prismaMock;
}

async function loadService(t: TestContext, opts?: Parameters<typeof createExploreMockPrisma>[1]) {
  createExploreMockPrisma(t, opts);
  const moduleUrl = `./explore-requests.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { exploreRequestsService } = await import(moduleUrl);
  return exploreRequestsService;
}

test('getExploreRequests: provider with no ProviderSpecialty rows at all can still browse OPEN requests', async (t) => {
  const service = await loadService(t, { providerSpecialties: [] });
  const result = await service.getExploreRequests('provider-1', {});
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].id, 'cr-open-design');
});

const NON_APPROVED_AND_APPROVED_STATUSES = ['PENDING_PROOF', 'UNDER_AI_REVIEW', 'TEST_REQUIRED', 'REJECTED', 'APPROVED'];

for (const status of NON_APPROVED_AND_APPROVED_STATUSES) {
  test(`getExploreRequests: provider whose only specialty is ${status} can still browse OPEN requests (not gated by verification status)`, async (t) => {
    const service = await loadService(t, {
      providerSpecialties: [
        {
          specialtyId: 'spec-design',
          status,
          isActive: true,
          subSpecialties: [],
          specialty: { nameAr: 'تصميم جرافيك', name: null, nameEn: null }
        }
      ]
    });
    const result = await service.getExploreRequests('provider-1', {});
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].id, 'cr-open-design');
  });
}

test('getExploreRequests: a CLOSED (non-OPEN) request never appears, regardless of provider specialty state', async (t) => {
  const service = await loadService(t, { providerSpecialties: [] });
  const result = await service.getExploreRequests('provider-1', {});
  assert.equal(result.projects.some((p: any) => p.id === 'cr-closed-design'), false);
});

test('getExploreRequests: specialty filter narrows results to the matching category without blocking browsing overall', async (t) => {
  const service = await loadService(t, { providerSpecialties: [] });

  const matching = await service.getExploreRequests('provider-1', { category: 'تصميم جرافيك' });
  assert.equal(matching.projects.length, 1);
  assert.equal(matching.projects[0].id, 'cr-open-design');

  const nonMatching = await service.getExploreRequests('provider-1', { category: 'تطوير برمجي' });
  assert.equal(nonMatching.projects.length, 0);

  const allCategory = await service.getExploreRequests('provider-1', { category: 'all' });
  assert.equal(allCategory.projects.length, 1);
});

// F15b (security follow-up batch): this list's match score is a real,
// deterministic keyword/heuristic engine — it never calls Gemini/OpenAI —
// so every item must be honestly labeled and must never claim the ranking
// was AI-generated.
test('getExploreRequests: every item is honestly labeled DETERMINISTIC and never claims to be AI-generated', async (t) => {
  const service = await loadService(t, { providerSpecialties: [] });

  const result = await service.getExploreRequests('provider-1', {});

  assert.equal(result.projects.length, 1);
  const item = result.projects[0];
  assert.equal(item.generationSource, 'DETERMINISTIC');
  assert.ok(typeof item.aiMatchScore === 'number');
  assert.ok(!item.aiNote.includes('الذكاء الاصطناعي'), 'aiNote must not claim to be generated by AI');
});
