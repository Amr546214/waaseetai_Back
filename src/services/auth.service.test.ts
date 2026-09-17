import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// auth.service.ts transitively imports notification.service.ts -> ../socket,
// which constructs `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`
// eagerly at module load — same established pattern as
// provider-profile.service.test.ts, for the same reason.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// Phase 3D.4: verifyOtp()'s MARKETING_BROKER AffiliateProfile fallback used
// to create a bare `{ userId, referralSlug }` row via a manual
// findUnique-then-create. It now routes through the same canonical
// role-state initializer every other role-creation path uses (own existence
// check, seeded display fields, real initial completion) — normally a dead
// branch since registration already creates the row, but preserved as a
// defensive fallback exactly as before. OTP validation/expiry, user-status
// activation, OTP cleanup, JWT/session and response contract are unchanged.

function createVerifyOtpMockPrisma(t: TestContext, opts: {
  accountType?: string;
  existingAffiliate?: any;
} = {}) {
  const updatedUserFixture: any = {
    id: 'user-1',
    accountType: opts.accountType || 'MARKETING_BROKER',
    firstName: 'Amr',
    lastName: 'Okasha',
    avatarUrl: null,
    email: 'amr@example.com',
    phoneNumber: '0500000000',
    idNumber: null, idExpiryDate: null, ibanNumber: null, bankName: null, accountHolderName: null, idDocumentUrl: null,
    activeRole: 'AFFILIATE',
    roles: ['AFFILIATE', 'CLIENT']
  };

  let affiliateState: any = opts.existingAffiliate ?? null;
  const affiliateCreateSpy = t.mock.fn((args: any) => { affiliateState = { id: 'affiliate-1', ...args.data }; return affiliateState; });

  const tx = {
    affiliateProfile: { findUnique: async () => affiliateState, create: affiliateCreateSpy }
  };

  const findValidOtpSpy = t.mock.fn(async () => ({ id: 'otp-1', expiresAt: new Date(Date.now() + 60_000) }));
  const updateUserStatusSpy = t.mock.fn(async () => updatedUserFixture);
  const deleteUserOtpsSpy = t.mock.fn(async () => ({ count: 1 }));
  const sessionRegisterSpy = t.mock.fn(async () => ({}));

  t.mock.module('../repositories/auth.repository', {
    namedExports: {
      authRepository: {
        findValidOtp: findValidOtpSpy,
        updateUserStatus: updateUserStatusSpy,
        deleteUserOtps: deleteUserOtpsSpy
      }
    }
  });
  t.mock.module('../config/db', {
    namedExports: { prisma: { $transaction: async (fn: any) => fn(tx) } }
  });
  t.mock.module('./session.service', {
    namedExports: { sessionService: { register: sessionRegisterSpy } }
  });

  return { affiliateCreateSpy, deleteUserOtpsSpy, sessionRegisterSpy, getAffiliateState: () => affiliateState };
}

async function loadAuthServiceForVerifyOtp(t: TestContext, opts?: Parameters<typeof createVerifyOtpMockPrisma>[1]) {
  const mocks = createVerifyOtpMockPrisma(t, opts);
  const moduleUrl = `./auth.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { authService } = await import(moduleUrl);
  return { authService, ...mocks };
}

test('verifyOtp (MARKETING_BROKER, no existing AffiliateProfile): the fallback routes through the canonical initializer', async (t) => {
  const { authService, affiliateCreateSpy } = await loadAuthServiceForVerifyOtp(t);

  await authService.verifyOtp({ userId: 'user-1', code: '123456' });

  assert.equal(affiliateCreateSpy.mock.callCount(), 1);
  const data = affiliateCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.firstName, 'Amr');
  assert.equal(data.lastName, 'Okasha');
  assert.equal(typeof data.referralSlug, 'string');
  assert.equal(typeof data.completionPercentage, 'number');
});

test('verifyOtp (MARKETING_BROKER, AffiliateProfile already exists): the normally-dead fallback is a true no-op, never overwrites', async (t) => {
  const { authService, affiliateCreateSpy } = await loadAuthServiceForVerifyOtp(t, {
    existingAffiliate: { id: 'affiliate-1', firstName: 'Independent', completionPercentage: 90 }
  });

  await authService.verifyOtp({ userId: 'user-1', code: '123456' });

  assert.equal(affiliateCreateSpy.mock.callCount(), 0);
});

test('verifyOtp (non-broker account): never touches AffiliateProfile at all', async (t) => {
  const { authService, affiliateCreateSpy } = await loadAuthServiceForVerifyOtp(t, { accountType: 'CLIENT_INDIVIDUAL' });

  await authService.verifyOtp({ userId: 'user-1', code: '123456' });

  assert.equal(affiliateCreateSpy.mock.callCount(), 0);
});

test('verifyOtp: OTP cleanup, session registration and response contract are unchanged', async (t) => {
  const { authService, deleteUserOtpsSpy, sessionRegisterSpy } = await loadAuthServiceForVerifyOtp(t, { accountType: 'CLIENT_INDIVIDUAL' });

  const result = await authService.verifyOtp({ userId: 'user-1', code: '123456' });

  assert.equal(deleteUserOtpsSpy.mock.callCount(), 1);
  assert.equal(sessionRegisterSpy.mock.callCount(), 1);
  assert.equal(typeof result.token, 'string');
  assert.equal(result.user.id, 'user-1');
});
