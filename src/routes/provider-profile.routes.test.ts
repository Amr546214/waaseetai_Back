import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// P0-2 remediation regression guard. The actual authorization DECISION logic
// (authorize(PROVIDER_INDIVIDUAL, PROVIDER_COMPANY)) is unit-tested directly
// in src/middlewares/auth.middleware.test.ts; this test instead locks in the
// route-to-guard WIRING itself — i.e. that `requireProvider` is actually
// attached to every route that reads/writes ProviderProfile-scoped data, is
// NOT attached to the identity-level session/password routes (which have no
// equivalent elsewhere and must stay open to any authenticated role), and
// that the admin/public routes are untouched. A pure source-level check
// (rather than booting an Express app with supertest, which this codebase's
// test suite does not otherwise use) so a future edit that silently drops a
// guard from one of these route lines fails this test immediately.

const source = fs.readFileSync(path.join(__dirname, 'provider-profile.routes.ts'), 'utf8');
const lines = source.split('\n');

function lineContaining(needle: string): string {
  const line = lines.find(l => l.includes(needle));
  assert.ok(line, `Expected to find a route line containing: ${needle}`);
  return line as string;
}

test('the public providerId profile route is registered before the authenticate middleware (stays public)', () => {
  const publicIndex = lines.findIndex(l => l.includes("router.get('/public/:providerId'"));
  const authIndex = lines.findIndex(l => l.includes('router.use(authenticate, requireActiveUser)'));
  assert.ok(publicIndex >= 0 && authIndex >= 0);
  assert.ok(publicIndex < authIndex, 'public providerId route must be registered before the authenticate() gate');
  assert.ok(!lines[publicIndex].includes('requireProvider'), 'public route must not carry the PROVIDER-only guard');
});

test('every ProviderProfile-scoped route carries the requireProvider guard', () => {
  const mustBeProviderGated = [
    "router.post('/documents/upload'",
    "router.get('/me'",
    "router.get('/setup'",
    "router.post('/setup'", // the exact route the audit flagged as exploitable
    "router.get('/public'",
    "router.get('/requests'",
    "router.post('/requests'",
    "router.post('/requests/:id/cancel'",
    "router.get('/requests/:tabName'",
    "router.post('/sensitive-change'",
    "router.post('/sensitive-change/verify'",
    "router.put('/basic-info'",
    "router.put('/contact'",
    "router.put('/banking'",
    "router.put('/docs'",
    "router.put('/skills'",
    "router.post('/portfolio'",
    "router.put('/portfolio/:id'",
    "router.delete('/portfolio/:id'"
  ];

  for (const needle of mustBeProviderGated) {
    const line = lineContaining(needle);
    assert.ok(line.includes('requireProvider'), `Expected "${needle}" to include requireProvider, got: ${line}`);
  }
});

test('identity-level session/password routes remain open to any authenticated role (no requireProvider)', () => {
  const identityLevelRoutes = [
    "router.get('/sessions'",
    "router.delete('/sessions/:id'",
    "router.put('/password'"
  ];

  for (const needle of identityLevelRoutes) {
    const line = lineContaining(needle);
    assert.ok(!line.includes('requireProvider'), `Expected "${needle}" to stay open (no requireProvider), got: ${line}`);
  }
});

test('admin-only review routes are unaffected — still gated by authorize(ADMIN, SUPER_ADMIN), not requireProvider', () => {
  const adminRoutes = [
    "router.post('/requests/:id/review'",
    "router.get('/admin/pending-reviews'"
  ];

  for (const needle of adminRoutes) {
    const line = lineContaining(needle);
    assert.ok(line.includes('authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN)'), `Expected "${needle}" to keep its admin guard, got: ${line}`);
    assert.ok(!line.includes('requireProvider'), `Admin route "${needle}" should not also require PROVIDER`);
  }
});
