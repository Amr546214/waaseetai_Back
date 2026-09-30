import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Deployment-safety regression coverage (P-LG-012 affiliate commission
// engine rollout). AffiliateProfile.level exists in prisma/schema.prisma but
// its migration has NOT been applied to DEV/LIVE yet. handleReferralClick()
// previously called findUnique() with no `select` at all (full default
// selection), which would have requested the not-yet-existing `level`
// column and 500'd this public, unauthenticated referral-click endpoint —
// hit on every referral link click.

function createMockRes() {
  const res: any = { statusCode: null, cookieCalls: [] as any[], redirected: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.cookie = (name: string, value: string, options: any) => { res.cookieCalls.push({ name, value, options }); return res; };
  res.redirect = (code: number, url: string) => { res.redirected = { code, url }; return res; };
  return res;
}

async function loadController(t: TestContext, opts: {
  // Shaped exactly like the CURRENT (pre-migration) DB row would actually
  // look — no `level` field at all.
  affiliate?: any;
  upsertShouldThrow?: boolean;
} = {}) {
  const affiliate = 'affiliate' in opts ? opts.affiliate : { id: 'affiliate-1' };
  const findUniqueSpy = t.mock.fn(async (_args: any) => affiliate);
  const upsertSpy = t.mock.fn(async (_args: any) => {
    if (opts.upsertShouldThrow) throw new Error('boom');
    return { id: 'metric-1' };
  });

  const prismaMock: any = {
    affiliateProfile: { findUnique: findUniqueSpy },
    affiliateChannelMetric: { upsert: (args: any) => upsertSpy(args) },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const moduleUrl = `./ref.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const { refController } = await import(moduleUrl);
  return { refController, findUniqueSpy, upsertSpy };
}

test('handleReferralClick: the AffiliateProfile lookup selects only { id: true }, never a bare full selection, never `level`', async (t) => {
  const { refController, findUniqueSpy } = await loadController(t);
  const req: any = { params: { slug: 'khalid-1' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(findUniqueSpy.mock.callCount(), 1);
  const args = findUniqueSpy.mock.calls[0].arguments[0];
  assert.deepEqual(args.select, { id: true });
  assert.equal('level' in args.select, false);
  assert.equal(args.include, undefined);
});

test('handleReferralClick: a real affiliate (fixture shaped like the pre-migration DB, no `level` field) sets the cookie and redirects to /auth/register', async (t) => {
  const { refController } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  const req: any = { params: { slug: 'khalid-1' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.cookieCalls.length, 1);
  assert.equal(res.cookieCalls[0].name, 'waseet_ref_code');
  assert.equal(res.cookieCalls[0].value, 'khalid-1');
  assert.deepEqual(res.redirected, { code: 302, url: '/auth/register' });
});

test('handleReferralClick: an unknown slug never sets a cookie but still redirects to /auth/register (never blocks registration)', async (t) => {
  const { refController } = await loadController(t, { affiliate: null });
  const req: any = { params: { slug: 'unknown-slug' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.cookieCalls.length, 0);
  assert.deepEqual(res.redirected, { code: 302, url: '/auth/register' });
});

// Regression guard: the Angular register component is mounted at
// /auth/register (nested under the 'auth' layout route), never at a bare
// /register — that path previously sent real referral clicks to the
// frontend's 404 page. These two tests exist specifically so a future
// accidental revert to the bare path is caught immediately, independent of
// the general redirect-destination assertions above.
test('handleReferralClick: valid slug — redirect Location is exactly /auth/register, never the old bare /register', async (t) => {
  const { refController } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  const req: any = { params: { slug: 'khalid-1' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.redirected.code, 302);
  assert.equal(res.redirected.url, '/auth/register');
  assert.notEqual(res.redirected.url, '/register');
});

test('handleReferralClick: invalid slug — redirect Location is exactly /auth/register, never the old bare /register, and no cookie is set', async (t) => {
  const { refController } = await loadController(t, { affiliate: null });
  const req: any = { params: { slug: 'definitely-invalid-slug' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.redirected.code, 302);
  assert.equal(res.redirected.url, '/auth/register');
  assert.notEqual(res.redirected.url, '/register');
  assert.equal(res.cookieCalls.length, 0);
});

test('handleReferralClick: with a utm_source, bumps the channel metric using only affiliate.id from the narrowed select', async (t) => {
  const { refController, upsertSpy } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  const req: any = { params: { slug: 'khalid-1' }, query: { utm_source: 'tiktok' } };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(upsertSpy.mock.callCount(), 1);
  const args = upsertSpy.mock.calls[0].arguments[0];
  assert.equal(args.where.affiliateId_channel.affiliateId, 'affiliate-1');
  assert.equal(args.where.affiliateId_channel.channel, 'TIKTOK');
});
