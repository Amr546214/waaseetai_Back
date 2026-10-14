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

test('handleReferralClick: a real affiliate (fixture shaped like the pre-migration DB, no `level` field) sets the cookie and redirects to /auth/register?ref=khalid-1', async (t) => {
  const { refController } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  const req: any = { params: { slug: 'khalid-1' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.cookieCalls.length, 2);
  assert.equal(res.cookieCalls[0].name, 'waseet_ref_code');
  assert.equal(res.cookieCalls[0].value, 'khalid-1');
  // the real slug is carried in the URL: /auth/register?ref=khalid-1
  assert.deepEqual(res.redirected, { code: 302, url: '/auth/register?ref=khalid-1' });
  assert.deepEqual({ ...res.cookieCalls[0].options, maxAge: undefined }, { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: undefined });
  assert.equal(res.cookieCalls[0].options.maxAge, 30 * 24 * 60 * 60 * 1000);
});

test('handleReferralClick: an unknown slug never sets a cookie, is reported as ?ref_invalid=1 (not a valid-looking marker) and still redirects to /auth/register (never blocks registration)', async (t) => {
  const { refController } = await loadController(t, { affiliate: null });
  const req: any = { params: { slug: 'unknown-slug' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.cookieCalls.length, 0);
  assert.deepEqual(res.redirected, { code: 302, url: '/auth/register?ref_invalid=1' });
});

// Regression guard: the Angular register component is mounted at
// /auth/register (nested under the 'auth' layout route), never at a bare
// /register — that path previously sent real referral clicks to the
// frontend's 404 page. These two tests exist specifically so a future
// accidental revert to the bare path is caught immediately, independent of
// the general redirect-destination assertions above.
test('handleReferralClick: valid slug — redirect Location is exactly /auth/register?ref=<the real slug>, never ref=1 and never the old bare /register', async (t) => {
  const { refController } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  const req: any = { params: { slug: 'khalid-1' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.redirected.code, 302);
  assert.equal(res.redirected.url, '/auth/register?ref=khalid-1');
  assert.notEqual(res.redirected.url, '/auth/register?ref=1');
  assert.notEqual(res.redirected.url, '/register');
});

test('handleReferralClick: invalid slug — redirect Location is exactly /auth/register?ref_invalid=1, never the old bare /register, and no cookie is set', async (t) => {
  const { refController } = await loadController(t, { affiliate: null });
  const req: any = { params: { slug: 'definitely-invalid-slug' }, query: {} };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.redirected.code, 302);
  assert.equal(res.redirected.url, '/auth/register?ref_invalid=1');
  assert.notEqual(res.redirected.url, '/register');
  assert.equal(res.cookieCalls.length, 0);
});

test('handleReferralClick: with a utm_source, bumps the channel metric using only affiliate.id from the narrowed select', async (t) => {
  const { refController, upsertSpy } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  const req: any = { params: { slug: 'khalid-1' }, query: { utm_source: 'tiktok' }, method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 Safari' } };
  const res = createMockRes();

  await refController.handleReferralClick(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(upsertSpy.mock.callCount(), 1);
  const args = upsertSpy.mock.calls[0].arguments[0];
  assert.equal(args.where.affiliateId_channel.affiliateId, 'affiliate-1');
  assert.equal(args.where.affiliateId_channel.channel, 'TIKTOK');
});

const BROWSER_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15';

test('click tracking: a plain browser click without utm_source counts one direct (OTHER) visit and stores the channel cookie', async (t) => {
  const { refController, upsertSpy } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  const req: any = { params: { slug: 'khalid-1' }, query: {}, method: 'GET', headers: { 'user-agent': BROWSER_UA } };
  const res = createMockRes();
  await refController.handleReferralClick(req, res, () => { throw new Error('unexpected'); });
  assert.equal(upsertSpy.mock.callCount(), 1);
  const args = upsertSpy.mock.calls[0].arguments[0];
  assert.equal(args.where.affiliateId_channel.channel, 'OTHER');
  assert.equal(args.update.visitors.increment, 1);
  assert.deepEqual(res.cookieCalls.map((c: any) => [c.name, c.value]), [['waseet_ref_code', 'khalid-1'], ['waseet_ref_src', 'OTHER']]);
});

test('click tracking: bots, link-preview crawlers, HEAD requests and clients without a user-agent are not counted', async (t) => {
  const { refController, upsertSpy } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  for (const req of [
    { method: 'GET', headers: { 'user-agent': 'facebookexternalhit/1.1' } },
    { method: 'GET', headers: { 'user-agent': 'Googlebot/2.1' } },
    { method: 'HEAD', headers: { 'user-agent': BROWSER_UA } },
    { method: 'GET', headers: {} },
  ]) {
    await refController.handleReferralClick({ params: { slug: 'khalid-1' }, query: {}, ...req } as any, createMockRes(), () => { throw new Error('unexpected'); });
  }
  assert.equal(upsertSpy.mock.callCount(), 0);
});

test('click tracking: a repeat click from a browser already holding the same slug+channel cookie is not counted twice', async (t) => {
  const { refController, upsertSpy } = await loadController(t, { affiliate: { id: 'affiliate-1' } });
  const req: any = { params: { slug: 'khalid-1' }, query: { utm_source: 'tiktok' }, method: 'GET', headers: { 'user-agent': BROWSER_UA, cookie: 'waseet_ref_code=khalid-1; waseet_ref_src=TIKTOK' } };
  await refController.handleReferralClick(req, createMockRes(), () => { throw new Error('unexpected'); });
  assert.equal(upsertSpy.mock.callCount(), 0);
  // a different channel from the same browser IS a new visit
  const req2: any = { ...req, query: { utm_source: 'instagram' } };
  await refController.handleReferralClick(req2, createMockRes(), () => { throw new Error('unexpected'); });
  assert.equal(upsertSpy.mock.callCount(), 1);
});

test('click tracking: an unknown slug increments nothing', async (t) => {
  const { refController, upsertSpy } = await loadController(t, { affiliate: null });
  await refController.handleReferralClick({ params: { slug: 'nope' }, query: {}, method: 'GET', headers: { 'user-agent': BROWSER_UA } } as any, createMockRes(), () => { throw new Error('unexpected'); });
  assert.equal(upsertSpy.mock.callCount(), 0);
});
