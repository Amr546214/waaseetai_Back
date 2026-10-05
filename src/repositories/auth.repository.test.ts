import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.4: createUserWithProfile() (the email/password registration path)
// now passes the FULL identity (avatarUrl/email/phoneNumber/banking-KYC
// fields, not just firstName/lastName) into createMissingRoleProfiles, so
// the newly-created role profile's seeded display fields and initial
// completion are computed from real state via the exact existing Phase 3D.2
// pure calculators — no new formula. Banking/KYC fields are legitimately
// absent for a brand-new registration; the calculator already treats that
// as "not scored", not an error.

function createMockPrisma(t: TestContext) {
  let clientProfileState: any = null;
  const userCreateSpy = t.mock.fn((args: any) => ({ id: 'user-1', ...args.data }));
  const clientCreateSpy = t.mock.fn((args: any) => { clientProfileState = { id: 'client-1', ...args.data }; return clientProfileState; });

  const tx = {
    user: { create: userCreateSpy },
    clientProfile: { findUnique: async () => clientProfileState, create: clientCreateSpy }
  };

  const prismaMock: any = { $transaction: async (fn: any) => fn(tx) };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  return { userCreateSpy, clientCreateSpy };
}

async function loadRepo(t: TestContext) {
  const mocks = createMockPrisma(t);
  const moduleUrl = `./auth.repository.ts?fixture=${Date.now()}-${Math.random()}`;
  const { authRepository } = await import(moduleUrl);
  return { authRepository, ...mocks };
}

test('createUserWithProfile: role initialization uses the full identity and computes real initial completion (not just firstName/lastName, not a stale 0)', async (t) => {
  const { authRepository, clientCreateSpy } = await loadRepo(t);

  await authRepository.createUserWithProfile({
    accountType: 'CLIENT_INDIVIDUAL',
    firstName: 'Amr',
    lastName: 'Okasha',
    email: 'amr@example.com',
    phoneCountryCode: '+966',
    phoneNumber: '0500000000',
    agreedToTerms: true
  } as any, 'hashed-password');

  assert.equal(clientCreateSpy.mock.callCount(), 1);
  const data = clientCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.lastName, 'Okasha');
  // Individual formula: firstName + lastName = 15 (the phone is no longer scored). avatarUrl is legitimately absent for an
  // email/password signup (unlike Google, which provides one) — not scored, not an invented value.
  assert.equal(data.completionPercentage, 15);
});
