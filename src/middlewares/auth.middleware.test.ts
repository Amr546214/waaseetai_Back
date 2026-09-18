import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountType } from '@prisma/client';
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
