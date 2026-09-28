import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

// Real live-Gemini testing found the prompt/schema instructed Gemini to
// always return "a number between 85 and 98" for aiMatchScoreEstimate,
// regardless of how vague/incomplete the actual draft was — an artificially
// positive-biased score. The validator itself already accepted the full
// honest 0-100 range; only the prompt text was fixed. These tests prove low
// scores are genuinely accepted end-to-end and the biased instruction is
// gone from what actually reaches Gemini.
for (const lowScore of [0, 25, 50]) {
  test(`generateAiSuggest: an honest low aiMatchScoreEstimate (${lowScore}) for a vague/incomplete draft is accepted as-is, never rejected or replaced`, async (t) => {
    const suggestion = validSuggestionFixture({ aiMatchScoreEstimate: lowScore });
    const service = await loadServiceForAiSuggest(t, {
      generateStructured: async (_prompt, options) => {
        assert.equal(options.validate(suggestion), true, `the real validator must accept a low, honest score of ${lowScore}`);
        return { data: suggestion, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
      }
    });
    const result = await service.generateAiSuggest('client-1', { title: 'x' } as any);
    assert.equal(result.aiMatchScoreEstimate, lowScore);
  });
}

for (const highScore of [91, 100]) {
  test(`generateAiSuggest: a legitimate high aiMatchScoreEstimate (${highScore}) for a complete draft is still accepted`, async (t) => {
    const suggestion = validSuggestionFixture({ aiMatchScoreEstimate: highScore });
    const service = await loadServiceForAiSuggest(t, {
      generateStructured: async (_prompt, options) => {
        assert.equal(options.validate(suggestion), true);
        return { data: suggestion, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
      }
    });
    const result = await service.generateAiSuggest('client-1', { title: 'x' } as any);
    assert.equal(result.aiMatchScoreEstimate, highScore);
  });
}

test('generateAiSuggest: the prompt sent to Gemini no longer instructs a narrow 85-98 biased range', async (t) => {
  const suggestion = validSuggestionFixture();
  let capturedPrompt = '';
  const service = await loadServiceForAiSuggest(t, {
    generateStructured: async (prompt, options) => {
      capturedPrompt = prompt;
      return { data: suggestion, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  await service.generateAiSuggest('client-1', { title: 'x' } as any);
  assert.doesNotMatch(capturedPrompt, /85 and 98|85-98/);
  assert.match(capturedPrompt, /0 to 100/);
});

test('generateAiSuggest: the response schema description no longer biases toward a high score', async (t) => {
  const service = await loadServiceForAiSuggest(t, {
    generateStructured: async (_prompt, options) => {
      const description = options.responseSchema?.properties?.aiMatchScoreEstimate?.description ?? '';
      assert.doesNotMatch(description, /85 and 98|85-98/);
      assert.match(description, /0 to 100/);
      return { data: validSuggestionFixture(), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  await service.generateAiSuggest('client-1', { title: 'x' } as any);
});

for (const badScore of [-1, 101, 150]) {
  test(`generateAiSuggest: an out-of-range score (${badScore}) is still rejected by the real validator`, async (t) => {
    const malformed = validSuggestionFixture({ aiMatchScoreEstimate: badScore });
    const service = await loadServiceForAiSuggest(t, {
      generateStructured: async (_prompt, options) => {
        if (!options.validate(malformed)) throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
        return { data: malformed };
      }
    });
    await assert.rejects(() => service.generateAiSuggest('client-1', {} as any), (err: any) => err.statusCode === 503);
  });
}

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

// ── USD-canonical wallet transition: signContract()'s escrow-funding
// arithmetic must be BYTE-FOR-BYTE unchanged (only the currency label
// changed, no conversion). signContract() itself is a large, deeply-nested
// transactional function (OTP verification, signature hashing, contract/
// proposal lookups, emails) — mirroring the codebase's own established
// static-source-check approach (e.g. admin-affiliate-requests.routes.test.ts)
// rather than a fragile full mock, since the arithmetic and the currency
// literal are both directly verifiable in source without booting the flow.

const clientRequestsSource = fs.readFileSync(path.join(__dirname, 'client-requests.service.ts'), 'utf8');

test('signContract: the escrow fee percentages (VAT 7%, insurance 1%, platform 5%) are unchanged by the USD transition', () => {
  assert.match(clientRequestsSource, /const ESCROW_FEE_VAT = 0\.07;/);
  assert.match(clientRequestsSource, /const ESCROW_FEE_INSURANCE = 0\.01;/);
  assert.match(clientRequestsSource, /const ESCROW_FEE_PLATFORM = 0\.05;/);
});

test('signContract: the escrow amount formula (price * (1 + VAT + insurance + platform)) is unchanged', () => {
  assert.match(
    clientRequestsSource,
    /const rawEscrowAmount = contractBeforePayment\.price \* \(1 \+ ESCROW_FEE_VAT \+ ESCROW_FEE_INSURANCE \+ ESCROW_FEE_PLATFORM\);/
  );
});

test('signContract: the escrow-lock WalletTransaction it creates is explicitly USD (not the schema\'s historical SAR default)', () => {
  const escrowLockBlock = clientRequestsSource.slice(
    clientRequestsSource.indexOf("type: 'ESCROW_LOCK'"),
    clientRequestsSource.indexOf("type: 'ESCROW_LOCK'") + 200
  );
  assert.match(escrowLockBlock, /currency: 'USD'/);
});
