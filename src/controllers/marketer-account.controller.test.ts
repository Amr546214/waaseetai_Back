import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

let current: any;
const delegatingPrisma = new Proxy({}, { get: (_t, key) => current[key as string] });

const res = () => { const r: any = { headers: {}, body: undefined, setHeader(k: string, v: string) { r.headers[k] = v; }, json(b: any) { r.body = b; return r; }, send(b: any) { r.body = b; return r; } }; return r; };
const run = async (fn: any, req: any) => { const r = res(); let err: any; await fn(req, r, (e: any) => { err = e; }); return { r, err }; };

async function load(t: TestContext) {
  current = {
    withdrawal: {
      findUnique: async ({ where }: any) => where.id === 'w1' ? { id: 'w1', userId: 'mkt', amount: 400, currency: 'USD', status: 'REJECTED', rejectionReason: 'x', paypalEmail: 'm@example.com', iban: 'SA00', accountName: 'n', accountNumber: '1' } : null,
      findMany: async () => [{ id: 'w1', amount: 400, status: 'COMPLETED', iban: 'SA00' }],
      count: async () => 1
    },
    affiliateProfile: { findUnique: async (args: any) => args.select?.paypalPayoutEmail ? { paypalPayoutEmail: 'm@example.com' } : { id: 'aff', referralSlug: 'khalid', bio: 'b', createdAt: new Date(0), marketingChannels: [{ platform: 'TIKTOK', handle: '@k' }], referrals: [{ id: 'r1', status: 'PENDING', createdAt: new Date(0) }], commissionLogs: [{ id: 'c1', type: 'STAGE_RELEASE', amount: 5, currency: 'USD', status: 'APPROVED', createdAt: new Date(0) }] } },
    user: { findUnique: async () => ({ firstName: 'خالد', lastName: 'ع', email: 'm@example.com' }) },
    notificationPreference: { findUnique: async () => ({ settings: { marketer_timezone: 'Asia/Dubai' } }) }
  };
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../config/db', { namedExports: { prisma: delegatingPrisma } });
  return import(`./marketer-account.controller.ts?f=${Date.now()}-${Math.random()}`);
}

test('transaction details: the marketer sees his own withdrawal in any state (rejection reason included) without a legacy bank destination', async t => {
  const c = await load(t);
  const { r, err } = await run(c.getMyMarketerWithdrawal, { user: { id: 'mkt' }, params: { id: 'w1' } });
  assert.equal(err, undefined);
  assert.equal(r.body.data.status, 'REJECTED');
  assert.equal(r.body.data.rejectionReason, 'x');
  assert.equal(r.body.data.iban, undefined);
  assert.equal(r.body.data.accountNumber, undefined);
});

test('transaction details: someone else\'s or a missing withdrawal is a 404', async t => {
  const c = await load(t);
  assert.equal((await run(c.getMyMarketerWithdrawal, { user: { id: 'other' }, params: { id: 'w1' } })).err.statusCode, 404);
  assert.equal((await run(c.getMyMarketerWithdrawal, { user: { id: 'mkt' }, params: { id: 'zzz' } })).err.statusCode, 404);
});

test('settings PATCH: invalid values are a 400 with an Arabic message and nothing is saved', async t => {
  const c = await load(t);
  const { err } = await run(c.updateMarketerSettings, { user: { id: 'mkt' }, body: { timezone: 'Mars/Olympus' } });
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /المنطقة الزمنية/);
});

test('data download: a real JSON file with the marketer\'s own data, no bank fields, no other user', async t => {
  const c = await load(t);
  const { r, err } = await run(c.exportMarketerData, { user: { id: 'mkt' } });
  assert.equal(err, undefined);
  assert.match(r.headers['Content-Disposition'], /attachment; filename="waseet-marketer-data\.json"/);
  assert.match(r.headers['Content-Type'], /application\/json/);
  const data = JSON.parse(r.body);
  assert.equal(data.account.email, 'm@example.com');
  assert.equal(data.paypalEmail, 'm@example.com');
  assert.equal(data.profile.commissionLogs.length, 1);
  assert.equal(data.profile.referrals.length, 1);
  assert.equal(data.withdrawals.length, 1);
  assert.equal(data.withdrawals[0].iban, undefined);
  assert.equal(data.settings.timezone, 'Asia/Dubai');
  assert.equal(data.profile.id, undefined);
});
