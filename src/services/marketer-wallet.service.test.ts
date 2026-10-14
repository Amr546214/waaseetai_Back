import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// The marketer wallet applies the SAME rule createForMarketer() / approve() enforce: withdrawable = approved commissions - every withdrawal that still holds its amount.
let current: any;
const delegatingPrisma = new Proxy({}, { get: (_t, key) => current[key as string] });

interface Fixture { approved?: number; pending?: number; paid?: number; withdrawals?: Array<{ status: string; amount: number }>; paypal?: string | null; minimum?: number; owner?: any; noProfile?: boolean }

async function load(t: TestContext, f: Fixture) {
  current = {
    affiliateProfile: { findUnique: async (args: any) => f.noProfile ? null : ('paypalPayoutEmail' in args.select ? { paypalPayoutEmail: f.paypal === undefined ? 'm@example.com' : f.paypal } : { id: 'aff-1', minimumPayoutAmount: f.minimum ?? 300 }) },
    commissionLog: { groupBy: async () => [['APPROVED', f.approved], ['PENDING', f.pending], ['PAID', f.paid]].filter(([, v]) => v !== undefined).map(([status, amount]) => ({ status, _sum: { amount } })) },
    withdrawal: { groupBy: async () => {
      const by = new Map<string, number>();
      for (const w of f.withdrawals ?? []) by.set(w.status, (by.get(w.status) ?? 0) + w.amount);
      return [...by].map(([status, amount]) => ({ status, _sum: { amount } }));
    } },
    user: { findUnique: async () => f.owner ?? { accountType: 'MARKETING_BROKER', roles: ['AFFILIATE', 'CLIENT'], activeRole: 'AFFILIATE' } }
  };
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  t.mock.module('../config/db', { namedExports: { prisma: delegatingPrisma } });
  const { marketerWalletService } = await import(`./marketer-wallet.service.ts?f=${Date.now()}-${Math.random()}`);
  return marketerWalletService;
}

test('available = approved earned - pending/approved/processing - paid; a rejected withdrawal holds nothing', async t => {
  const svc = await load(t, { approved: 1000, pending: 80, withdrawals: [{ status: 'PENDING', amount: 100 }, { status: 'APPROVED', amount: 50 }, { status: 'COMPLETED', amount: 300 }, { status: 'REJECTED', amount: 400 }] });
  const w = await svc.getWallet('u1');
  assert.equal(w.approvedEarnings, 1000);
  assert.equal(w.pendingEarnings, 80);
  assert.equal(w.reservedWithdrawals, 150);
  assert.equal(w.paidWithdrawals, 300);
  assert.equal(w.withdrawableBalance, 550);
  assert.equal(w.currency, 'USD');
});

test('a pending withdrawal reduces what can be withdrawn; a REVERSED payout stays spent', async t => {
  const svc = await load(t, { approved: 500, withdrawals: [{ status: 'PROCESSING', amount: 200 }, { status: 'REVERSED', amount: 100 }] });
  const w = await svc.getWallet('u1');
  assert.equal(w.withdrawableBalance, 200);
  assert.equal(w.paidWithdrawals, 100);
  assert.equal(w.reservedWithdrawals, 200);
});

test('the balance never goes negative', async t => {
  const svc = await load(t, { approved: 100, withdrawals: [{ status: 'COMPLETED', amount: 250 }] });
  assert.equal((await svc.getWallet('u1')).withdrawableBalance, 0);
});

test('payout method required: no saved PayPal email blocks the withdrawal with the clear reason', async t => {
  const svc = await load(t, { approved: 1000, paypal: null });
  const w = await svc.getWallet('u1');
  assert.equal(w.hasPaypal, false);
  assert.equal(w.withdrawBlockedReason, 'أضف بريد PayPal لاستلام الأرباح');
});

test('below the minimum is blocked with the real minimum (300 is the floor)', async t => {
  const svc = await load(t, { approved: 250 });
  const w = await svc.getWallet('u1');
  assert.equal(w.minimumWithdrawal, 300);
  assert.match(w.withdrawBlockedReason, /300/);
});

test('a per-affiliate minimum above 300 wins', async t => {
  const svc = await load(t, { approved: 350, minimum: 400 });
  const w = await svc.getWallet('u1');
  assert.equal(w.minimumWithdrawal, 400);
  assert.match(w.withdrawBlockedReason, /400/);
});

test('a per-affiliate minimum below 300 is lifted to the 300 floor', async t => {
  const svc = await load(t, { approved: 100, minimum: 50 });
  assert.equal((await svc.getWallet('u1')).minimumWithdrawal, 300);
});

test('a balance at or above the minimum with PayPal saved can be withdrawn (no blocked reason)', async t => {
  const svc = await load(t, { approved: 450, withdrawals: [{ status: 'REJECTED', amount: 100 }] });
  const w = await svc.getWallet('u1');
  assert.equal(w.withdrawableBalance, 450);
  assert.equal(w.withdrawBlockedReason, null);
});

test('a user who is both provider and marketer is told commission withdrawal is not available (same 409 rule as the server)', async t => {
  const svc = await load(t, { approved: 1000, owner: { accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'AFFILIATE'], activeRole: 'AFFILIATE' } });
  assert.match((await svc.getWallet('u1')).withdrawBlockedReason, /يجمع|تجمع/);
});

test('no marketer profile: zero money and an honest reason, nothing invented', async t => {
  const svc = await load(t, { noProfile: true });
  const w = await svc.getWallet('u1');
  assert.equal(w.withdrawableBalance, 0);
  assert.equal(w.approvedEarnings, 0);
  assert.ok(w.withdrawBlockedReason);
});

test('static: the wallet never reads the client wallet (no walletBalance / walletTransaction) and the page has no top-up route', async () => {
  const { readFileSync } = await import('node:fs');
  const svc = readFileSync(new URL('./marketer-wallet.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(svc, /walletBalance|walletTransaction|deposit|topup/i);
  const routes = readFileSync(new URL('../routes/marketer-overview.routes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /deposit|top-?up/i);
});
