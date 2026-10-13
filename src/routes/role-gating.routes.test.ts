import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authorize } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

// A2: wrong role -> 403. The routes carry the existing role middleware (static check), and that middleware (the very one providerOnly / clientOnly
// are built from) really answers 403 for the wrong role and lets both individual and company accounts of the right side through.
const provider = readFileSync(new URL('./provider.routes.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('./client-requests.routes.ts', import.meta.url), 'utf8');
const block = (src: string, marker: string) => { const i = src.indexOf(marker); assert.ok(i >= 0, `${marker} registered`); return src.slice(i, i + 220); };

test('POST /client/requests is client-only', () => {
  assert.match(client, /const clientOnly = authorize\(AccountType\.CLIENT_COMPANY, AccountType\.CLIENT_INDIVIDUAL\)/);
  assert.match(client, /router\.post\('\/', authenticate, requireActiveUser, clientOnly, clientRequestsController\.createRequest\)/);
});
test('GET /provider/explore-requests is provider-only', () => {
  assert.match(block(provider, "'/explore-requests',"), /requireActiveUser,\s*providerOnly,\s*exploreRequestsController\.getExploreRequests/);
});
test('POST /provider/offers/:id/sign is provider-only', () => {
  assert.match(block(provider, "'/offers/:id/sign',"), /requireActiveUser,\s*providerOnly,\s*signContract/);
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
