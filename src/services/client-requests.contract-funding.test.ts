import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'contract-funding-secret';
process.env.OTP_SECRET = 'contract-funding-secret';

// Client contract signing + funding: the OTP is checked, the wallet is debited ONCE, an escrow exists only after a successful funding, and a
// contract that is not ready / not this client's is refused before anything is written. One in-memory database behind a mocked prisma.
const REQUEST = 'req-1', CONTRACT = 'contract-1', CLIENT = 'client-1', PROVIDER = 'provider-1', OFFER = 'offer-1', CODE = '123456';

function setup(t: TestContext, o: { price?: number; wallet?: number; contractStatus?: string; contractClient?: string; otp?: 'valid' | 'none'; mailFails?: boolean } = {}) {
  const price = o.price ?? 1000;
  const state: any = { wallet: o.wallet ?? 5000, escrow: null, walletTx: [] as any[], escrowWrites: 0, otpCreated: 0, otpAttempts: 0, otpDeleted: 0, mails: 0, contractStatus: o.contractStatus ?? 'PENDING_CLIENT_SIGNATURE' };
  const contractRow = () => ({ id: CONTRACT, projectId: REQUEST, clientId: o.contractClient ?? CLIENT, providerId: PROVIDER, price, status: state.contractStatus, offerId: OFFER, termsVersion: 1 });
  const otp = { id: 'otp-1', attempts: 0, code: createHmac('sha256', process.env.OTP_SECRET!).update(`${CONTRACT}:${CODE}`).digest('hex') };
  const tx: any = {
    otpVerification: { delete: async () => { state.otpDeleted++; return {}; } },
    contract: { updateMany: async () => { if (state.contractStatus !== 'PENDING_CLIENT_SIGNATURE') return { count: 0 }; state.contractStatus = 'PENDING_PROVIDER_SIGNATURE'; return { count: 1 }; } },
    proposal: { findFirst: async () => ({ id: OFFER, price, providerId: PROVIDER, clientRequestId: REQUEST, provider: { email: 'p@x.co' } }), update: async () => ({}), updateMany: async () => ({}) },
    projectProposal: { updateMany: async () => ({}) },
    clientRequest: { update: async () => ({}), findUnique: async () => ({ title: 'مشروع' }) },
    project: { update: async () => ({}), findUnique: async () => ({ title: 'مشروع' }) },
    providerGamification: { findUnique: async () => ({ currentLevelIndex: 1 }) },
    user: {
      updateMany: async (a: any) => { if (state.wallet >= a.where.walletBalance.gte) { state.wallet -= a.data.walletBalance.decrement; return { count: 1 }; } return { count: 0 }; },
      findUnique: async () => ({ walletBalance: state.wallet, firstName: 'Nora', lastName: 'Q', email: 'c@x.co' }),
    },
    walletTransaction: { create: async (a: any) => { state.walletTx.push(a.data); return a.data; } },
    escrow: { upsert: async (a: any) => { state.escrowWrites++; state.escrow = a.create; return state.escrow; } },
  };
  const prismaMock: any = {
    contract: { findFirst: async (a: any) => {
      const row = contractRow();
      return row.clientId === a.where.clientId && row.status === a.where.status ? row : null;
    } },
    user: { findUnique: async () => ({ id: CLIENT, email: 'c@x.co' }) },
    proposal: { findFirst: async () => null },
    otpVerification: {
      findFirst: async () => (o.otp === 'none' ? null : otp),
      count: async () => 0,
      create: async () => { state.otpCreated++; return { id: 'otp-new' }; },
      delete: async () => { state.otpDeleted++; return {}; },
      update: async (a: any) => { state.otpAttempts = a.data.attempts; return {}; },
    },
    notification: { create: async () => ({}) },
    $transaction: async (fn: any) => fn(tx),
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async () => { state.mails++; if (o.mailFails) throw new Error('smtp'); return {}; } }, getOtpEmailTemplate: () => '', getDepositConfirmationTemplate: () => '', getProviderContractSignatureTemplate: () => '' } });
  return state;
}
const load = async () => {
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  return new ClientRequestsService();
};
const status = (e: any) => e.statusCode ?? e.status;

test('signContract: a contract that is not waiting for THIS client (not ready, already signed, or another client\'s) is refused and no code is sent', async (t) => {
  const state = setup(t, { contractClient: 'another-client' });
  await assert.rejects(async () => (await load()).signContract(CLIENT, REQUEST, OFFER), (e: any) => status(e) === 409 && /اختيار عرض صالح/.test(e.message));
  assert.equal(state.otpCreated, 0);
  assert.equal(state.mails, 0);
});

test('signContract: a contract already past the client signature is refused (409), nothing is sent', async (t) => {
  const state = setup(t, { contractStatus: 'PENDING_PROVIDER_SIGNATURE' });
  await assert.rejects(async () => (await load()).signContract(CLIENT, REQUEST, OFFER), (e: any) => status(e) === 409);
  assert.equal(state.otpCreated + state.mails, 0);
});

test('signContract: when the e-mail cannot be sent the code is withdrawn and the client is told nothing was signed or held (503)', async (t) => {
  const state = setup(t, { mailFails: true });
  await assert.rejects(async () => (await load()).signContract(CLIENT, REQUEST, OFFER), (e: any) => status(e) === 503 && /لم يتم تنفيذ أي توقيع/.test(e.message));
  assert.equal(state.otpDeleted, 1);
  assert.equal(state.escrow, null);
});

test('depositEscrow: another client\'s contract (or one that is not ready) is refused with 409 before the code or the wallet are touched', async (t) => {
  const state = setup(t, { contractClient: 'another-client' });
  await assert.rejects(async () => (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet'), (e: any) => status(e) === 409 && /غير جاهز/.test(e.message));
  assert.equal(state.wallet, 5000);
  assert.equal(state.escrowWrites, 0);
  assert.equal(state.walletTx.length, 0);
});

test('depositEscrow: a wrong code is refused (400) with the remaining attempts; wallet, contract and escrow stay untouched', async (t) => {
  const state = setup(t);
  await assert.rejects(async () => (await load()).depositEscrow(CLIENT, REQUEST, OFFER, '000000', 'wallet'), (e: any) => status(e) === 400 && /المحاولات المتبقية: 4/.test(e.message));
  assert.equal(state.otpAttempts, 1);
  assert.equal(state.wallet, 5000);
  assert.equal(state.escrowWrites, 0);
  assert.equal(state.contractStatus, 'PENDING_CLIENT_SIGNATURE');
});

test('depositEscrow: no live code (expired / never requested) is refused (400); nothing is held', async (t) => {
  const state = setup(t, { otp: 'none' });
  await assert.rejects(async () => (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet'), (e: any) => status(e) === 400 && /منتهي الصلاحية/.test(e.message));
  assert.equal(state.escrowWrites, 0);
  assert.equal(state.wallet, 5000);
});

test('depositEscrow: an insufficient wallet is a 402 that reports required / available / shortfall; no escrow and no ledger row is written', async (t) => {
  const state = setup(t, { price: 1000, wallet: 400 });
  await assert.rejects(async () => (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet'), (e: any) => {
    const d = (e.details ?? e.errors ?? [])[0];
    return status(e) === 402 && d?.required === 1000 && d?.available === 400 && d?.shortfall === 600;
  });
  assert.equal(state.wallet, 400);
  assert.equal(state.escrowWrites, 0);
  assert.equal(state.walletTx.length, 0);
});

test('depositEscrow: only the wallet can fund the escrow (any other method is refused, 400)', async (t) => {
  const state = setup(t);
  await assert.rejects(async () => (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'card'), (e: any) => status(e) === 400);
  assert.equal(state.escrowWrites, 0);
});

test('depositEscrow: a correct code funds once: price debited, escrow HELD created only now, contract moves to the provider signature', async (t) => {
  const state = setup(t);
  await (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
  assert.equal(state.wallet, 4000);
  assert.equal(state.escrow.status, 'HELD');
  assert.equal(state.escrowWrites, 1);
  assert.equal(state.contractStatus, 'PENDING_PROVIDER_SIGNATURE');
});

test('depositEscrow: submitting twice never pays twice (second call is 409, wallet debited once, one escrow write)', async (t) => {
  const state = setup(t);
  const svc = await load();
  await svc.depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
  await assert.rejects(() => svc.depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet'), (e: any) => status(e) === 409);
  assert.equal(state.wallet, 4000);
  assert.equal(state.walletTx.length, 1);
  assert.equal(state.escrowWrites, 1);
});

test('depositEscrow: two simultaneous submissions pay once (the guarded contract transition lets exactly one through)', async (t) => {
  const state = setup(t);
  const svc = await load();
  const results = await Promise.allSettled([svc.depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet'), svc.depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(state.wallet, 4000);
  assert.equal(state.walletTx.length, 1);
  assert.equal(state.escrowWrites, 1);
});
