import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// GET /api/affiliates/referral-status — the frontend cannot read the
// httpOnly waseet_ref_code cookie itself, so it asks the backend, via this
// endpoint, whether a valid referral-cookie attribution currently exists.
// ALWAYS 200 (never 404/error) — the `active` boolean carries the result.

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

async function loadController(t: TestContext, getReferralStatusImpl: (cookieSlug: string | undefined) => Promise<any>) {
  const getReferralStatusSpy = t.mock.fn(getReferralStatusImpl);
  t.mock.module('../services/affiliates-public.service', {
    namedExports: { affiliatesPublicService: { getReferralStatus: getReferralStatusSpy } }
  });

  const moduleUrl = `./affiliates-public.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const { affiliatesPublicController } = await import(moduleUrl);
  return { affiliatesPublicController, getReferralStatusSpy };
}

test('referralStatus: a request with the waseet_ref_code cookie present — reads it via the manual cookie-header parser and returns 200 { active: true, ... }', async (t) => {
  const { affiliatesPublicController, getReferralStatusSpy } = await loadController(t, async () => (
    { active: true, referralSlug: 'khalid2026', displayName: 'خالد العتيبي' }
  ));
  const req: any = { headers: { cookie: 'waseet_ref_code=khalid2026; other=1' } };
  const res = createMockRes();

  await affiliatesPublicController.referralStatus(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(getReferralStatusSpy.mock.callCount(), 1);
  assert.equal(getReferralStatusSpy.mock.calls[0].arguments[0], 'khalid2026');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: { active: true, referralSlug: 'khalid2026', displayName: 'خالد العتيبي' } });
});

test('referralStatus: an unknown/stale cookie value — still 200, { active: false }, never a 404', async (t) => {
  const { affiliatesPublicController } = await loadController(t, async () => ({ active: false }));
  const req: any = { headers: { cookie: 'waseet_ref_code=stale-or-deleted' } };
  const res = createMockRes();

  await affiliatesPublicController.referralStatus(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: { active: false } });
});

test('referralStatus: no cookie header at all — 200 { active: false }, service is called with undefined', async (t) => {
  const { affiliatesPublicController, getReferralStatusSpy } = await loadController(t, async () => ({ active: false }));
  const req: any = { headers: {} };
  const res = createMockRes();

  await affiliatesPublicController.referralStatus(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(getReferralStatusSpy.mock.calls[0].arguments[0], undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: { active: false } });
});

test('referralStatus: never uses req.cookies (no cookie-parser middleware is registered in this codebase)', async (t) => {
  const { affiliatesPublicController, getReferralStatusSpy } = await loadController(t, async () => ({ active: false }));
  // req.cookies is always undefined in this app; a header-based cookie must
  // still be read correctly even if some middleware upstream left req.cookies
  // populated with something unrelated/stale.
  const req: any = { headers: { cookie: 'waseet_ref_code=real-slug' }, cookies: { waseet_ref_code: 'wrong-value' } };
  const res = createMockRes();

  await affiliatesPublicController.referralStatus(req, res, () => { throw new Error('next() should not be called on success'); });

  assert.equal(getReferralStatusSpy.mock.calls[0].arguments[0], 'real-slug');
});

test('referralStatus: a service-layer error is passed to next(), not swallowed', async (t) => {
  const boom = new Error('boom');
  const { affiliatesPublicController } = await loadController(t, async () => { throw boom; });
  const req: any = { headers: {} };
  const res = createMockRes();

  let caught: any = null;
  await affiliatesPublicController.referralStatus(req, res, (err: any) => { caught = err; });

  assert.equal(caught, boom);
});

test('referralStatus: an active response never contains email/phone/bank/IBAN/KYC/wallet/id fields', async (t) => {
  const { affiliatesPublicController } = await loadController(t, async () => (
    { active: true, referralSlug: 'khalid2026', displayName: 'خالد العتيبي' }
  ));
  const req: any = { headers: { cookie: 'waseet_ref_code=khalid2026' } };
  const res = createMockRes();

  await affiliatesPublicController.referralStatus(req, res, () => { throw new Error('next() should not be called on success'); });

  const data = res.body.data;
  for (const forbiddenField of ['email', 'phone', 'phoneNumber', 'iban', 'bankName', 'kycDocumentUrl', 'id']) {
    assert.equal(forbiddenField in data, false, `must not expose ${forbiddenField}`);
  }
});
