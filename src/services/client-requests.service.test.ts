import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WaseetAiError, WaseetAiErrorCode } from './ai/waseet-ai/waseet-ai.errors';

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

// ── generateAiSuggest — WaseetAI request-draft only (no Gemini). The
// waseetAiClient module is mocked; no DB/network call ever happens.

function draftFixture(overrides: Partial<any> = {}) {
  return {
    suggestedTitle: 'عنوان مقترح احترافي',
    suggestedDescription: 'وصف تقني شامل',
    suggestedSubSpecialties: ['تطوير ويب', 'واجهات برمجية APIs'],
    recommendedMinBudget: 4000,
    recommendedMaxBudget: 9000,
    suggestedDurationDays: 21,
    complexityRating: 'MEDIUM',
    personalizedNote: 'ملاحظة',
    aiMatchScoreEstimate: 61,
    ...overrides
  };
}

async function loadServiceForAiSuggest(t: TestContext, opts: { requestDraft?: (body: any) => Promise<any> }) {
  const calls: any[] = [];
  const clientMock = {
    requestDraft: async (body: any) => {
      calls.push(body);
      return (opts.requestDraft ?? (async () => draftFixture()))(body);
    }
  };
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('./ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: clientMock } });
  const { clientRequestsService } = await import(`./client-requests.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return Object.assign(clientRequestsService, { calls });
}

test('generateAiSuggest: maps the WaseetAI response onto the app shape and sends verified request fields including subSpecialties', async (t) => {
  const service = await loadServiceForAiSuggest(t, {});
  const result = await service.generateAiSuggest('client-1', {
    title: ' مسودة ', description: ' وصف مبدئي ', specialtyName: 'تطوير الويب', specialtyId: 'sp-1', subSpecialties: ['React']
  } as any);

  assert.deepEqual(service.calls, [{ title: 'مسودة', description: 'وصف مبدئي', specialtyName: 'تطوير الويب', subSpecialties: ['React'], currency: 'USD' }]);
  assert.deepEqual(result, draftFixture());
});

test('generateAiSuggest: an empty draft sends fallback specialty context so WaseetAI can generate a full draft', async (t) => {
  const service = await loadServiceForAiSuggest(t, {});
  await service.generateAiSuggest('client-1', {} as any);
  assert.deepEqual(service.calls[0], { title: 'مشروع في مجال عام', description: 'مطلوب تنفيذ مشروع في مجال عام في تخصص عام.', specialtyName: 'عام', currency: 'USD' });
});

for (const score of [0, 25, 100]) {
  test(`generateAiSuggest: the service's own aiMatchScoreEstimate (${score}) is passed through unchanged`, async (t) => {
    const service = await loadServiceForAiSuggest(t, { requestDraft: async () => draftFixture({ aiMatchScoreEstimate: score }) });
    const result = await service.generateAiSuggest('client-1', { title: 'x' } as any);
    assert.equal(result.aiMatchScoreEstimate, score);
  });
}

test('generateAiSuggest: unusable fields become null, never invented', async (t) => {
  const service = await loadServiceForAiSuggest(t, {
    requestDraft: async () => draftFixture({
      suggestedSubSpecialties: [], recommendedMinBudget: 9000, recommendedMaxBudget: 4000, suggestedDurationDays: 0,
      complexityRating: '', personalizedNote: '  ', aiMatchScoreEstimate: 150
    })
  });
  const result = await service.generateAiSuggest('client-1', { title: 'x' } as any);
  assert.equal(result.suggestedTitle, 'عنوان مقترح احترافي');
  assert.equal(result.suggestedSubSpecialties, null);
  assert.equal(result.recommendedMinBudget, null);
  assert.equal(result.recommendedMaxBudget, null);
  assert.equal(result.suggestedDurationDays, null);
  assert.equal(result.complexityRating, null);
  assert.equal(result.personalizedNote, null);
  assert.equal(result.aiMatchScoreEstimate, null);
});

for (const bad of [-1, 100.5, 101, NaN, Infinity, '94' as any, null as any]) {
  test(`generateAiSuggest: an out-of-range / non-numeric score (${String(bad)}) becomes null while the rest of the suggestion is kept`, async (t) => {
    const service = await loadServiceForAiSuggest(t, { requestDraft: async () => draftFixture({ aiMatchScoreEstimate: bad }) });
    const result = await service.generateAiSuggest('client-1', { title: 'x' } as any);
    assert.equal(result.aiMatchScoreEstimate, null, 'never replaced by an invented placeholder such as 94');
    assert.equal(result.suggestedTitle, 'عنوان مقترح احترافي');
  });
}

test('generateAiSuggest: a missing score is null, never defaulted', async (t) => {
  const service = await loadServiceForAiSuggest(t, { requestDraft: async () => { const d: any = draftFixture(); delete d.aiMatchScoreEstimate; return d; } });
  const result = await service.generateAiSuggest('client-1', { title: 'x' } as any);
  assert.equal(result.aiMatchScoreEstimate, null);
});

test('generateAiSuggest: a response with neither title nor description is a 503, not a suggestion', async (t) => {
  const service = await loadServiceForAiSuggest(t, { requestDraft: async () => draftFixture({ suggestedTitle: '', suggestedDescription: '' }) });
  await assert.rejects(() => service.generateAiSuggest('client-1', {} as any), (err: any) => err.statusCode === 503);
});

test('generateAiSuggest: upstream failure throws an honest AppError(503) without leaking upstream text or a fabricated suggestion', async (t) => {
  const SECRET = 'UPSTREAM-SECRET-DETAIL';
  const service = await loadServiceForAiSuggest(t, {
    requestDraft: async () => { throw new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, SECRET, { status: 502 }); }
  });
  await assert.rejects(
    () => service.generateAiSuggest('client-1', {} as any),
    (err: any) => {
      assert.equal(err.statusCode, 503);
      assert.ok(!String(err.message).includes(SECRET));
      assert.equal('aiMatchScoreEstimate' in err, false);
      return true;
    }
  );
});

test('client-requests.service.ts (WaseetAI-linked) has no internal LlmClient dependency', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client-requests.service.ts'), 'utf8');
  assert.doesNotMatch(src, /gemini\.client|geminiClient|generateStructured|generateStream/);
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

test('depositEscrow (fee policy v2): the old 13% escrow-lock charge (VAT 7% + platform 5% + insurance 1%) is gone — no fee constant and no fee in the amount', () => {
  assert.doesNotMatch(clientRequestsSource, /ESCROW_FEE_(VAT|PLATFORM|INSURANCE)\s*=/);
  assert.doesNotMatch(clientRequestsSource, /rawEscrowAmount/);
  assert.match(clientRequestsSource, /const txEscrowAmount = Math\.round\(contractBeforePayment\.price \* 100\) \/ 100;/);
});

test('depositEscrow (fee policy v2): the escrow row and the ESCROW_LOCK transaction carry the v2 snapshot and a zero escrow fee', () => {
  assert.match(clientRequestsSource, /const escrowSnapshot = buildEscrowSnapshotFromPolicy\(providerGamification\?\.currentLevelIndex, await feePolicyService\.active\(\)\);/);
  assert.match(clientRequestsSource, /\.\.\.escrowSnapshot/);
  assert.match(clientRequestsSource, /feePolicyVersion: ESCROW_FEE_POLICY_V2, escrowFee: 0, contractPrice: txEscrowAmount/);
});

test('signContract: the escrow-lock WalletTransaction it creates carries the own currency of the contract (never the database default)', () => {
  const escrowLockBlock = clientRequestsSource.slice(
    clientRequestsSource.indexOf("type: 'ESCROW_LOCK'"),
    clientRequestsSource.indexOf("type: 'ESCROW_LOCK'") + 200
  );
  assert.match(escrowLockBlock, /currency: money/); assert.match(clientRequestsSource, /const money = requireCurrency\(contractBeforePayment\.currency/); // the contract's own currency, never the database default
});
