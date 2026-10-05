import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Current-visit referral attribution, end to end across the real controllers/service (only DB/mail are mocked):
//   GET /ref/:slug            -> sets waseet_ref_code, redirects to /auth/register?ref=1
//   POST .../referral-cookie/clear (registration page opened without ?ref=1) -> removes the cookie
//   POST /auth/register       -> reads the cookie exactly like auth.controller does and attributes from it
// A tiny cookie jar plays the browser: it stores what res.cookie sets and drops what res.clearCookie clears.

function setupFlow(t: TestContext) {
  const affiliates = [{ id: 'affiliate-1', userId: 'affiliate-user-1', referralSlug: 'khalid2026' }];
  const referrals: any[] = [];
  const jar: Record<string, string> = {};

  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        affiliateProfile: {
          findUnique: async (args: any) => affiliates.find(a => a.referralSlug === args.where.referralSlug) ? { id: 'affiliate-1' } : null,
          findFirst: async (args: any) => {
            const [bySlug, byId] = args.where.OR;
            const m = affiliates.find(a => a.referralSlug === bySlug.referralSlug || a.id === byId.id);
            return m ? { id: m.id, userId: m.userId } : null;
          }
        },
        affiliateChannelMetric: { upsert: async () => ({}) },
        referral: { create: async (args: any) => { referrals.push(args.data); return args.data; } }
      }
    }
  });
  t.mock.module('../repositories/auth.repository', {
    namedExports: { authRepository: { findByEmailOrPhone: async () => null, createUserWithProfile: async () => ({ id: 'user-1', email: 'new@example.com' }), createOtp: async () => ({}) } }
  });
  t.mock.module('./../services/notification.service', {
    namedExports: { notificationService: { sendEmailOtp: async () => ({ messageId: 'x', accepted: ['a'], rejected: [] }) } }
  });

  const res: any = { redirected: null };
  res.cookie = (name: string, value: string) => { jar[name] = value; return res; };
  res.clearCookie = (name: string) => { delete jar[name]; return res; };
  res.status = () => res;
  res.json = () => res;
  res.redirect = (code: number, url: string) => { res.redirected = { code, url }; return res; };

  const browserCookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return { jar, referrals, res, browserCookieHeader };
}

async function loadAll() {
  const stamp = `?fixture=${Date.now()}-${Math.random()}`;
  const { refController } = await import(`./ref.controller.ts${stamp}`);
  const { affiliatesPublicController } = await import(`./affiliates-public.controller.ts${stamp}`);
  const { authService } = await import(`../services/auth.service.ts${stamp}`);
  const { getRequestCookie } = await import(`../utils/request-cookie.ts${stamp}`);
  return { refController, affiliatesPublicController, authService, getRequestCookie };
}

const INPUT: any = { accountType: 'CLIENT_INDIVIDUAL', firstName: 'T', lastName: 'U', email: 'new@example.com', phoneCountryCode: '+966', phoneNumber: '500000001', password: 'Password1', agreedToTerms: true };
const NOOP = () => { throw new Error('next() should not be called'); };

async function clickReferralLink(c: Awaited<ReturnType<typeof loadAll>>, f: ReturnType<typeof setupFlow>) {
  await c.refController.handleReferralClick({ params: { slug: 'khalid2026' }, query: {} } as any, f.res, NOOP);
}
async function register(c: Awaited<ReturnType<typeof loadAll>>, f: ReturnType<typeof setupFlow>, input: any) {
  const refCookieSlug = c.getRequestCookie({ headers: { cookie: f.browserCookieHeader() } } as any, 'waseet_ref_code');
  await c.authService.registerUser(input, { refCookieSlug });
}

test('flow: a real referral click redirects to /auth/register?ref=1 and a client registering in that visit is attributed', async (t) => {
  const f = setupFlow(t);
  const c = await loadAll();
  await clickReferralLink(c, f);
  assert.deepEqual(f.res.redirected, { code: 302, url: '/auth/register?ref=1' });
  assert.equal(f.jar.waseet_ref_code, 'khalid2026');

  await register(c, f, { ...INPUT });
  assert.equal(f.referrals.length, 1);
  assert.equal(f.referrals[0].affiliateId, 'affiliate-1');
});

test('flow: provider from a real referral click is attributed too', async (t) => {
  const f = setupFlow(t);
  const c = await loadAll();
  await clickReferralLink(c, f);
  await register(c, f, { ...INPUT, accountType: 'PROVIDER_INDIVIDUAL' });
  assert.equal(f.referrals.length, 1);
});

test('flow: referral click, then a DIRECT registration visit clears the cookie, and the registration creates no referral', async (t) => {
  const f = setupFlow(t);
  const c = await loadAll();
  await clickReferralLink(c, f);
  assert.equal(f.jar.waseet_ref_code, 'khalid2026');

  // /auth/register opened without ?ref=1 -> the page calls the clear endpoint
  await c.affiliatesPublicController.clearReferralCookie({ headers: { cookie: f.browserCookieHeader() } } as any, f.res, NOOP);
  assert.equal(f.jar.waseet_ref_code, undefined);

  await register(c, f, { ...INPUT });
  assert.equal(f.referrals.length, 0);
});

test('flow: marketer from a real referral click is still never referred', async (t) => {
  const f = setupFlow(t);
  const c = await loadAll();
  await clickReferralLink(c, f);
  await register(c, f, { ...INPUT, accountType: 'MARKETING_BROKER' });
  assert.equal(f.referrals.length, 0);
});
