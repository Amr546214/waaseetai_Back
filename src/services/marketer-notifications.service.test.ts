import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
// e-mail links always carry the site host (utils/site-url): the tests that look at the link configure it
process.env.FRONTEND_URL = 'https://dev.example.test';

process.env.OPENAI_API_KEY = 'test-key';

// Every marketer event gets a STORED notification whose actionUrl opens a REAL marketer route; push / e-mail follow the marketer's saved switches.
// REAL_MARKETER_ROUTES mirrors angular-app marketer.routes.ts (only the ones a notification can point at).
const REAL_MARKETER_ROUTES = [
  /^\/marketer-overview\/referrals$/,
  /^\/marketer-overview\/commissions$/,
  /^\/marketer-overview\/withdraw$/,
  /^\/marketer-overview\/profile\/data$/,
  /^\/marketer-overview\/help\/tickets\/[^/]+$/
];
const isRealMarketerRoute = (url: unknown) => typeof url === 'string' && REAL_MARKETER_ROUTES.some(r => r.test(url));

interface Fixture { notifications: any[]; mails: any[]; pushes: any[]; }
let current: Fixture & { prisma: any };
const delegatingPrisma = new Proxy({}, { get: (_t, key) => current.prisma[key as string] });

const MARKETER_OWNER = { accountType: 'MARKETING_BROKER', roles: ['AFFILIATE', 'CLIENT'], activeRole: 'AFFILIATE', affiliateProfile: { id: 'aff-1' } };

async function load(t: TestContext, opts: { settings?: unknown; withdrawal?: any; owner?: any; affiliate?: any; db?: Record<string, any> } = {}) {
  const f: Fixture = { notifications: [], mails: [], pushes: [] };
  const withdrawal = opts.withdrawal === undefined ? { id: 'w1', userId: 'mkt-1', amount: 350, currency: 'USD', rejectionReason: 'بيانات غير مكتملة' } : opts.withdrawal;
  const prisma = {
    notification: { create: async ({ data }: any) => { const row = { id: `n${f.notifications.length + 1}`, actionText: null, metadata: null, isRead: false, createdAt: new Date(), ...data }; f.notifications.push(row); return row; } },
    notificationPreference: { findUnique: async () => (opts.settings === undefined ? null : { settings: opts.settings }) },
    providerProfile: { findUnique: async () => null },
    withdrawal: { findUnique: async () => withdrawal },
    affiliateProfile: { findUnique: async () => opts.affiliate === undefined ? { userId: 'mkt-1', notifyOnNewReferral: true } : opts.affiliate },
    user: { findUnique: async (args: any) => ('accountType' in (args.select ?? {})) ? (opts.owner ?? MARKETER_OWNER) : { email: 'm@example.com', firstName: 'ليلى' } },
    ...opts.db
  };
  current = Object.assign(f, { prisma });
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (o: any) => { current.mails.push(o); return {}; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
  t.mock.module('../socket', { namedExports: { getIO: () => ({ to() { return this; }, emit: (_e: string, d: any) => current.pushes.push(d) }) } });
  t.mock.module('../config/db', { namedExports: { prisma: delegatingPrisma } });
  return f;
}
const settle = () => new Promise(r => setTimeout(r, 20));
const fresh = async (path: string) => import(`${path}?fixture=${Date.now()}-${Math.random()}`);

test('withdrawal: every state (requested / approved / rejected / paid / failed / reversed) stores a notification with the real withdraw route', async t => {
  const f = await load(t);
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  for (const event of ['REQUESTED', 'APPROVED', 'REJECTED', 'PAID', 'FAILED', 'REVERSED']) await marketerNotifications.withdrawal('w1', event);
  assert.equal(f.notifications.length, 6);
  assert.deepEqual(f.notifications.map(n => n.type), ['WITHDRAWAL_REQUESTED', 'WITHDRAWAL_APPROVED', 'WITHDRAWAL_REJECTED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_FAILED', 'WITHDRAWAL_REVERSED']);
  for (const n of f.notifications) {
    assert.equal(n.userId, 'mkt-1');
    assert.equal(n.category, 'FINANCIAL');
    assert.equal(n.actionUrl, '/marketer-overview/withdraw');
    assert.ok(isRealMarketerRoute(n.actionUrl));
    assert.ok(n.actionText);
    assert.match(n.message, /350 \$/);
  }
  assert.match(f.notifications[2].message, /بيانات غير مكتملة/);
});

test('withdrawal: a PROVIDER-earnings withdrawal, or a withdrawal of someone who is not a marketer, sends no marketer notification', async t => {
  const f = await load(t, { owner: { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'AFFILIATE'], activeRole: 'PROVIDER', affiliateProfile: { id: 'aff-9' } } });
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.withdrawal('w1', 'PAID');
  assert.equal(f.notifications.length, 0);
});

test('withdrawal: a missing withdrawal sends nothing and never throws', async t => {
  const f = await load(t, { withdrawal: null });
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.withdrawal('nope', 'PAID');
  assert.equal(f.notifications.length, 0);
});

test('payout method change: set / replaced and removed both notify with the profile route', async t => {
  const f = await load(t);
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.paypalEmailChanged('mkt-1', false);
  await marketerNotifications.paypalEmailChanged('mkt-1', true);
  assert.equal(f.notifications.length, 2);
  assert.equal(f.notifications[0].type, 'PAYPAL_EMAIL_CHANGED');
  assert.equal(f.notifications[0].actionUrl, '/marketer-overview/profile/data');
  assert.ok(isRealMarketerRoute(f.notifications[0].actionUrl));
  assert.match(f.notifications[1].title, /إزالة/);
});

test('referral joined (click -> sign-up): notifies the marketer with the referrals route; off in the referral-links settings = nothing', async t => {
  const f = await load(t);
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.referralJoined({ affiliateId: 'aff-1', referralId: 'r1', referredName: 'خالد' });
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].type, 'REFERRAL_JOINED');
  assert.equal(f.notifications[0].userId, 'mkt-1');
  assert.equal(f.notifications[0].actionUrl, '/marketer-overview/referrals');
  assert.match(f.notifications[0].message, /خالد/);
  assert.ok(isRealMarketerRoute(f.notifications[0].actionUrl));
});

test('referral joined with notifyOnNewReferral=false sends nothing', async t => {
  const f = await load(t, { affiliate: { userId: 'mkt-1', notifyOnNewReferral: false } });
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.referralJoined({ affiliateId: 'aff-1', referralId: 'r1' });
  assert.equal(f.notifications.length, 0);
});

test('commission approved: one notification per commission, to the affiliate user, with the commissions route and the amount', async t => {
  const f = await load(t);
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.commissionsApproved([{ affiliateUserId: 'mkt-1', commissionId: 'c1', amount: 12.5, currency: 'USD' }, { affiliateUserId: 'mkt-2', commissionId: 'c2', amount: 40, currency: 'USD' }]);
  assert.equal(f.notifications.length, 2);
  assert.deepEqual(f.notifications.map(n => n.userId), ['mkt-1', 'mkt-2']);
  assert.equal(f.notifications[0].type, 'COMMISSION_APPROVED');
  assert.equal(f.notifications[0].actionUrl, '/marketer-overview/commissions');
  assert.match(f.notifications[0].message, /12.5 \$/);
  assert.ok(isRealMarketerRoute(f.notifications[0].actionUrl));
});

test('static: no event is invented — there is no commission rejection and no campaign notification', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./marketer-notifications.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /COMMISSION_REJECTED|CAMPAIGN/);
});

// ---- channels ----

test('channels: nothing saved = real-time push on, no e-mail; the notification is stored', async t => {
  const f = await load(t);
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.withdrawal('w1', 'PAID'); await settle();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.pushes.length, 1);
  assert.equal(f.mails.length, 0);
});

test('channels: e-mail on = an e-mail copy as well as the push', async t => {
  const f = await load(t, { settings: { channel_email: true } });
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.withdrawal('w1', 'PAID'); await settle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0].to, 'm@example.com');
  assert.match(f.mails[0].html, /\/marketer-overview\/withdraw/);
});

test('channels: in-app off = stored, not pushed; e-mail still follows its own switch', async t => {
  const f = await load(t, { settings: { channel_in_app: false, channel_email: true } });
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.withdrawal('w1', 'APPROVED'); await settle();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.mails.length, 1);
});

test('channels: the per-event switch off (marketer_new_commission=false) = stored only, no push, no e-mail', async t => {
  const f = await load(t, { settings: { marketer_new_commission: false, channel_email: true } });
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.commissionsApproved([{ affiliateUserId: 'mkt-1', commissionId: 'c1', amount: 10, currency: 'USD' }]); await settle();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.mails.length, 0);
});

test('channels: the communication language en gives an English e-mail frame', async t => {
  const f = await load(t, { settings: { channel_email: true, marketer_communication_language: 'en' } });
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.withdrawal('w1', 'PAID'); await settle();
  assert.equal(f.mails.length, 1);
  assert.match(f.mails[0].html, /dir="ltr"/);
  assert.match(f.mails[0].html, /Hello/);
});

test('channels: the provider profile preferences never apply to a marketer notification', async t => {
  const f = await load(t, { db: { providerProfile: { findUnique: async () => ({ preferences: { notifChannels: [] }, user: { email: 'p@example.com', firstName: 'x' } }) } } });
  const { marketerNotifications } = await fresh('./marketer-notifications.service.ts');
  await marketerNotifications.withdrawal('w1', 'PAID'); await settle();
  assert.equal(f.pushes.length, 1);
});
