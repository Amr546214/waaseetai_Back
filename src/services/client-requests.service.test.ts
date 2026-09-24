import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// Phase 3D.4: createRequest()'s ClientProfile self-heal used to create a bare
// `{ userId, isProfileComplete: true }` row. It now routes through the same
// canonical role-state initializer every other role-creation path uses —
// seeding display fields and computing a real initial completionPercentage
// — while preserving `isProfileComplete: true` exactly (a separate,
// pre-existing concept from completionPercentage, passed through as
// extraFields). These tests only exercise that self-heal step; the rest of
// createRequest (specialty/category resolution, request creation, etc.) is
// intentionally left unmocked and any error from it is swallowed, since it's
// out of scope for what Phase 3D.4 changed.

function createSelfHealMockPrisma(t: TestContext, opts: { existingClientProfile?: any } = {}) {
  let clientProfileState: any = opts.existingClientProfile ?? null;
  const userFixture = {
    firstName: 'Amr', lastName: 'Okasha', avatarUrl: 'https://example.com/a.png', email: 'amr@example.com',
    phoneNumber: '0500000000', idNumber: null, idExpiryDate: null, ibanNumber: null, bankName: null,
    accountHolderName: null, idDocumentUrl: null
  };

  const clientCreateSpy = t.mock.fn((args: any) => { clientProfileState = { id: 'client-1', ...args.data }; return clientProfileState; });

  const tx = {
    clientProfile: { findUnique: async () => clientProfileState, create: clientCreateSpy }
  };

  const prismaMock: any = {
    clientProfile: { findUnique: async () => clientProfileState },
    user: { findUnique: async () => userFixture },
    $transaction: async (fn: any) => fn(tx)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return { clientCreateSpy, getClientProfileState: () => clientProfileState };
}

async function loadServiceForSelfHeal(t: TestContext, opts?: Parameters<typeof createSelfHealMockPrisma>[1]) {
  const mocks = createSelfHealMockPrisma(t, opts);
  const moduleUrl = `./client-requests.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { clientRequestsService } = await import(moduleUrl);
  return { clientRequestsService, ...mocks };
}

test('createRequest: a missing ClientProfile is routed through the canonical initializer — seeds display, computes real completion, preserves isProfileComplete=true', async (t) => {
  const { clientRequestsService, clientCreateSpy } = await loadServiceForSelfHeal(t);

  await clientRequestsService.createRequest('user-1', {} as any).catch(() => {});

  assert.equal(clientCreateSpy.mock.callCount(), 1);
  const data = clientCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.lastName, 'Okasha');
  assert.equal(data.avatarUrl, 'https://example.com/a.png');
  assert.equal(data.isProfileComplete, true);
  assert.equal(typeof data.completionPercentage, 'number');
  assert.equal(data.completionPercentage > 0, true);
});

test('createRequest: repeat call with an existing ClientProfile never re-initializes or overwrites it', async (t) => {
  const { clientRequestsService, clientCreateSpy } = await loadServiceForSelfHeal(t, {
    existingClientProfile: { id: 'client-1', firstName: 'Independent', completionPercentage: 88, isProfileComplete: false }
  });

  await clientRequestsService.createRequest('user-1', {} as any).catch(() => {});

  assert.equal(clientCreateSpy.mock.callCount(), 0);
});

// ── F7: generateAiSuggest — Batch A migration to the shared Gemini
// foundation. `prisma.clientRequest.findMany` and `geminiClient` are both
// mocked; no real DB/network call ever happens.

function validSuggestionFixture(overrides: Partial<any> = {}) {
  return {
    suggestedTitle: 'عنوان مقترح احترافي',
    suggestedDescription: 'وصف تقني شامل حقيقي من Gemini',
    suggestedSubSpecialties: ['تطوير ويب', 'واجهات برمجية APIs'],
    recommendedMinBudget: 4000,
    recommendedMaxBudget: 9000,
    suggestedDurationDays: 21,
    complexityRating: 'MEDIUM',
    personalizedNote: 'ملاحظة شخصية حقيقية',
    aiMatchScoreEstimate: 91,
    ...overrides
  };
}

async function loadServiceForAiSuggest(t: TestContext, opts: {
  pastRequests?: any[];
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const prismaMock: any = {
    clientRequest: {
      findMany: async () => (opts.pastRequests ?? [])
    }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./client-requests.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { clientRequestsService } = await import(moduleUrl);
  return clientRequestsService;
}

test('generateAiSuggest: a real validated Gemini success is returned as-is', async (t) => {
  const suggestion = validSuggestionFixture();
  const service = await loadServiceForAiSuggest(t, {
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(suggestion), true, 'the real validator must accept a well-formed suggestion');
      return { data: suggestion, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
    }
  });

  const result = await service.generateAiSuggest('client-1', { title: 'مسودة', description: 'وصف مبدئي' } as any);

  assert.deepEqual(result, suggestion);
});

test('generateAiSuggest: Gemini unavailable throws an AppError(503) with no aiMatchScoreEstimate:94 fallback', async (t) => {
  const service = await loadServiceForAiSuggest(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  await assert.rejects(
    () => service.generateAiSuggest('client-1', {} as any),
    (err: any) => {
      assert.equal(err.statusCode, 503);
      // The rejection carries no suggestion payload at all — no
      // aiMatchScoreEstimate, no fabricated title/description of any kind.
      assert.equal('aiMatchScoreEstimate' in err, false);
      assert.equal('suggestedTitle' in err, false);
      return true;
    }
  );
});

test('generateAiSuggest: a malformed Gemini response (including a fabricated-looking aiMatchScoreEstimate: 94) is rejected by the real validator instead of being trusted', async (t) => {
  // 94 alone isn't invalid, but pairing it with clearly malformed fields
  // (empty title, empty sub-specialties) proves the validator inspects the
  // whole shape rather than special-casing any one field.
  const malformed = { suggestedTitle: '', suggestedSubSpecialties: [], aiMatchScoreEstimate: 94 };
  const service = await loadServiceForAiSuggest(t, {
    generateStructured: async (_prompt, options) => {
      if (!options.validate(malformed)) {
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
      }
      return { data: malformed, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  await assert.rejects(
    () => service.generateAiSuggest('client-1', {} as any),
    (err: any) => { assert.equal(err.statusCode, 503); return true; }
  );
});
