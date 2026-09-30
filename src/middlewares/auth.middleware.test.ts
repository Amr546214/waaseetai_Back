import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { AccountType, UserStatus } from '@prisma/client';
import { authorize } from './auth.middleware';

// P0-2 remediation — provider-profile.routes.ts now gates its PROVIDER-only
// routes with authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY).
// These tests exercise that exact middleware call directly against the
// role/activeRole scenarios the fix is meant to allow or block, independent
// of any specific route wiring (auth.middleware.ts has no test file, and
// authorize() has no DB/Prisma dependency, so this is a pure unit test).

function makeReq(user: Partial<{ accountType: AccountType; activeRole: string; roles: string[] }>) {
  return { user } as any;
}

function run(middleware: ReturnType<typeof authorize>, user: Parameters<typeof makeReq>[0]) {
  let nextArg: any = 'NOT_CALLED';
  const req = makeReq(user);
  const res = {} as any;
  middleware(req, res, (arg?: any) => { nextArg = arg; });
  return nextArg;
}

const requireProvider = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

test('authorize(PROVIDER_*): a CLIENT-only user (accountType + roles + activeRole all CLIENT) is rejected', () => {
  const result = run(requireProvider, { accountType: AccountType.CLIENT_INDIVIDUAL, activeRole: 'CLIENT', roles: ['CLIENT'] });
  assert.notEqual(result, undefined);
  assert.equal(result.statusCode, 403);
});

test('authorize(PROVIDER_*): an AFFILIATE-only user is rejected', () => {
  const result = run(requireProvider, { accountType: AccountType.MARKETING_BROKER, activeRole: 'AFFILIATE', roles: ['AFFILIATE'] });
  assert.notEqual(result, undefined);
  assert.equal(result.statusCode, 403);
});

test('authorize(PROVIDER_*): a user whose accountType is PROVIDER_INDIVIDUAL is allowed (direct match)', () => {
  const result = run(requireProvider, { accountType: AccountType.PROVIDER_INDIVIDUAL, activeRole: 'PROVIDER', roles: ['PROVIDER', 'CLIENT'] });
  assert.equal(result, undefined);
});

test('authorize(PROVIDER_*): a multi-role user with PROVIDER in roles[] is allowed even when activeRole is a different role (existing multi-role semantics preserved)', () => {
  const result = run(requireProvider, { accountType: AccountType.CLIENT_INDIVIDUAL, activeRole: 'CLIENT', roles: ['CLIENT', 'PROVIDER'] });
  assert.equal(result, undefined);
});

test('authorize(PROVIDER_*): a multi-role user whose activeRole is PROVIDER is allowed even though their signup accountType/roles[] are CLIENT-based', () => {
  const result = run(requireProvider, { accountType: AccountType.CLIENT_INDIVIDUAL, activeRole: 'PROVIDER', roles: ['CLIENT'] });
  assert.equal(result, undefined);
});

test('authorize(ADMIN, SUPER_ADMIN): unaffected by this change — a CLIENT/PROVIDER/AFFILIATE user still cannot reach admin-only routes', () => {
  const requireAdmin = authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN);
  const result = run(requireAdmin, { accountType: AccountType.PROVIDER_INDIVIDUAL, activeRole: 'PROVIDER', roles: ['PROVIDER'] });
  assert.notEqual(result, undefined);
  assert.equal(result.statusCode, 403);
});

test('authorize: an unauthenticated request (no req.user) is rejected with 401', () => {
  let nextArg: any;
  requireProvider({ user: undefined } as any, {} as any, (arg?: any) => { nextArg = arg; });
  assert.notEqual(nextArg, undefined);
  assert.equal(nextArg.statusCode, 401);
});

// Batch A / F7 security fix: client-requests.routes.ts's POST /ai-suggest now
// gates on authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL)
// (previously it had no role restriction at all — any authenticated user,
// including providers, could call it). These tests exercise that exact
// middleware call, mirroring the PROVIDER_* coverage above.

const requireClient = authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL);

test('authorize(CLIENT_*): a PROVIDER-only user (accountType + roles + activeRole all PROVIDER) is rejected', () => {
  const result = run(requireClient, { accountType: AccountType.PROVIDER_INDIVIDUAL, activeRole: 'PROVIDER', roles: ['PROVIDER'] });
  assert.notEqual(result, undefined);
  assert.equal(result.statusCode, 403);
});

test('authorize(CLIENT_*): a user whose accountType is CLIENT_INDIVIDUAL is allowed (direct match)', () => {
  const result = run(requireClient, { accountType: AccountType.CLIENT_INDIVIDUAL, activeRole: 'CLIENT', roles: ['CLIENT'] });
  assert.equal(result, undefined);
});

test('authorize(CLIENT_*): a user whose accountType is CLIENT_COMPANY is allowed (direct match)', () => {
  const result = run(requireClient, { accountType: AccountType.CLIENT_COMPANY, activeRole: 'CLIENT', roles: ['CLIENT'] });
  assert.equal(result, undefined);
});

test('authorize(CLIENT_*): a multi-role user whose activeRole is CLIENT is allowed even though their signup accountType/roles[] are PROVIDER-based', () => {
  const result = run(requireClient, { accountType: AccountType.PROVIDER_INDIVIDUAL, activeRole: 'CLIENT', roles: ['PROVIDER'] });
  assert.equal(result, undefined);
});

// --- Batch 4 security review: optionalAuthenticate ---------------------
//
// optionalAuthenticate is applied ONLY to the two public marketplace
// listing/detail routes, which never carried authenticate/requireActiveUser
// at all — every credential state below already resulted in an identical
// public response (no req.user) before this middleware existed. These
// tests prove it never rejects the request in any case, while still
// correctly distinguishing "no identity attached" from "a real operational
// error must not vanish silently" (see the logger.error assertions below).

const TEST_SECRET = 'batch4-optional-auth-test-secret';

async function loadOptionalAuthenticate(t: TestContext, opts: {
  findUniqueImpl?: (args: any) => Promise<any>;
  sessionImpl?: (...args: any[]) => Promise<any>;
} = {}) {
  const loggerErrorCalls: any[] = [];
  const findUnique = opts.findUniqueImpl ?? (async () => ({
    id: 'user-1', email: 'u@example.com', accountType: AccountType.CLIENT_INDIVIDUAL,
    status: UserStatus.ACTIVE, activeRole: null, roles: [],
  }));
  const validateOrRegister = opts.sessionImpl ?? (async () => ({ id: 'session-1' }));

  t.mock.module('../config/db', { namedExports: { prisma: { user: { findUnique } } } });
  t.mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister } } });
  t.mock.module('../config/logger', { namedExports: { logger: { error: (...args: any[]) => loggerErrorCalls.push(args), info: () => {}, warn: () => {} } } });

  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = TEST_SECRET;
  t.after(() => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; });

  const mod = await import(`./auth.middleware.ts?test=${Date.now()}-${Math.random()}`);
  return { optionalAuthenticate: mod.optionalAuthenticate, loggerErrorCalls };
}

function makeOptionalReq(headers: Record<string, string> = {}) {
  return { headers, get: () => '', ip: '127.0.0.1' } as any;
}

async function runOptional(mw: any, req: any) {
  let nextArg: any = 'NOT_CALLED';
  await mw(req, {} as any, (arg?: any) => { nextArg = arg; });
  return { req, nextArg };
}

test('optionalAuthenticate A: no Authorization header/cookie — proceeds as guest, never touches the database', async (t) => {
  let findUniqueCalls = 0;
  const { optionalAuthenticate } = await loadOptionalAuthenticate(t, { findUniqueImpl: async () => { findUniqueCalls++; return null; } });

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq());

  assert.equal(nextArg, undefined, 'must call next() with no error');
  assert.equal(req.user, undefined);
  assert.equal(findUniqueCalls, 0, 'the cheap "no credential" path must not query the database at all');
});

test('optionalAuthenticate B: a valid, active CLIENT token populates req.user', async (t) => {
  const { optionalAuthenticate } = await loadOptionalAuthenticate(t, {
    findUniqueImpl: async () => ({ id: 'client-1', email: 'c@example.com', accountType: AccountType.CLIENT_INDIVIDUAL, status: UserStatus.ACTIVE, activeRole: null, roles: [] }),
  });
  const token = jwt.sign({ userId: 'client-1' }, TEST_SECRET);

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq({ authorization: `Bearer ${token}` }));

  assert.equal(nextArg, undefined);
  assert.equal(req.user?.id, 'client-1');
  assert.equal(req.user?.accountType, AccountType.CLIENT_INDIVIDUAL);
});

test('optionalAuthenticate C: a valid PROVIDER (non-Client) token still populates req.user — the request remains valid; eligibility-leak prevention is the service layer\'s job, not this middleware\'s', async (t) => {
  const { optionalAuthenticate } = await loadOptionalAuthenticate(t, {
    findUniqueImpl: async () => ({ id: 'provider-1', email: 'p@example.com', accountType: AccountType.PROVIDER_INDIVIDUAL, status: UserStatus.ACTIVE, activeRole: null, roles: [] }),
  });
  const token = jwt.sign({ userId: 'provider-1' }, TEST_SECRET);

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq({ authorization: `Bearer ${token}` }));

  assert.equal(nextArg, undefined);
  assert.equal(req.user?.accountType, AccountType.PROVIDER_INDIVIDUAL);
});

test('optionalAuthenticate D: a malformed Authorization header (not "Bearer <token>", no cookie either) is treated as no credential', async (t) => {
  let findUniqueCalls = 0;
  const { optionalAuthenticate } = await loadOptionalAuthenticate(t, { findUniqueImpl: async () => { findUniqueCalls++; return null; } });

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq({ authorization: 'Basic somebase64value' }));

  assert.equal(nextArg, undefined);
  assert.equal(req.user, undefined);
  assert.equal(findUniqueCalls, 0);
});

test('optionalAuthenticate E: an invalid/tampered token (bad signature) never populates req.user and never throws to next()', async (t) => {
  const { optionalAuthenticate, loggerErrorCalls } = await loadOptionalAuthenticate(t);

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq({ authorization: 'Bearer not-a-real-jwt-at-all' }));

  assert.equal(nextArg, undefined, 'must proceed as guest, never pass an error to next()');
  assert.equal(req.user, undefined);
  assert.equal(loggerErrorCalls.length, 0, 'an invalid token is an expected, routine case — never logged as an operational error');
});

test('optionalAuthenticate F: an expired token never populates req.user and never throws to next()', async (t) => {
  const { optionalAuthenticate, loggerErrorCalls } = await loadOptionalAuthenticate(t);
  const expiredToken = jwt.sign({ userId: 'client-1' }, TEST_SECRET, { expiresIn: -10 });

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq({ authorization: `Bearer ${expiredToken}` }));

  assert.equal(nextArg, undefined);
  assert.equal(req.user, undefined);
  assert.equal(loggerErrorCalls.length, 0, 'an expired token is an expected, routine case — never logged as an operational error');
});

test('optionalAuthenticate G: a revoked/rejected session (validateOrRegister returns null, mirroring authenticate\'s own 401 case) never populates req.user', async (t) => {
  const { optionalAuthenticate } = await loadOptionalAuthenticate(t, { sessionImpl: async () => null });
  const token = jwt.sign({ userId: 'client-1' }, TEST_SECRET);

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq({ authorization: `Bearer ${token}` }));

  assert.equal(nextArg, undefined);
  assert.equal(req.user, undefined);
});

test('optionalAuthenticate: a SUSPENDED account\'s otherwise-valid token never populates req.user (mirrors requireActiveUser\'s own rule)', async (t) => {
  const { optionalAuthenticate } = await loadOptionalAuthenticate(t, {
    findUniqueImpl: async () => ({ id: 'client-1', email: 'c@example.com', accountType: AccountType.CLIENT_INDIVIDUAL, status: UserStatus.SUSPENDED, activeRole: null, roles: [] }),
  });
  const token = jwt.sign({ userId: 'client-1' }, TEST_SECRET);

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq({ authorization: `Bearer ${token}` }));

  assert.equal(nextArg, undefined);
  assert.equal(req.user, undefined);
});

test('optionalAuthenticate: an unexpected failure (e.g. the database being unreachable) is logged as a real operational error, yet the request still proceeds as a guest', async (t) => {
  const { optionalAuthenticate, loggerErrorCalls } = await loadOptionalAuthenticate(t, {
    findUniqueImpl: async () => { throw new Error('ECONNREFUSED: database unreachable'); },
  });
  const token = jwt.sign({ userId: 'client-1' }, TEST_SECRET);

  const { req, nextArg } = await runOptional(optionalAuthenticate, makeOptionalReq({ authorization: `Bearer ${token}` }));

  assert.equal(nextArg, undefined, 'the public route must still proceed — never blocked by an infra hiccup');
  assert.equal(req.user, undefined);
  assert.equal(loggerErrorCalls.length, 1, 'an unexpected error must be logged, never silently indistinguishable from routine guest traffic');
});
