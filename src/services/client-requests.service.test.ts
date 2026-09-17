import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// client-requests.service.ts's constructor eagerly does
// `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` — same established
// pattern as provider-profile.service.test.ts for the same reason.
process.env.OPENAI_API_KEY = 'test-key';

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
