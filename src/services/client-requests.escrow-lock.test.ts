import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'escrow-lock-secret';
process.env.OTP_SECRET = 'escrow-lock-secret';

// Fee policy v2, escrow lock: the client funds exactly the contract price (no 13%), the escrow row and the ESCROW_LOCK transaction carry the
// snapshot, and escrows created earlier are never touched. One in-memory database behind a mocked prisma; the real depositEscrow runs.
const REQUEST = 'req-1', CONTRACT = 'contract-1', CLIENT = 'client-1', PROVIDER = 'provider-1', OFFER = 'offer-1', CODE = '123456';

function setup(t: TestContext, o: { price?: number; wallet?: number; providerLevel?: number | null; existingEscrow?: any } = {}) {
  const price = o.price ?? 1000;
  const state: any = { wallet: o.wallet ?? 5000, escrow: o.existingEscrow ?? null, walletTx: [] as any[], escrowUpserts: [] as any[] };
  const contract = { id: CONTRACT, projectId: REQUEST, clientId: CLIENT, providerId: PROVIDER, price, status: 'PENDING_CLIENT_SIGNATURE', offerId: OFFER, termsVersion: 1 };
  const otp = { id: 'otp-1', attempts: 0, code: createHmac('sha256', process.env.OTP_SECRET!).update(`${CONTRACT}:${CODE}`).digest('hex') };
  const tx: any = {
    otpVerification: { delete: async () => ({}) },
    contract: { updateMany: async () => ({ count: 1 }) },
    proposal: { findFirst: async () => ({ id: OFFER, price, providerId: PROVIDER, clientRequestId: REQUEST, provider: { email: 'p@x.co' } }), update: async () => ({}), updateMany: async () => ({}) },
    projectProposal: { updateMany: async () => ({}) },
    clientRequest: { update: async () => ({}), findUnique: async () => ({ title: 'مشروع' }) },
    project: { update: async () => ({}), findUnique: async () => ({ title: 'مشروع' }) },
    providerGamification: { findUnique: async () => (o.providerLevel === null ? null : { currentLevelIndex: o.providerLevel ?? 1 }) },
    user: {
      updateMany: async (a: any) => { if (state.wallet >= a.where.walletBalance.gte) { state.wallet -= a.data.walletBalance.decrement; return { count: 1 }; } return { count: 0 }; },
      findUnique: async () => ({ walletBalance: state.wallet, firstName: 'Nora', lastName: 'Q', email: 'c@x.co' }),
    },
    walletTransaction: { create: async (a: any) => { state.walletTx.push(a.data); return a.data; } },
    escrow: { upsert: async (a: any) => { state.escrowUpserts.push(a); state.escrow = { ...(state.escrow ?? {}), ...(state.escrow ? a.update : a.create) }; return state.escrow; } },
  };
  const prismaMock: any = {
    contract: { findFirst: async () => contract },
    proposal: { findFirst: async () => null },
    otpVerification: { findFirst: async () => otp, delete: async () => ({}), update: async () => ({}) },
    notification: { create: async () => ({}) },
    $transaction: async (fn: any) => fn(tx),
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async () => ({}) }, getOtpEmailTemplate: () => '', getDepositConfirmationTemplate: () => '', getProviderContractSignatureTemplate: () => '' } });
  return state;
}
const load = async () => {
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  return new ClientRequestsService();
};

test('a new escrow debits the contract price ONLY (1000 -> 1000, never 1130) and stores exactly that amount', async (t) => {
  const state = setup(t, { price: 1000, wallet: 5000 });
  await (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
  assert.equal(state.wallet, 4000, 'the wallet loses the price and nothing else');
  assert.equal(state.walletTx.length, 1);
  assert.equal(state.walletTx[0].type, 'ESCROW_LOCK');
  assert.equal(state.walletTx[0].amount, 1000);
  assert.equal(state.escrow.amount, 1000);
  assert.equal(state.escrow.status, 'HELD');
});

test('the ESCROW_LOCK metadata says there is no escrow fee and which policy created it', async (t) => {
  const state = setup(t, { price: 640.5 });
  await (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
  assert.deepEqual(state.walletTx[0].metadata, { requestId: REQUEST, contractId: CONTRACT, offerId: OFFER, feePolicyVersion: 2, escrowFee: 0, contractPrice: 640.5 });
  assert.equal(state.walletTx[0].amount, 640.5);
});

for (const [level, rate] of [[1, 12.75], [9, 10.15], [15, 8.15]] as const) {
  test(`the escrow carries the provider commission snapshot of the level at lock time (level ${level} = ${rate}%)`, async (t) => {
    const state = setup(t, { providerLevel: level });
    await (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
    const e = state.escrow;
    assert.deepEqual([e.feePolicyVersion, e.providerCommissionRateSnapshot, e.providerCommissionLevelSnapshot], [2, rate, level]);
    assert.ok(e.providerCommissionSnapshotAt instanceof Date);
    assert.equal(e.platformCommissionAmount, undefined, 'nothing is taken at lock: the commission is taken at release');
  });
}

test('a provider without a gamification row snapshots level 1 (12.75%)', async (t) => {
  const state = setup(t, { providerLevel: null });
  await (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
  assert.deepEqual([state.escrow.providerCommissionLevelSnapshot, state.escrow.providerCommissionRateSnapshot], [1, 12.75]);
});

test('a wallet of 1100 now funds a 1000 contract (it was short of 1130 under the old 13% charge)', async (t) => {
  const state = setup(t, { price: 1000, wallet: 1100 });
  await (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
  assert.equal(state.wallet, 100);
});

test('an insufficient wallet is a 402 that asks for the PRICE (not price + 13%), and nothing is written', async (t) => {
  const poor = setup(t, { price: 1000, wallet: 900 });
  await assert.rejects(async () => (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet'), (e: any) => {
    assert.equal(e.statusCode, 402);
    assert.deepEqual([e.errors[0].required, e.errors[0].available, e.errors[0].shortfall], [1000, 900, 100]);
    return true;
  });
  assert.equal(poor.walletTx.length, 0);
  assert.equal(poor.escrow, null);
});
