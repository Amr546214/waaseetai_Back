import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from '../services/ai/gemini/gemini.errors';

// F9 (evaluateSpecialtyWithAI) — Batch: F9+F10 Vision migration to the
// shared Gemini foundation. Plain req/res mocks, no HTTP server. `prisma`,
// `geminiClient`, and `fetchRemoteImage` are all mocked; no real DB/network
// call ever happens.

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

function workSampleFixture(overrides: Partial<any> = {}) {
  return {
    id: 'sample-1',
    title: 'متجر إلكتروني',
    description: 'وصف حقيقي للنموذج',
    technologies: ['React', 'Node.js'],
    mimeType: 'image/png',
    fileBytes: 20000,
    watermarkLabel: 'WM-1',
    publicSampleUrl: 'https://cdn.example.com/sample1.png',
    proofs: [],
    ...overrides
  };
}

function providerSpecialtyFixture(overrides: Partial<any> = {}) {
  return {
    id: 'spec-1',
    specialtyId: 'specialty-1',
    subSpecialties: ['React'],
    specialty: { name: 'تطوير الويب' },
    workSamples: [workSampleFixture()],
    ...overrides
  };
}

function validEvaluationFixture(overrides: Partial<any> = {}) {
  return {
    aiScore: 82,
    feasibilityScore: 79,
    clarityScore: 85,
    ownershipCredibility: 74,
    summary: 'ملخص حقيقي من Gemini',
    strengths: ['قوة 1', 'قوة 2'],
    warnings: ['تحذير 1'],
    corrections: [],
    isEligibleForTesting: true,
    ...overrides
  };
}

async function loadController(t: TestContext, opts: {
  providerSpecialty?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
  generateStructuredWithImage?: (prompt: string, options: any) => Promise<any>;
  fetchRemoteImage?: (url: string, options?: any) => Promise<any>;
}) {
  const updateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const auditLogCreateSpy = t.mock.fn(async (args: any) => ({ id: 'audit-1', ...args.data }));
  const prismaMock: any = {
    providerSpecialty: {
      findUnique: async () => (opts.providerSpecialty === undefined ? providerSpecialtyFixture() : opts.providerSpecialty),
      update: updateSpy
    },
    aiAuditLog: { create: auditLogCreateSpy },
    $transaction: async (operations: Promise<any>[]) => Promise.all(operations)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); }),
    generateStructuredWithImage: opts.generateStructuredWithImage ?? (async () => { throw new Error('generateStructuredWithImage not stubbed for this test'); })
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const fetchRemoteImageMock = opts.fetchRemoteImage ?? (async (url: string) => ({ mimeType: 'image/png', data: Buffer.from(`bytes-for-${url}`) }));
  t.mock.module('../utils/remote-image-fetch', { namedExports: { fetchRemoteImage: fetchRemoteImageMock } });

  const moduleUrl = `./specialty-ai.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { evaluateSpecialtyWithAI: mod.evaluateSpecialtyWithAI, updateSpy, auditLogCreateSpy };
}

test('evaluateSpecialtyWithAI: a genuine validated success with a fetchable image uses the Vision path and persists real scores + real usage', async (t) => {
  const evaluation = validEvaluationFixture();
  let capturedImages: any;
  const { evaluateSpecialtyWithAI, updateSpy, auditLogCreateSpy } = await loadController(t, {
    generateStructuredWithImage: async (_prompt, options) => {
      capturedImages = options.images;
      assert.equal(options.validate(evaluation), true, 'the real validator must accept a well-formed evaluation');
      return { data: evaluation, usage: { promptTokens: 500, completionTokens: 300, totalTokens: 800 } };
    }
  });

  const req: any = { params: { id: 'spec-1' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.scores.aiScore, 82);
  assert.equal(capturedImages.length, 1);
  assert.equal(capturedImages[0].mimeType, 'image/png');

  // Second update call is the real-scores write inside the transaction (the
  // first call is the earlier UNDER_AI_REVIEW status transition).
  const scoreWriteCall = updateSpy.mock.calls[1].arguments[0];
  assert.equal(scoreWriteCall.data.aiScore, 82);
  assert.equal(scoreWriteCall.data.status, 'TEST_REQUIRED');

  const auditLogArgs = auditLogCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(auditLogArgs.promptTokens, 500);
  assert.equal(auditLogArgs.completionTokens, 300);
  assert.equal(auditLogArgs.totalTokens, 800);
});

// ── safety re-audit: credential auto-grant boundary ─────────────────────────
//
// evaluateSpecialtyWithAI is the FIRST of two required stages — even a
// perfect Gemini score only ever writes SpecialtyVerificationStatus.
// TEST_REQUIRED (never APPROVED), so a single Gemini call can grant
// eligibility for the real, deterministic assessment quiz
// (ai-assessment.service.ts / assessment.gateway.ts, scored by real answer
// matching) but never the binding APPROVED/isPassed credential itself.

test('evaluateSpecialtyWithAI: even a maximal Gemini score only ever grants TEST_REQUIRED eligibility, never the binding APPROVED credential by itself (requirement 1)', async (t) => {
  const perfectEvaluation = validEvaluationFixture({ aiScore: 100, feasibilityScore: 100, clarityScore: 100, ownershipCredibility: 100, isEligibleForTesting: true });
  const { evaluateSpecialtyWithAI, updateSpy } = await loadController(t, {
    generateStructuredWithImage: async () => ({ data: perfectEvaluation, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  });

  const req: any = { params: { id: 'spec-1' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  const scoreWriteCall = updateSpy.mock.calls[1].arguments[0];
  assert.equal(scoreWriteCall.data.status, 'TEST_REQUIRED');
  assert.notEqual(scoreWriteCall.data.status, 'APPROVED');
  assert.equal('isPassed' in scoreWriteCall.data, false, 'this stage never writes the isPassed credential field');
});

test('evaluateSpecialtyWithAI: a below-threshold Gemini result sets REJECTED only — no lockout, no isPassed downgrade, no unrelated punitive action (requirement 2)', async (t) => {
  const failing = validEvaluationFixture({ aiScore: 30, ownershipCredibility: 20, isEligibleForTesting: false });
  const { evaluateSpecialtyWithAI, updateSpy } = await loadController(t, {
    generateStructuredWithImage: async () => ({ data: failing, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  });

  const req: any = { params: { id: 'spec-1' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  assert.equal(res.statusCode, 200);
  const scoreWriteCall = updateSpy.mock.calls[1].arguments[0];
  assert.equal(scoreWriteCall.data.status, 'REJECTED');
  assert.equal('lockoutUntil' in scoreWriteCall.data, false, 'a single failed vision evaluation must never itself lock the account out — only the separate quiz-attempt anti-cheat path (quiz.controller.ts/quiz.socket.ts) can do that');
  assert.equal('isPassed' in scoreWriteCall.data, false);
});

test('evaluateSpecialtyWithAI: an unfetchable image is skipped (best-effort) and evaluation proceeds text-only', async (t) => {
  const evaluation = validEvaluationFixture();
  let structuredCalled = false;
  let withImageCalled = false;
  const { evaluateSpecialtyWithAI } = await loadController(t, {
    fetchRemoteImage: async () => { throw new Error('image fetch failed'); },
    generateStructured: async (_prompt, options) => {
      structuredCalled = true;
      assert.equal(options.validate(evaluation), true);
      return { data: evaluation, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    generateStructuredWithImage: async () => { withImageCalled = true; throw new Error('should never be called'); }
  });

  const req: any = { params: { id: 'spec-1' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(structuredCalled, true);
  assert.equal(withImageCalled, false);
});

test('evaluateSpecialtyWithAI: no work samples produce a fetchable image results in a text-only Gemini call', async (t) => {
  const evaluation = validEvaluationFixture();
  let withImageCalled = false;
  const { evaluateSpecialtyWithAI } = await loadController(t, {
    providerSpecialty: providerSpecialtyFixture({ workSamples: [workSampleFixture({ publicSampleUrl: '', mimeType: 'application/zip' })] }),
    generateStructured: async () => ({ data: evaluation, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    generateStructuredWithImage: async () => { withImageCalled = true; throw new Error('should never be called'); }
  });

  const req: any = { params: { id: 'spec-1' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(withImageCalled, false);
});

test('evaluateSpecialtyWithAI: Gemini not configured produces an honest 502, rolls back to PENDING_PROOF, and logs zero (never fabricated) usage', async (t) => {
  const { evaluateSpecialtyWithAI, updateSpy, auditLogCreateSpy } = await loadController(t, {
    generateStructuredWithImage: async () => { throw new GeminiProviderError(GeminiErrorCode.NOT_CONFIGURED, 'GEMINI_API_KEY is not configured'); }
  });

  const req: any = { params: { id: 'spec-1' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.success, false);
  assert.equal('data' in res.body, false);

  const rollbackCall = updateSpy.mock.calls[updateSpy.mock.calls.length - 1].arguments[0];
  assert.equal(rollbackCall.data.status, 'PENDING_PROOF');
  assert.equal('aiScore' in rollbackCall.data, false, 'no score fields may be written on failure');

  const auditLogArgs = auditLogCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(auditLogArgs.promptTokens, 0);
  assert.equal(auditLogArgs.completionTokens, 0);
  assert.equal(auditLogArgs.totalTokens, 0);
  assert.equal(auditLogArgs.evaluationResult, 'SYSTEM_ERROR');

  // Guard against the old hardcoded fallback numbers ever reappearing anywhere.
  const serialized = JSON.stringify({ body: res.body, updates: updateSpy.mock.calls.map((c: any) => c.arguments[0]), audits: auditLogCreateSpy.mock.calls.map((c: any) => c.arguments[0]) });
  assert.doesNotMatch(serialized, /89\.5|92\.0|86\.0|91\.0|480|290|770/);
});

test('evaluateSpecialtyWithAI: a malformed Gemini response is rejected by the real validator and treated as the same honest failure', async (t) => {
  const malformed = { aiScore: 999, summary: '', strengths: [], warnings: [], corrections: [], isEligibleForTesting: 'yes' };
  const { evaluateSpecialtyWithAI, updateSpy } = await loadController(t, {
    generateStructuredWithImage: async (_prompt, options) => {
      if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const req: any = { params: { id: 'spec-1' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  assert.equal(res.statusCode, 502);
  const rollbackCall = updateSpy.mock.calls[updateSpy.mock.calls.length - 1].arguments[0];
  assert.equal(rollbackCall.data.status, 'PENDING_PROOF');
});

test('evaluateSpecialtyWithAI: 404s honestly when the provider specialty does not exist, without calling Gemini', async (t) => {
  let called = false;
  const { evaluateSpecialtyWithAI } = await loadController(t, {
    providerSpecialty: null,
    generateStructuredWithImage: async () => { called = true; throw new Error('should never be called'); }
  });

  const req: any = { params: { id: 'missing-spec' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(called, false);
});

test('evaluateSpecialtyWithAI: 400s honestly when there are no work samples, without calling Gemini', async (t) => {
  let called = false;
  const { evaluateSpecialtyWithAI } = await loadController(t, {
    providerSpecialty: providerSpecialtyFixture({ workSamples: [] }),
    generateStructuredWithImage: async () => { called = true; throw new Error('should never be called'); },
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });

  const req: any = { params: { id: 'spec-1' } };
  const res = createMockRes();
  await evaluateSpecialtyWithAI(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});
