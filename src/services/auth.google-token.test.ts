import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Google ID-token verification: an invalid token is a client error (401 + Arabic message), never a 500, never leaks the token
// or the provider's error text into the response or the logs; valid Google login and register are unaffected.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

const SECRET_TOKEN = 'eyJSECRET-TOKEN-VALUE.payload.signature';

function setup(t: TestContext, opts: { verify: 'ok' | 'throw'; user?: any; noUser?: boolean }) {
  const logs: string[] = [];
  const push = (...m: unknown[]) => logs.push(m.map(String).join(' '));
  const created: any[] = [];
  const user = opts.user ?? {
    id: 'user-1', email: 'g@example.com', firstName: 'Ghada', lastName: 'K', status: 'ACTIVE', password: null, googleId: 'g-sub-1',
    accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', roles: ['CLIENT'], phoneOtpEnabled: false
  };
  t.mock.module('../config/logger', { namedExports: { logger: { info: push, warn: push, error: push, debug: push } } });
  t.mock.module('../config/db', { namedExports: { prisma: { affiliateProfile: { findFirst: async () => null }, referral: { create: async () => ({}) } } } });
  t.mock.module('./session.service', { namedExports: { sessionService: { register: async () => ({}) } } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
    findByEmailOrPhone: async () => null,
    findByEmail: async () => (opts.noUser ? null : user),
    createUserWithProfile: async (input: any, _hash: any, google: any) => { created.push({ input, google }); return { id: 'new-user', email: input.email }; },
    createOtp: async () => ({}),
  } } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {
    sendEmailOtp: async () => ({ messageId: 'x', accepted: ['a'], rejected: [] }),
    sendSmsOtp: async () => {}, isSmsAvailable: () => false,
  } } });
  t.mock.module('google-auth-library', { namedExports: { OAuth2Client: class {
    async verifyIdToken(o: any) {
      if (opts.verify === 'throw') throw new Error(`Wrong number of segments in token: ${o.idToken} (provider internals: certs fetch failed at https://www.googleapis.com/oauth2/v1/certs)`);
      return { getPayload: () => ({ sub: 'g-sub-1', email: 'g@example.com', email_verified: true, given_name: 'Ghada', family_name: 'K' }) };
    }
  } } });
  return { logs, created };
}

async function load() {
  const { authService } = await import(`./auth.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { authService };
}

const REGISTER: any = { accountType: 'CLIENT_INDIVIDUAL', firstName: 'Ghada', lastName: 'K', email: 'g@example.com', phoneCountryCode: '+966', phoneNumber: '500000009', agreedToTerms: true };

function assertClientError(e: any, logs: string[]) {
  assert.equal(e.statusCode, 401, 'a client error, not a 500');
  assert.match(e.message, /تعذر التحقق من حساب جوجل/);
  for (const secret of [SECRET_TOKEN, 'SECRET-TOKEN', 'Wrong number of segments', 'googleapis', 'certs']) {
    assert.ok(!e.message.includes(secret), `the response must not contain "${secret}"`);
    assert.ok(logs.every(l => !l.includes(secret)), `the logs must not contain "${secret}"`);
  }
  return true;
}

test('invalid Google token on login: 401 with an Arabic message, no token / provider detail in the response or the logs', async (t) => {
  const { logs } = setup(t, { verify: 'throw' });
  const { authService } = await load();
  await assert.rejects(() => authService.googleAuth({ idToken: SECRET_TOKEN, intent: 'login' } as any, {}), (e: any) => assertClientError(e, logs));
  assert.ok(logs.some(l => /Google ID token verification failed/.test(l)), 'a generic line is logged');
});

test('invalid Google token on the register intent: same 401, nothing leaked', async (t) => {
  const { logs } = setup(t, { verify: 'throw' });
  const { authService } = await load();
  await assert.rejects(() => authService.googleAuth({ idToken: SECRET_TOKEN, intent: 'register', accountType: 'CLIENT_INDIVIDUAL' } as any, {}), (e: any) => assertClientError(e, logs));
});

test('invalid Google token on POST /register (googleIdToken): 401, no account is created, nothing leaked', async (t) => {
  const { logs, created } = setup(t, { verify: 'throw' });
  const { authService } = await load();
  await assert.rejects(() => authService.registerUser({ ...REGISTER, googleIdToken: SECRET_TOKEN }), (e: any) => assertClientError(e, logs));
  assert.equal(created.length, 0);
});

test('valid Google login still works: a session is issued', async (t) => {
  const { logs } = setup(t, { verify: 'ok' });
  const { authService } = await load();
  const result: any = await authService.googleAuth({ idToken: SECRET_TOKEN, intent: 'login' } as any, {});
  assert.equal(result.verified, true);
  assert.equal(typeof result.token, 'string');
  assert.equal(result.user.email, 'g@example.com');
  assert.ok(logs.every(l => !l.includes(SECRET_TOKEN)), 'the token is never logged on the happy path either');
});

test('valid Google register-intent still returns the verified profile (no account yet)', async (t) => {
  setup(t, { verify: 'ok', noUser: true });
  const { authService } = await load();
  const result: any = await authService.googleAuth({ idToken: SECRET_TOKEN, intent: 'register', accountType: 'CLIENT_INDIVIDUAL' } as any, {});
  // no account exists yet: the verified identity is returned for the client to finish the form
  assert.equal(result.registrationRequired, true);
  assert.equal(result.googleProfile.email, 'g@example.com');
});

test('valid Google sign-up through POST /register still creates the account with the Google identity', async (t) => {
  const { created } = setup(t, { verify: 'ok' });
  const { authService } = await load();
  const result = await authService.registerUser({ ...REGISTER, googleIdToken: SECRET_TOKEN });
  assert.equal(result.userId, 'new-user');
  assert.equal(created.length, 1);
  assert.equal(created[0].google.sub, 'g-sub-1');
});
