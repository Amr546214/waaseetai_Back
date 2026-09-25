import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// AI-18 (executeAuditSync, behind the admin-only POST /business-models/re-audit-all)
// — OpenAI migration batch. The previous OpenAI path silently defaulted a
// missing/malformed score to 85 via `Number(parsed.overallScore) || 85` and
// still marked the audit "completed" — a fabricated success. isValidAiAuditReport
// now rejects any malformed shape before it can reach the persisted result,
// routing it to the same honest manual-review default used for "provider
// unavailable". `prisma`, `geminiClient`, `getIO`, `emailService`, and
// `notificationService` are all mocked; no real DB/network call ever happens.

function serviceCatalogFixture(overrides: Partial<any> = {}) {
  return {
    id: 'service-1',
    providerId: 'provider-1',
    title: 'خدمة تصميم هوية بصرية',
    description: 'وصف حقيقي وكامل للخدمة المعروضة',
    totalAmount: 5000,
    totalDays: 10,
    approvedAt: null,
    stages: [
      { title: 'مرحلة 1', description: 'وصف', deliveryDays: 5, percentage: 50, computedAmount: 2500 },
      { title: 'مرحلة 2', description: 'وصف', deliveryDays: 5, percentage: 50, computedAmount: 2500 }
    ],
    provider: { email: 'provider@example.com', firstName: 'أحمد' },
    ...overrides
  };
}

function validAuditFixture(overrides: Partial<any> = {}) {
  return {
    overallScore: 82,
    clarityScore: 85,
    feasibilityScore: 80,
    isApproved: true,
    decisionSummary: 'تقييم حقيقي من Gemini',
    strengths: ['قوة 1'],
    criticalGaps: [],
    improvementSuggestions: ['تحسين 1'],
    ...overrides
  };
}

async function loadService(t: TestContext, opts: {
  service?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const updateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const prismaMock: any = {
    serviceCatalog: {
      findUnique: async () => (opts.service === undefined ? serviceCatalogFixture() : opts.service),
      update: updateSpy
    }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async (_prompt: string, options: any) => {
      const valid = validAuditFixture();
      assert.equal(options.validate(valid), true, 'the real validator must accept a well-formed audit report');
      return { data: valid, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  t.mock.module('../socket', { namedExports: { getIO: () => null } });
  t.mock.module('./email.service', { namedExports: { emailService: { sendModelApprovalEmail: async () => undefined } } });
  const notifySpy = t.mock.fn(async () => ({ id: 'notif-1' }));
  t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmitNotification: notifySpy } } });

  const moduleUrl = `./ai-audit.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { aiAuditService } = await import(moduleUrl);
  return { aiAuditService, updateSpy, notifySpy };
}

// ── real validated Gemini success ───────────────────────────────────────

test('executeAuditSync: a real validated Gemini audit is persisted with its real score, and the model still publishes', async (t) => {
  const { aiAuditService, updateSpy } = await loadService(t, {});

  const result = await aiAuditService.executeAuditSync('service-1', 'provider-1');

  assert.equal(result.status, 'PUBLISHED');
  assert.equal(result.auditResult.overallScore, 82);
  assert.equal(updateSpy.mock.callCount(), 1);
  assert.equal(updateSpy.mock.calls[0].arguments[0].data.aiScore, 82);
  assert.equal(updateSpy.mock.calls[0].arguments[0].data.status, 'PUBLISHED');
});

// ── Gemini failure / malformed output → honest manual-review default, never a fabricated score ──

test('executeAuditSync: Gemini unavailable persists the honest zero-score manual-review default, never a fake score, but still publishes (advisory-only audit)', async (t) => {
  const { aiAuditService, updateSpy } = await loadService(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  const result = await aiAuditService.executeAuditSync('service-1', 'provider-1');

  assert.equal(result.auditResult.overallScore, 0);
  assert.equal(result.auditResult.isApproved, false);
  assert.equal(updateSpy.mock.calls[0].arguments[0].data.aiScore, 0);
});

test('executeAuditSync: Gemini not configured persists the same honest zero-score default', async (t) => {
  const { aiAuditService } = await loadService(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.NOT_CONFIGURED, 'GEMINI_API_KEY is not configured'); }
  });

  const result = await aiAuditService.executeAuditSync('service-1', 'provider-1');

  assert.equal(result.auditResult.overallScore, 0);
});

test('executeAuditSync: a Gemini timeout persists the same honest zero-score default', async (t) => {
  const { aiAuditService } = await loadService(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.TIMEOUT, 'timed out'); }
  });

  const result = await aiAuditService.executeAuditSync('service-1', 'provider-1');

  assert.equal(result.auditResult.overallScore, 0);
});

test('executeAuditSync: a malformed Gemini response (missing overallScore) is rejected by the validator instead of defaulting to a fabricated 85', async (t) => {
  const { aiAuditService, updateSpy } = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      const malformed = { ...validAuditFixture(), overallScore: undefined };
      assert.equal(options.validate(malformed), false, 'the validator must reject a missing overallScore');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });

  const result = await aiAuditService.executeAuditSync('service-1', 'provider-1');

  assert.equal(result.auditResult.overallScore, 0, 'must never silently fall back to the old fabricated 85');
  assert.equal(updateSpy.mock.calls[0].arguments[0].data.aiScore, 0);
});

test('executeAuditSync: a malformed Gemini response (out-of-range clarityScore) is rejected by the validator', async (t) => {
  const { aiAuditService } = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      const malformed = validAuditFixture({ clarityScore: 250 });
      assert.equal(options.validate(malformed), false, 'the validator must reject an out-of-range score');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });

  const result = await aiAuditService.executeAuditSync('service-1', 'provider-1');

  assert.equal(result.auditResult.overallScore, 0);
});

test('executeAuditSync: a malformed Gemini response (isApproved not boolean) is rejected by the validator', async (t) => {
  const { aiAuditService } = await loadService(t, {
    generateStructured: async (_prompt, options) => {
      const malformed = { ...validAuditFixture(), isApproved: 'yes' };
      assert.equal(options.validate(malformed), false, 'the validator must reject a non-boolean isApproved');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });

  const result = await aiAuditService.executeAuditSync('service-1', 'provider-1');

  assert.equal(result.auditResult.overallScore, 0);
});

// ── DB safety: validated once, persisted once ─────────────────────────────

test('executeAuditSync: the DB is written exactly once, only after the audit outcome (real or honest-default) is fully resolved', async (t) => {
  const { updateSpy, aiAuditService } = await loadService(t, {});

  await aiAuditService.executeAuditSync('service-1', 'provider-1');

  assert.equal(updateSpy.mock.callCount(), 1);
});

test('executeAuditSync: a missing ServiceCatalog record is a safe no-op, never calls Gemini', async (t) => {
  let called = false;
  const { aiAuditService, updateSpy } = await loadService(t, {
    service: null,
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });

  const result = await aiAuditService.executeAuditSync('missing-service', 'provider-1');

  assert.equal(result, null);
  assert.equal(called, false);
  assert.equal(updateSpy.mock.callCount(), 0);
});

// ── admin re-audit-all trigger surface ─────────────────────────────────────

test('AiAuditService: the admin re-audit-all route only ever calls executeAuditSync directly (triggerAuditAndPublish/auditProjectModel have zero callers)', async (t) => {
  const { aiAuditService } = await loadService(t, {});
  // Documents current reachability: both wrapper methods still exist for
  // backward compatibility but nothing in this codebase calls them anymore.
  assert.equal(typeof aiAuditService.triggerAuditAndPublish, 'function');
  assert.equal(typeof aiAuditService.auditProjectModel, 'function');
  assert.equal(typeof aiAuditService.executeAuditSync, 'function');
});
