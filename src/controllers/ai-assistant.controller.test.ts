import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from '../services/ai/gemini/gemini.errors';

// ai-assistant.controller.ts's module scope eagerly does
// `new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ... })` for the
// unrelated, still-OpenAI-backed F8 (assistantChat) — same established
// pattern as client-requests.service.test.ts for the same reason. This has
// no effect on the F3 tests below, which mock geminiClient directly and
// never construct a real OpenAI client call.
process.env.OPENAI_API_KEY = 'test-key';

// F3 (analyzeProjectForProvider) — Batch A migration to the shared Gemini
// foundation. Plain req/res/next mocks, no supertest/HTTP server, matching
// this project's established controller-test convention (see
// profile.controller.test.ts). `geminiClient` and `prisma` are both mocked
// via t.mock.module so no real network/DB call ever happens.

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

function projectFixture(overrides: Partial<any> = {}) {
  return {
    id: 'project-1',
    title: 'تطوير متجر إلكتروني متكامل',
    specialty: 'تطوير الويب',
    requirements: ['React', 'Node.js'],
    budgetMin: 3000,
    budgetMax: 6000,
    deliveryDays: 14,
    client: { accountType: 'CLIENT_INDIVIDUAL', firstName: 'أحمد' },
    proposals: [],
    projectProposals: [],
    ...overrides
  };
}

function validAnalysisFixture(overrides: Partial<any> = {}) {
  return {
    matchPercent: 91,
    matchSummary: 'ملخص مطابقة حقيقي من Gemini',
    winningStrategy: ['نصيحة 1', 'نصيحة 2', 'نصيحة 3'],
    suggestedBidPrice: '4,500 ريال',
    priceRationale: 'مبرر السعر الحقيقي',
    clientInsights: 'تحليل شخصية العميل الحقيقي',
    riskAssessment: 'تقييم مخاطر حقيقي',
    ...overrides
  };
}

async function loadController(t: TestContext, opts: {
  project?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const updateSpy = t.mock.fn(async () => ({}));
  const prismaMock: any = {
    project: {
      findUnique: async () => (opts.project === undefined ? projectFixture() : opts.project),
      update: updateSpy
    },
    providerProfile: { findUnique: async () => null },
    providerGamification: { findUnique: async () => null }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => {
      throw new Error('generateStructured not stubbed for this test');
    })
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./ai-assistant.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { analyzeProjectForProvider: mod.analyzeProjectForProvider, updateSpy };
}

test('analyzeProjectForProvider: a real validated Gemini success is returned as-is and cached on Project.aiAnalysis', async (t) => {
  const analysis = validAnalysisFixture();
  const { analyzeProjectForProvider, updateSpy } = await loadController(t, {
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(analysis), true, 'the real validator must accept a well-formed analysis');
      return { data: analysis, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
    }
  });

  const req: any = { params: { projectId: 'project-1' }, user: { userId: 'provider-1' } };
  const res = createMockRes();

  await analyzeProjectForProvider(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: analysis });
  assert.equal(updateSpy.mock.callCount(), 1);
  assert.deepEqual(updateSpy.mock.calls[0].arguments[0], { where: { id: 'project-1' }, data: { aiAnalysis: analysis } });
});

test('analyzeProjectForProvider: Gemini unavailable returns an honest 503 with no fabricated data, and never writes aiAnalysis', async (t) => {
  const { analyzeProjectForProvider, updateSpy } = await loadController(t, {
    generateStructured: async () => {
      throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'Gemini service is currently unavailable');
    }
  });

  const req: any = { params: { projectId: 'project-1' }, user: { userId: 'provider-1' } };
  const res = createMockRes();

  await analyzeProjectForProvider(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  // No hash-derived score, no invented strengths/pricing/risk text of any kind.
  assert.equal('data' in res.body, false);
  assert.equal(updateSpy.mock.callCount(), 0);
});

test('analyzeProjectForProvider: a malformed Gemini response is rejected by the real validator and surfaces as the same honest failure, never as fake success', async (t) => {
  const malformed = { matchPercent: 250, matchSummary: '', winningStrategy: [] };
  const { analyzeProjectForProvider, updateSpy } = await loadController(t, {
    generateStructured: async (_prompt, options) => {
      // Mirrors the real GeminiClient's own contract: it runs the caller's
      // validator itself and throws INVALID_RESPONSE when it fails.
      if (!options.validate(malformed)) {
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini response failed application validation');
      }
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const req: any = { params: { projectId: 'project-1' }, user: { userId: 'provider-1' } };
  const res = createMockRes();

  await analyzeProjectForProvider(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  assert.equal('data' in res.body, false);
  assert.equal(updateSpy.mock.callCount(), 0);
});

test('analyzeProjectForProvider: 404s honestly when the project does not exist, without calling Gemini', async (t) => {
  let generateStructuredCalled = false;
  const { analyzeProjectForProvider, updateSpy } = await loadController(t, {
    project: null,
    generateStructured: async () => { generateStructuredCalled = true; throw new Error('should never be called'); }
  });

  const req: any = { params: { projectId: 'missing-project' }, user: { userId: 'provider-1' } };
  const res = createMockRes();

  await analyzeProjectForProvider(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.equal(generateStructuredCalled, false);
  assert.equal(updateSpy.mock.callCount(), 0);
});
