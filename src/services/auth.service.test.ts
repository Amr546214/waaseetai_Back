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

  const findValidOtpSpy = t.mock.fn(async () => ({ id: 'otp-1', code: '123456', attempts: 0, expiresAt: new Date(Date.now() + 60_000) }));
  const updateUserStatusSpy = t.mock.fn(async () => updatedUserFixture);
  const deleteUserOtpsSpy = t.mock.fn(async () => ({ count: 1 }));
  const sessionRegisterSpy = t.mock.fn(async () => ({}));

  t.mock.module('../repositories/auth.repository', {
    namedExports: {
      authRepository: {
        findLatestActivationOtp: findValidOtpSpy,
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

// ---------------------------------------------------------------------------
// googleAuth: LOGIN vs REGISTER intent must never be confused, and neither
// path may ever silently create a duplicate account or skip the mandatory
// registration-completion step. Previously zero test coverage existed for
// this method at all.
// ---------------------------------------------------------------------------

const GOOGLE_PAYLOAD_DEFAULT = {
  sub: 'google-sub-1',
  email: 'amr@example.com',
  email_verified: true,
  given_name: 'Amr',
  family_name: 'Okasha'
};

function createGoogleAuthMockPrisma(t: TestContext, opts: {
  existingUser?: any | null;
  googlePayload?: any;
} = {}) {
  const googlePayload = opts.googlePayload ?? GOOGLE_PAYLOAD_DEFAULT;
  const findByEmailSpy = t.mock.fn(async () => opts.existingUser ?? null);
  const userUpdateSpy = t.mock.fn(async (_args: any) => ({
    ...opts.existingUser,
    googleId: googlePayload.sub,
    authProvider: 'google'
  }));
  const sessionRegisterSpy = t.mock.fn(async () => ({}));

  // google-auth-library's OAuth2Client is instantiated as a module-level
  // constant in auth.service.ts (`new OAuth2Client(...)`), so the whole
  // package is mocked here rather than a specific export of this file.
  t.mock.module('google-auth-library', {
    namedExports: {
      OAuth2Client: class {
        async verifyIdToken(_opts: any) {
          return { getPayload: () => googlePayload };
        }
      }
    }
  });
  t.mock.module('../repositories/auth.repository', {
    namedExports: { authRepository: { findByEmail: findByEmailSpy } }
  });
  t.mock.module('../config/db', {
    namedExports: { prisma: { user: { update: userUpdateSpy } } }
  });
  t.mock.module('./session.service', {
    namedExports: { sessionService: { register: sessionRegisterSpy } }
  });

  return { findByEmailSpy, userUpdateSpy, sessionRegisterSpy };
}

async function loadAuthServiceForGoogleAuth(t: TestContext, opts?: Parameters<typeof createGoogleAuthMockPrisma>[1]) {
  const mocks = createGoogleAuthMockPrisma(t, opts);
  const moduleUrl = `./auth.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { authService } = await import(moduleUrl);
  return { authService, ...mocks };
}

function existingUserFixture(overrides: any = {}) {
  return {
    id: 'user-1',
    email: 'amr@example.com',
    accountType: 'PROVIDER_INDIVIDUAL',
    activeRole: 'PROVIDER',
    roles: ['PROVIDER'],
    status: 'ACTIVE',
    googleId: null,
    firstName: 'Amr',
    lastName: 'Okasha',
    phoneNumber: '0500000000',
    phoneCountryCode: '+966',
    phoneOtpEnabled: false,
    clientProfile: null,
    providerProfile: null,
    affiliateProfile: null,
    ...overrides
  };
}

test('googleAuth (intent: login, existing account): authenticates directly — no registrationRequired, no profile-completion signal, real token issued', async (t) => {
  const { authService, sessionRegisterSpy } = await loadAuthServiceForGoogleAuth(t, {
    existingUser: existingUserFixture()
  });

  const result = await authService.googleAuth({ idToken: 'valid-token', intent: 'login' });

  assert.equal(result.verified, true);
  assert.equal(typeof result.token, 'string');
  assert.equal(result.user.id, 'user-1');
  assert.equal(result.user.accountType, 'PROVIDER_INDIVIDUAL');
  assert.equal('registrationRequired' in result, false);
  assert.equal(sessionRegisterSpy.mock.callCount(), 1);
});

test('googleAuth (intent: login, NO existing account): rejects with 404 — never auto-creates an account', async (t) => {
  const { authService, userUpdateSpy, sessionRegisterSpy } = await loadAuthServiceForGoogleAuth(t, {
    existingUser: null
  });

  await assert.rejects(
    () => authService.googleAuth({ idToken: 'valid-token', intent: 'login' }),
    (err: any) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  assert.equal(userUpdateSpy.mock.callCount(), 0);
  assert.equal(sessionRegisterSpy.mock.callCount(), 0);
});

test('googleAuth (intent: register, brand-new identity): returns registrationRequired + googleProfile only — no user created, no token issued', async (t) => {
  const { authService, userUpdateSpy, sessionRegisterSpy } = await loadAuthServiceForGoogleAuth(t, {
    existingUser: null
  });

  const result = await authService.googleAuth({ idToken: 'valid-token', intent: 'register', accountType: 'PROVIDER_INDIVIDUAL' });

  assert.equal(result.verified, false);
  assert.equal(result.registrationRequired, true);
  assert.deepEqual(result.googleProfile, { email: 'amr@example.com', firstName: 'Amr', lastName: 'Okasha' });
  assert.equal('token' in result, false);
  assert.equal('user' in result, false);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
  assert.equal(sessionRegisterSpy.mock.callCount(), 0);
});

test('googleAuth (intent: register, account already exists): rejects with 409 — never logs in, never creates a duplicate', async (t) => {
  const { authService, userUpdateSpy, sessionRegisterSpy } = await loadAuthServiceForGoogleAuth(t, {
    existingUser: existingUserFixture()
  });

  await assert.rejects(
    () => authService.googleAuth({ idToken: 'valid-token', intent: 'register', accountType: 'PROVIDER_INDIVIDUAL' }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
  assert.equal(userUpdateSpy.mock.callCount(), 0);
  assert.equal(sessionRegisterSpy.mock.callCount(), 0);
});

test('googleAuth: an explicit intent always wins over the legacy accountType-presence heuristic', async (t) => {
  // A caller that (incorrectly, or for backward compatibility) sends both
  // intent AND accountType must still be resolved by intent alone — this
  // guards the exact requirement that intent must never be re-derived from
  // other fields once it's explicitly provided.
  const { authService } = await loadAuthServiceForGoogleAuth(t, {
    existingUser: existingUserFixture()
  });

  const result = await authService.googleAuth({ idToken: 'valid-token', intent: 'login', accountType: 'PROVIDER_INDIVIDUAL' } as any);

  assert.equal(result.verified, true);
  assert.equal('registrationRequired' in result, false);
});

// ---------------------------------------------------------------------------
// registerUser: referral attribution (P-LG-012 Marketing Affiliate system).
// registerUser() is the ONLY real account-creation call site in this
// codebase — including for a Google sign-up, which arrives here with
// googleIdToken set (see registerUser()'s own googleIdentity handling)
// rather than through a separate creation path in googleAuth() above (that
// method's 'register' intent never creates a user; it only verifies
// identity and returns googleProfile for the client to then call
// POST /register). All attribution tests below therefore exercise the one
// real shared helper, resolveReferralAttribution(), for BOTH the plain
// email/password path and the Google sign-up path.
// ---------------------------------------------------------------------------

function createRegisterMockPrisma(t: TestContext, opts: {
  affiliates?: { id: string; userId: string; referralSlug: string; status?: string }[];
  createUserId?: string;
} = {}) {
  const affiliates = opts.affiliates ?? [];
  const referrals: any[] = [];

  // Mirrors resolveReferralAttribution()'s own query shape:
  // prisma.affiliateProfile.findFirst({ where: { OR: [{ referralSlug }, { id }] }, select: { id, userId } }).
  const affiliateFindFirstSpy = t.mock.fn(async (args: any) => {
    const [bySlug, byId] = args.where.OR;
    const match = affiliates.find(a => a.referralSlug === bySlug.referralSlug || a.id === byId.id);
    // mirrors the `user: { status }` relation filter: only an affiliate whose user is in that status is returned
    if (match && args.where.user?.status && (match.status ?? 'ACTIVE') !== args.where.user.status) return null;
    return match ? { id: match.id, userId: match.userId } : null;
  });
  // Reproduces Referral.referredUserId's real @unique DB constraint: a
  // second create() for the same referredUserId throws P2002, exactly like
  // a real duplicate/retried attribution attempt would.
  const referralCreateSpy = t.mock.fn(async (args: any) => {
    if (referrals.some(r => r.referredUserId === args.data.referredUserId)) {
      const err: any = new Error('Unique constraint failed on the fields: (`referredUserId`)');
      err.code = 'P2002';
      throw err;
    }
    const row = { id: `referral-${referrals.length + 1}`, ...args.data };
    referrals.push(row);
    return row;
  });

  const createUserId = opts.createUserId ?? 'user-1';
  const findByEmailOrPhoneSpy = t.mock.fn(async () => null);
  const createUserWithProfileSpy = t.mock.fn(async () => ({ id: createUserId, email: 'new@example.com' }));
  const createOtpSpy = t.mock.fn(async () => ({}));
  const sendEmailOtpSpy = t.mock.fn(async () => {});

  t.mock.module('../repositories/auth.repository', {
    namedExports: {
      authRepository: {
        findByEmailOrPhone: findByEmailOrPhoneSpy,
        createUserWithProfile: createUserWithProfileSpy,
        createOtp: createOtpSpy
      }
    }
  });
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        affiliateProfile: { findFirst: affiliateFindFirstSpy },
        referral: { create: referralCreateSpy }
      }
    }
  });
  t.mock.module('./notification.service', {
    namedExports: { notificationService: { sendEmailOtp: sendEmailOtpSpy } }
  });

  return { affiliateFindFirstSpy, referralCreateSpy, createUserWithProfileSpy, getReferrals: () => referrals };
}

async function loadAuthServiceForRegister(t: TestContext, opts?: Parameters<typeof createRegisterMockPrisma>[1]) {
  const mocks = createRegisterMockPrisma(t, opts);
  const moduleUrl = `./auth.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { authService } = await import(moduleUrl);
  return { authService, ...mocks };
}

const REGISTER_BASE_INPUT: any = {
  accountType: 'CLIENT_INDIVIDUAL',
  firstName: 'Test',
  lastName: 'User',
  email: 'new@example.com',
  phoneCountryCode: '+966',
  phoneNumber: '500000001',
  password: 'Password1',
  agreedToTerms: true
};

test('registerUser: signup through a referral link (waseet_ref_code cookie) attributes the resolved affiliate', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-1', userId: 'affiliate-user-1', referralSlug: 'khalid2026' }]
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT }, { refCookieSlug: 'khalid2026' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  const data = referralCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.affiliateId, 'affiliate-1');
  assert.equal(data.referredUserId, 'user-1');
  assert.equal(data.status, 'PENDING');
});

test('registerUser: a manually-typed valid affiliateIdentifier (referralSlug) attributes the resolved affiliate', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-2', userId: 'affiliate-user-2', referralSlug: 'sara-promo' }]
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'sara-promo' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-2');
});

test('registerUser: a search-autocomplete-selected bare affiliate id also resolves (fallback identifier type)', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-3', userId: 'affiliate-user-3', referralSlug: 'lina-ads' }]
  });

  // GET /api/affiliates/search returns { id, referralSlug, displayName } —
  // a caller that submits the raw `id` field instead of `referralSlug` must
  // still resolve correctly.
  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'affiliate-3' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-3');
});

test('registerUser: an invalid/unknown affiliateIdentifier never blocks registration — attribution is silently skipped', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, { affiliates: [] });

  const result = await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'does-not-exist' });

  assert.equal(typeof result.userId, 'string');
  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

test('registerUser: no cookie and no affiliateIdentifier — registration succeeds with zero attribution reads/writes', async (t) => {
  const { authService, affiliateFindFirstSpy, referralCreateSpy } = await loadAuthServiceForRegister(t);

  const result = await authService.registerUser({ ...REGISTER_BASE_INPUT });

  assert.equal(typeof result.userId, 'string');
  assert.equal(affiliateFindFirstSpy.mock.callCount(), 0);
  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

test('registerUser: self-referral is blocked (defense-in-depth) — a resolved affiliate.userId matching the new user id skips attribution', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-self', userId: 'user-1', referralSlug: 'self-code' }],
    createUserId: 'user-1'
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'self-code' });

  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

test('registerUser: duplicate attribution (a retried call resulting in the same user id) is a safe no-op, never a crash', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-1', userId: 'affiliate-user-1', referralSlug: 'khalid2026' }],
    createUserId: 'user-1'
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'khalid2026' });
  // A second, retried attempt that resolves to the SAME user id (e.g. a
  // network retry) must not throw — Referral.referredUserId's own @unique
  // constraint (reproduced by the mock's P2002 simulation) is what actually
  // enforces "already attributed" at the DB level; resolveReferralAttribution()
  // must catch exactly that and treat it as a no-op.
  const result = await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'khalid2026' });

  assert.equal(typeof result.userId, 'string');
  assert.equal(referralCreateSpy.mock.callCount(), 2); // both attempts tried; the second was caught safely
});

test('registerUser: an already-attributed user\'s attribution can never be silently replaced by a later, different affiliateIdentifier', async (t) => {
  const { authService, getReferrals } = await loadAuthServiceForRegister(t, {
    affiliates: [
      { id: 'affiliate-1', userId: 'affiliate-user-1', referralSlug: 'first-code' },
      { id: 'affiliate-2', userId: 'affiliate-user-2', referralSlug: 'second-code' }
    ],
    createUserId: 'user-1'
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'first-code' });
  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'second-code' });

  assert.equal(getReferrals().length, 1);
  assert.equal(getReferrals()[0].affiliateId, 'affiliate-1'); // first attribution wins, never overwritten
});

test('registerUser: precedence (First-Touch fix) — a valid waseet_ref_code cookie wins over a different, also-valid explicit affiliateIdentifier', async (t) => {
  const { authService, referralCreateSpy, affiliateFindFirstSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [
      { id: 'affiliate-cookie', userId: 'affiliate-user-cookie', referralSlug: 'cookie-code' },
      { id: 'affiliate-explicit', userId: 'affiliate-user-explicit', referralSlug: 'explicit-code' }
    ]
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'explicit-code' }, { refCookieSlug: 'cookie-code' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-cookie');
  // The cookie resolves unconditionally — affiliateIdentifier must not even
  // be looked up once the cookie has already resolved to a valid affiliate.
  assert.equal(affiliateFindFirstSpy.mock.callCount(), 1);
});

test('registerUser: an invalid/stale waseet_ref_code cookie with NO explicit identifier — no attribution created, registration still succeeds', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, { affiliates: [] });

  const result = await authService.registerUser({ ...REGISTER_BASE_INPUT }, { refCookieSlug: 'stale-cookie' });

  assert.equal(typeof result.userId, 'string');
  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

test('registerUser: an invalid/stale cookie does NOT permanently block a valid explicit affiliateIdentifier — falls through to the explicit fallback', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-explicit', userId: 'affiliate-user-explicit', referralSlug: 'explicit-code' }]
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'explicit-code' }, { refCookieSlug: 'stale-cookie' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-explicit');
});

test('registerUser: an empty/whitespace-only affiliateIdentifier is treated as "not provided" and falls back to the cookie', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-cookie', userId: 'affiliate-user-cookie', referralSlug: 'cookie-code' }]
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: '   ' }, { refCookieSlug: 'cookie-code' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-cookie');
});

test('registerUser: self-referral guard in the COOKIE path — a cookie resolving to the registering user\'s own affiliate profile is skipped (falls through, no explicit identifier given)', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-self', userId: 'user-1', referralSlug: 'self-cookie' }],
    createUserId: 'user-1'
  });

  const result = await authService.registerUser({ ...REGISTER_BASE_INPUT }, { refCookieSlug: 'self-cookie' });

  assert.equal(typeof result.userId, 'string');
  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

test('registerUser: self-referral guard in the COOKIE path also falls through to a valid, different explicit affiliateIdentifier', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [
      { id: 'affiliate-self', userId: 'user-1', referralSlug: 'self-cookie' },
      { id: 'affiliate-explicit', userId: 'affiliate-user-explicit', referralSlug: 'explicit-code' }
    ],
    createUserId: 'user-1'
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'explicit-code' }, { refCookieSlug: 'self-cookie' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-explicit');
});

test('registerUser (Google sign-up path — googleIdToken set): uses the SAME resolveReferralAttribution helper and precedence as the email/password path', async (t) => {
  // google-auth-library's OAuth2Client is instantiated as a module-level
  // constant in auth.service.ts — same mocking approach as the googleAuth()
  // tests above.
  t.mock.module('google-auth-library', {
    namedExports: {
      OAuth2Client: class {
        async verifyIdToken(_opts: any) {
          return { getPayload: () => ({ sub: 'google-sub-x', email: 'new@example.com', email_verified: true }) };
        }
      }
    }
  });
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [{ id: 'affiliate-g', userId: 'affiliate-user-g', referralSlug: 'google-code' }]
  });

  await authService.registerUser({
    ...REGISTER_BASE_INPUT,
    password: undefined,
    googleIdToken: 'valid-google-token',
    affiliateIdentifier: 'google-code'
  } as any);

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-g');
});

// ---------------------------------------------------------------------------
// A marketing broker (affiliate) is never referred: cookie, affiliateIdentifier and any other referral source are
// ignored for MARKETING_BROKER (email and Google sign-up); clients and providers keep their attribution.
// ---------------------------------------------------------------------------
const AFFILIATES = [{ id: 'affiliate-1', userId: 'affiliate-user-1', referralSlug: 'khalid2026' }];
const MARKETER_INPUT: any = { ...REGISTER_BASE_INPUT, accountType: 'MARKETING_BROKER' };

function mockGoogleIdentity(t: TestContext) {
  t.mock.module('google-auth-library', {
    namedExports: {
      OAuth2Client: class {
        async verifyIdToken(_opts: any) {
          return { getPayload: () => ({ sub: 'google-sub-m', email: 'new@example.com', email_verified: true }) };
        }
      }
    }
  });
}

test('marketer email register with a referral cookie: no referrer lookup and no referral record', async (t) => {
  const { authService, affiliateFindFirstSpy, referralCreateSpy, getReferrals } = await loadAuthServiceForRegister(t, { affiliates: AFFILIATES });

  const result = await authService.registerUser({ ...MARKETER_INPUT }, { refCookieSlug: 'khalid2026' });

  assert.equal(typeof result.userId, 'string');
  assert.equal(affiliateFindFirstSpy.mock.callCount(), 0);
  assert.equal(referralCreateSpy.mock.callCount(), 0);
  assert.equal(getReferrals().length, 0);
});

test('marketer Google register with a referral cookie: no referrer lookup and no referral record', async (t) => {
  mockGoogleIdentity(t);
  const { authService, affiliateFindFirstSpy, referralCreateSpy } = await loadAuthServiceForRegister(t, { affiliates: AFFILIATES });

  await authService.registerUser({ ...MARKETER_INPUT, password: undefined, googleIdToken: 'valid-google-token' } as any, { refCookieSlug: 'khalid2026' });

  assert.equal(affiliateFindFirstSpy.mock.callCount(), 0);
  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

test('client register with a referral cookie: the referral is created', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, { affiliates: AFFILIATES });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, accountType: 'CLIENT_INDIVIDUAL' }, { refCookieSlug: 'khalid2026' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-1');
});

test('provider register with a referral cookie: the referral is created', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, { affiliates: AFFILIATES });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, accountType: 'PROVIDER_INDIVIDUAL' }, { refCookieSlug: 'khalid2026' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-1');
});

test('client and provider register with an explicit affiliateIdentifier: the referral is created', async (t) => {
  for (const accountType of ['CLIENT_INDIVIDUAL', 'CLIENT_COMPANY', 'PROVIDER_INDIVIDUAL', 'PROVIDER_COMPANY']) {
    await t.test(accountType, async (st) => {
      const { authService, referralCreateSpy } = await loadAuthServiceForRegister(st, { affiliates: AFFILIATES });
      await authService.registerUser({ ...REGISTER_BASE_INPUT, accountType, affiliateIdentifier: 'khalid2026' });
      assert.equal(referralCreateSpy.mock.callCount(), 1, accountType);
    });
  }
});

test('marketer register with an explicit affiliateIdentifier alone: ignored', async (t) => {
  const { authService, affiliateFindFirstSpy, referralCreateSpy } = await loadAuthServiceForRegister(t, { affiliates: AFFILIATES });
  await authService.registerUser({ ...MARKETER_INPUT, affiliateIdentifier: 'khalid2026' });
  assert.equal(affiliateFindFirstSpy.mock.callCount(), 0);
  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

test('marketer register with an explicit affiliateIdentifier together with a cookie: both ignored', async (t) => {
  const { authService, affiliateFindFirstSpy, referralCreateSpy } = await loadAuthServiceForRegister(t, { affiliates: AFFILIATES });
  await authService.registerUser({ ...MARKETER_INPUT, affiliateIdentifier: 'khalid2026' }, { refCookieSlug: 'khalid2026' });
  assert.equal(affiliateFindFirstSpy.mock.callCount(), 0);
  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------
// resolveReferralAttribution only credits an ACTIVE affiliate (cookie or typed identifier alike).
// ---------------------------------------------------------------------------
const ACTIVE_AFFILIATE = { id: 'affiliate-1', userId: 'affiliate-user-1', referralSlug: 'khalid2026' };

test('attribution: the affiliate lookup is restricted to ACTIVE users', async (t) => {
  const { authService, affiliateFindFirstSpy } = await loadAuthServiceForRegister(t, { affiliates: [ACTIVE_AFFILIATE] });

  await authService.registerUser({ ...REGISTER_BASE_INPUT }, { refCookieSlug: 'khalid2026' });

  assert.deepEqual(affiliateFindFirstSpy.mock.calls[0].arguments[0].where.user, { status: 'ACTIVE' });
});

test('attribution: a cookie for a suspended affiliate is ignored — no Referral row', async (t) => {
  for (const status of ['SUSPENDED', 'SUSPENDED_REVIEW', 'PENDING_VERIFICATION']) {
    await t.test(status, async (st) => {
      const { authService, referralCreateSpy } = await loadAuthServiceForRegister(st, { affiliates: [{ ...ACTIVE_AFFILIATE, status }] });
      const result = await authService.registerUser({ ...REGISTER_BASE_INPUT }, { refCookieSlug: 'khalid2026' });
      assert.equal(typeof result.userId, 'string'); // registration still succeeds
      assert.equal(referralCreateSpy.mock.callCount(), 0);
    });
  }
});

test('attribution: a typed affiliateIdentifier of a suspended affiliate is ignored — no Referral row', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, { affiliates: [{ ...ACTIVE_AFFILIATE, status: 'SUSPENDED' }] });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'khalid2026' });

  assert.equal(referralCreateSpy.mock.callCount(), 0);
});

test('attribution: a cookie for an inactive affiliate falls through to a valid ACTIVE typed identifier', async (t) => {
  const { authService, referralCreateSpy } = await loadAuthServiceForRegister(t, {
    affiliates: [
      { id: 'affiliate-sus', userId: 'u-sus', referralSlug: 'sus-code', status: 'SUSPENDED' },
      { id: 'affiliate-ok', userId: 'u-ok', referralSlug: 'ok-code' }
    ]
  });

  await authService.registerUser({ ...REGISTER_BASE_INPUT, affiliateIdentifier: 'ok-code' }, { refCookieSlug: 'sus-code' });

  assert.equal(referralCreateSpy.mock.callCount(), 1);
  assert.equal(referralCreateSpy.mock.calls[0].arguments[0].data.affiliateId, 'affiliate-ok');
});
