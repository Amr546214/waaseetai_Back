import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'deposit-mails-secret';
process.env.OTP_SECRET = 'deposit-mails-secret';
process.env.FRONTEND_URL = 'https://dev.example.test';

/**
 * ONE mail per event / purpose / recipient on the escrow deposit (owner decision 3). The receipt (client) and the contract invitation (provider) are TRANSACTIONAL: they are the
 * mail of the event, the ESCROW_FUNDED / OFFER_ACCEPTED notifications are stored and pushed but their e-mail copies are NOT sent even though both users opted in, a repeated
 * submit (409) or a simultaneous one sends nothing more, and a failing receipt neither blocks the invitation nor the in-app notifications. In-memory database behind a mocked prisma.
 */
const REQUEST = 'req-1', CONTRACT = 'contract-1', CLIENT = 'client-1', PROVIDER = 'provider-1', OFFER = 'offer-1', CODE = '123456';

// transitive modules (notification service ...) keep the db mock of the FIRST test that imported them, so the stored notifications are collected in one module-level list
const NOTIFICATIONS: any[] = [];
function setup(t: TestContext, o: { price?: number; wallet?: number; contractStatus?: string; contractClient?: string; otp?: 'valid' | 'none'; mailFails?: boolean; failFirstMail?: boolean; recentChallengeAges?: number[] } = {}) {
  const price = o.price ?? 1000;
  const state: any = { wallet: o.wallet ?? 5000, escrow: null, walletTx: [] as any[], escrowWrites: 0, otpCreated: 0, otpAttempts: 0, otpDeleted: 0, mails: 0, sent: [] as any[],  contractStatus: o.contractStatus ?? 'PENDING_CLIENT_SIGNATURE' };
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
    user: { findUnique: async () => ({ id: CLIENT, email: 'c@x.co', firstName: 'Nora' }) },
    $executeRaw: async () => 0, $queryRaw: async () => [],
    proposal: { findFirst: async () => null },
    otpVerification: {
      findFirst: async () => (o.otp === 'none' ? null : otp),
      count: async () => o.recentChallengeAges?.length ?? 0,
      findMany: async () => (o.recentChallengeAges ?? []).map(age => ({ createdAt: new Date(Date.now() - age) })).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      create: async () => { state.otpCreated++; return { id: 'otp-new' }; },
      delete: async () => { state.otpDeleted++; return {}; },
      update: async (a: any) => { state.otpAttempts = a.data.attempts; return {}; },
    },
    notification: { create: async (a: any) => { const row = { id: `n-${NOTIFICATIONS.length + 1}`, actionText: null, metadata: null, isRead: false, createdAt: new Date(), category: 'ALL', ...a.data }; NOTIFICATIONS.push(row); return row; } },
    // BOTH recipients opted in to e-mail copies: without the central pairing rule each would get a second mail for the same event
    notificationPreference: { findUnique: async () => ({ settings: { email: true, inApp: true } }) },
    clientProfile: { findUnique: async () => ({ interfaceLanguage: 'العربية' }) },
    providerProfile: { findUnique: async () => ({ preferences: { notifChannels: ['push', 'email'] }, user: { email: 'p@x.co', firstName: 'Pro' } }) },
    $transaction: async (fn: any) => fn(tx),
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  return state;
}
const load = async () => {
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  return new ClientRequestsService();
};

const status = (e: any) => e.statusCode ?? e.status;
async function boot(t: TestContext, o: Parameters<typeof setup>[1] = {}) {
  const state = setup(t, o); NOTIFICATIONS.length = 0;
  const { mailTransporter } = await import('../utils/mail.transporter');
  let n = 0;
  (mailTransporter as any).sendMail = async (m: any) => { n++; if (o.mailFails || (o.failFirstMail && n === 1)) throw new Error('smtp'); state.sent.push(m); return { accepted: [m.to] }; };
  const { resetMailLedger } = await import('./mail-dispatch'); resetMailLedger();
  return state;
}
const settle = () => new Promise(r => setTimeout(r, 40));

test('deposit: exactly two mails - the receipt to the client and the contract invitation to the provider - and NO second copy from the ESCROW_FUNDED / OFFER_ACCEPTED notifications, though both users opted in', async (t) => {
  const state = await boot(t);
  await (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
  await settle();
  assert.equal(state.sent.length, 2, state.sent.map(m => m.subject).join(' | '));
  const receipt = state.sent.find(m => m.to === 'c@x.co'), invite = state.sent.find(m => m.to === 'p@x.co');
  assert.ok(receipt && invite);
  // the notifications themselves are stored (in-app stays)
  assert.deepEqual(NOTIFICATIONS.map(n => n.type).sort(), ['ESCROW_FUNDED', 'OFFER_ACCEPTED']);
  // merged content: amount, project, link; plain text; automatic headers; no external fonts; shared shell
  assert.match(receipt.html, /1,000\.00 \$/); assert.match(receipt.html, /مشروع/); assert.match(receipt.html, /https:\/\/dev\.example\.test\/client-overview/);
  assert.match(receipt.text, /1,000\.00 \$/); assert.equal(receipt.headers['Auto-Submitted'], 'auto-generated');
  assert.match(invite.html, /https:\/\/dev\.example\.test\/provider-overview\/offers\/offer-1\/sign-contract/); assert.match(invite.html, /Nora/);
  assert.match(invite.text, /sign-contract/);
  for (const m of [receipt, invite]) { assert.doesNotMatch(m.html, /fonts\.googleapis|<link /i); assert.match(m.html, /max-width:600px/); assert.ok(m.text.length > 20); }
});

test('deposit: a repeated submit (409) or a simultaneous one sends nothing more - still the same two mails in total', async (t) => {
  const state = await boot(t);
  const svc = await load();
  const results = await Promise.allSettled([svc.depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet'), svc.depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(() => svc.depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet'), (e: any) => status(e) === 409);
  await settle();
  assert.equal(state.sent.length, 2, state.sent.map(m => m.to + ':' + m.subject).join(' | '));
  assert.equal(NOTIFICATIONS.length, 2);
});

test('deposit: the same event handed to the sender twice (a retried callback) is mailed once per recipient; a failed attempt stays retryable', async (t) => {
  const state = await boot(t);
  const { dispatchMail } = await import('./mail-dispatch');
  const { mailTransporter } = await import('../utils/mail.transporter');
  const mail = { purpose: 'escrow-deposit-receipt' as const, to: 'c@x.co', recipientKey: CLIENT, eventKey: CONTRACT, subject: 's', html: '<p>x</p>', text: 'x', transport: mailTransporter as any };
  assert.equal((await dispatchMail(mail)).status, 'sent');
  const again = await dispatchMail(mail);
  assert.deepEqual([again.status, (again as any).reason], ['suppressed', 'duplicate']);
  assert.equal(state.sent.length, 1);
  // a send that failed is released: the retry delivers
  let fail = true; const real = (mailTransporter as any).sendMail;
  (mailTransporter as any).sendMail = async (m: any) => { if (fail) { fail = false; throw new Error('smtp'); } return real(m); };
  const m2 = { ...mail, eventKey: 'contract-2' };
  assert.equal((await dispatchMail(m2)).status, 'failed');
  assert.equal((await dispatchMail(m2)).status, 'sent');
  assert.equal((await dispatchMail(m2)).status, 'suppressed');
});

test('deposit: a failing receipt does not skip the provider invitation nor the in-app notifications', async (t) => {
  const state = await boot(t, { failFirstMail: true });
  await (await load()).depositEscrow(CLIENT, REQUEST, OFFER, CODE, 'wallet');
  await settle();
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].to, 'p@x.co');
  assert.deepEqual(NOTIFICATIONS.map(n => n.type).sort(), ['ESCROW_FUNDED', 'OFFER_ACCEPTED']);
});
