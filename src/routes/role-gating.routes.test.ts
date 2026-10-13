import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authorize, authorizeActiveRole } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

// A2: wrong role -> 403. The routes carry the existing role middleware (static check), and that middleware (the very one providerOnly / clientOnly
// are built from) really answers 403 for the wrong role and lets both individual and company accounts of the right side through.
const provider = readFileSync(new URL('./provider.routes.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('./client-requests.routes.ts', import.meta.url), 'utf8');
const block = (src: string, marker: string) => { const i = src.indexOf(marker); assert.ok(i >= 0, `${marker} registered`); return src.slice(i, i + 220); };

test('POST /client/requests is client-only, by the ACTING role', () => {
  assert.match(client, /const clientActingOnly = authorizeActiveRole\(AccountType\.CLIENT_COMPANY, AccountType\.CLIENT_INDIVIDUAL\)/);
  assert.match(client, /router\.post\('\/', authenticate, requireActiveUser, clientActingOnly, clientRequestsController\.createRequest\)/);
});
test('GET /provider/explore-requests is provider-only', () => {
  assert.match(block(provider, "'/explore-requests',"), /requireActiveUser,\s*providerActingOnly,\s*exploreRequestsController\.getExploreRequests/);
});
test('POST /provider/offers/:id/sign is provider-only', () => {
  assert.match(block(provider, "'/offers/:id/sign',"), /requireActiveUser,\s*providerActingOnly,\s*signContract/);
});

const run = (mw: any, user: any) => { let err: any; mw({ user }, {}, (e?: any) => { err = e; }); return err; };
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);
const clientOnly = authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL);
test('wrong role is 403; right role (individual and company) passes', () => {
  assert.equal(run(providerOnly, { accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT' }).statusCode, 403);
  assert.equal(run(providerOnly, { accountType: 'MARKETING_BROKER', roles: ['AFFILIATE'], activeRole: 'AFFILIATE' }).statusCode, 403);
  assert.equal(run(providerOnly, { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER' }), undefined);
  assert.equal(run(providerOnly, { accountType: 'PROVIDER_COMPANY', roles: ['PROVIDER'], activeRole: 'PROVIDER' }), undefined);
  assert.equal(run(clientOnly, { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER' }).statusCode, 403);
  assert.equal(run(clientOnly, { accountType: 'CLIENT_COMPANY', roles: ['CLIENT'], activeRole: 'CLIENT' }), undefined);
  assert.equal(run(clientOnly, { accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT' }), undefined);
});

// Multi-role users (every account also holds CLIENT): the ACTING role decides on the sensitive flows.
const clientActing = authorizeActiveRole(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL);
const providerActing = authorizeActiveRole(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);
test('roles [CLIENT, PROVIDER] acting as PROVIDER: POST /client/requests is 403', () => {
  const u = { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'PROVIDER' };
  assert.equal(run(clientActing, u).statusCode, 403);
  assert.equal(run(providerActing, u), undefined);
});
test('same user acting as CLIENT: POST /client/requests passes (reaches normal validation); provider endpoints (explore, sign) are 403', () => {
  const u = { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'CLIENT' };
  assert.equal(run(clientActing, u), undefined);
  assert.equal(run(providerActing, u).statusCode, 403);
});
test('multi-role marketer acting as AFFILIATE is blocked on both sides; no active role falls back to the account type', () => {
  const m = { accountType: 'MARKETING_BROKER', roles: ['AFFILIATE', 'CLIENT'], activeRole: 'AFFILIATE' };
  assert.equal(run(clientActing, m).statusCode, 403);
  assert.equal(run(providerActing, m).statusCode, 403);
  assert.equal(run(providerActing, { accountType: 'PROVIDER_COMPANY', roles: ['PROVIDER'] }), undefined);
  assert.equal(run(clientActing, { accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'] }), undefined);
  assert.equal(run(clientActing, undefined).statusCode, 401);
});
