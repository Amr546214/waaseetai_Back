import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { amendmentRow, otpRow, seedWorld } from './amendment-fake-db.testkit';
import { splitRelease } from '../utils/escrow-commission';

// Amendment EFFECTIVE: behavior tests over an in-memory stand-in for the DB (see amendment-fake-db.testkit.ts: serialized transactions + rollback on throw).
// These prove the logic and the money invariants; they do not prove Postgres row-lock behavior (the lock order is asserted statically at the bottom).

type World = ReturnType<typeof seedWorld>;

// One module mock per test (node:test allows it once); every setup() in the same test swaps the world behind the proxy.
// The proxy object is the SAME for every test, so modules cached by an earlier test (progress service, dispute guard) still read the current world.
let currentWorld: World | null = null;
const dbProxy = new Proxy({}, { get: (_target, key) => (currentWorld as any).db[key] });
const mocked = new WeakMap<TestContext, { world: World | null; sent: { email: string; code: string }[] }>();
async function setup(t: TestContext, opts: Parameters<typeof seedWorld>[0] = {}) {
	const world = seedWorld(opts);
	let ctx = mocked.get(t);
	if (!ctx) {
		const state: { world: World | null; sent: { email: string; code: string }[] } = { world: null, sent: [] };
		ctx = state;
		mocked.set(t, state);
		t.mock.module('../config/db', { namedExports: { prisma: dbProxy } });
		const real = await import(`./notification.service.ts?real=${Date.now()}-${Math.random()}`);
		const ns: any = new Proxy({ sendPaymentOtpEmail: async (email: string, code: string) => { state.sent.push({ email, code }); return {}; } }, { get: (target: any, key) => (key in target ? target[key] : async () => ({ id: 'n-1' })) });
		t.mock.module('./notification.service', { namedExports: { ...real, notificationService: ns } });
	}
	ctx.world = world;
	currentWorld = world;
	const { projectAmendmentService: svc } = await import(`./project-amendment.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { world, svc, sent: ctx.sent };
}

const refused = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => e.statusCode === status && (!re || re.test(e.message)), `expected ${status}`);
const contractOf = (w: World) => w.tables.contract[0];
const escrowOf = (w: World) => w.tables.escrow[0];
const walletOf = (w: World, id = 'client-1') => w.tables.user.find(u => u.id === id)!.walletBalance as number;
const stagesOf = (w: World) => [...w.tables.projectStage].sort((a, b) => a.stepOrder - b.stepOrder);
const amendmentOf = (w: World, id = 'amend-1') => w.tables.projectAmendment.find(a => a.id === id)!;
const cents = (n: number) => Math.round(n * 100) / 100;

// Contract, escrow and stages must agree after any change.
function assertInvariant(w: World) {
	const price = contractOf(w).price;
	const stages = stagesOf(w);
	assert.ok(Math.abs(stages.reduce((s, x) => s + x.amount, 0) - price) <= 0.005, `stage sum ${stages.map(s => s.amount)} != price ${price}`);
	assert.ok(Math.abs(escrowOf(w).amount - price) <= 0.005, `escrow ${escrowOf(w).amount} != price ${price}`);
	assert.ok(Math.abs(stages.reduce((s, x) => s + x.percentage, 0) - 100) <= 0.01, `percentages ${stages.map(s => s.percentage)}`);
	assert.equal(contractOf(w).phasesCount, stages.length);
}
// Everything that must stay exactly as it was when an amendment is refused / only requested / rejected.
const snapshotMoney = (w: World) => JSON.stringify({ c: { ...contractOf(w), updatedAt: 0 }, e: escrowOf(w), s: stagesOf(w), u: w.tables.user, tx: w.tables.walletTransaction, terms: w.tables.contractTermsVersion });
const lastOtpCode = (w: World) => w.tables.otpVerification.at(-1)!.code as string;

// provider raised +5, the client approves with the payment code
async function approveIncreaseAsClient(svc: any, w: World) {
	await svc.initPaymentAuthorization('client-1', 'amend-1');
	return svc.respondToAmendment('client-1', 'amend-1', 'approve', lastOtpCode(w));
}

// ---------- a request alone changes nothing ----------
test('a request alone (client- or provider-raised) changes nothing: contract, escrow, stages, wallet', async (t) => {
	const { world, svc } = await setup(t);
	const before = snapshotMoney(world);
	await svc.createProviderAmendment('provider-1', 'project-1', { type: 'BUDGET', title: 'زيادة', budgetDelta: 5 });
	await svc.createAmendment('client-1', 'project-1', { type: 'BUDGET', title: 'زيادة 2', budgetDelta: 7 });
	assert.equal(snapshotMoney(world), before);
	assert.equal(world.tables.projectAmendment.length, 2);
	assert.ok(world.tables.projectAmendment.every(a => a.status === 'PENDING_OTHER_PARTY' && !a.appliedAt));
});

test('a budget amount with more than 2 decimals is refused at creation (400)', async (t) => {
	const { svc } = await setup(t);
	await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'BUDGET', title: 'x', budgetDelta: 5.123 }), 400, /خانتين/);
});

// ---------- budget increase: the happy path and the money rules ----------
test('increase +5 (provider-raised), client approves with the payment code: wallet, escrow, contract, new last stage, all in one step', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()] });
	const before = { escrow: escrowOf(world), s1: stagesOf(world)[0], s2: stagesOf(world)[1] };
	const out = await approveIncreaseAsClient(svc, world);

	assert.equal(out.status, 'APPROVED');
	assert.equal(out.effect, 'APPLIED');
	assert.equal(out.priceBefore, 20);
	assert.equal(out.priceAfter, 25);
	assert.equal(walletOf(world), 95);
	const tx = world.tables.walletTransaction;
	assert.equal(tx.length, 1);
	assert.deepEqual([tx[0].type, tx[0].amount, tx[0].referenceId, tx[0].userId, tx[0].currency], ['AMENDMENT_TOPUP', -5, 'amend-1', 'client-1', 'USD']);
	assert.equal(contractOf(world).price, 25);
	assert.equal(escrowOf(world).amount, 25);
	const stages = stagesOf(world);
	assert.deepEqual(stages.map(s => s.amount), [10, 10, 5]);
	assert.equal(stages[2].stepOrder, 3);
	assert.equal(stages[2].status, 'PENDING');
	assert.match(stages[2].title, /^تعديل: /);
	assert.equal(stages[2].amendmentId, 'amend-1');
	assert.equal(amendmentOf(world).addedStageId, stages[2].id);
	assertInvariant(world);
	// untouched: the original stages and the commission snapshot
	assert.deepEqual([stages[0].amount, stages[0].title, stages[0].status, stages[0].days], [before.s1.amount, before.s1.title, before.s1.status, before.s1.days]);
	assert.deepEqual([stages[1].amount, stages[1].status], [before.s2.amount, before.s2.status]);
	assert.equal(escrowOf(world).providerCommissionRateSnapshot, before.escrow.providerCommissionRateSnapshot);
	assert.equal(escrowOf(world).providerCommissionLevelSnapshot, before.escrow.providerCommissionLevelSnapshot);
	assert.equal(escrowOf(world).feePolicyVersion, 2);
	assert.equal(escrowOf(world).platformCommissionAmount, 0);
	assert.equal(escrowOf(world).releasedAmount, 0);
	// the code is one-time use and an audit row exists for both sides
	assert.equal(world.tables.otpVerification.length, 0);
	assert.equal(world.tables.accountAuditLog.filter(l => l.eventType === 'AMENDMENT_APPLIED').length, 2);
});

test('payment code: wrong code is refused (400) and counted, nothing changes; the fifth wrong guess locks (429)', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()] });
	await svc.initPaymentAuthorization('client-1', 'amend-1');
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '000000'), 400, /غير صحيح/);
	assert.equal(world.tables.otpVerification[0].attempts, 1);
	assert.equal(snapshotMoney(world), before);
	assert.equal(amendmentOf(world).status, 'PENDING_OTHER_PARTY');
	for (let i = 0; i < 3; i++) await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '000000'), 400);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '000000'), 429);
	assert.equal(world.tables.otpVerification.length, 0);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '123456'), 400, /اطلب رمزًا جديدًا/);
	assert.equal(walletOf(world), 100);
});

test('payment code: an expired code is refused and removed; nothing changes', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()], otps: [otpRow({ expiresAt: new Date(Date.now() - 1000) })] });
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '123456'), 400, /انتهت صلاحية/);
	assert.equal(snapshotMoney(world), before);
	assert.equal(amendmentOf(world).status, 'PENDING_OTHER_PARTY');
});

test('payment code issued for a DIFFERENT amount can never authorize this amendment', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()], otps: [otpRow({ context: { purpose: 'AMENDMENT_PAYMENT', amendmentId: 'amend-1', amount: 7 } })] });
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '123456'), 400, /مبلغ مختلف/);
	assert.equal(snapshotMoney(world), before);
	assert.equal(walletOf(world), 100);
});

test('payment code of ANOTHER amendment, or of ANOTHER purpose (checkout payment / login), is not found for this one', async (t) => {
	const { world, svc } = await setup(t, {
		amendments: [amendmentRow()],
		otps: [
			otpRow({ id: 'o-other-amendment', context: { purpose: 'AMENDMENT_PAYMENT', amendmentId: 'amend-9', amount: 5 } }),
			otpRow({ id: 'o-checkout', context: { purpose: 'checkout_payment', orderId: 'amend-1', amount: 5 } }),
			otpRow({ id: 'o-login', context: { purpose: 'LOGIN_EMAIL' } }),
			otpRow({ id: 'o-nopurpose', context: {} })
		]
	});
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '123456'), 400, /لا يوجد رمز/);
	assert.equal(walletOf(world), 100);
	assert.equal(contractOf(world).price, 20);
});

test('approving an increase WITHOUT a code is refused (400); nothing changes', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()] });
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve'), 400, /رمز التحقق مطلوب/);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '   '), 400);
	assert.equal(snapshotMoney(world), before);
});

test('insufficient wallet: asking for the code is 409 with the shortfall, and a valid code cannot force the approval (409, nothing changes, code stays valid)', async (t) => {
	const { world, svc } = await setup(t, { wallet: 3, amendments: [amendmentRow()] });
	await assert.rejects(svc.initPaymentAuthorization('client-1', 'amend-1'), (e: any) => e.statusCode === 409 && /رصيد المحفظة غير كافٍ/.test(e.message) && e.errors?.[0]?.shortfall === 2);
	world.tables.otpVerification.push(otpRow());
	const before = snapshotMoney(world);
	await assert.rejects(svc.respondToAmendment('client-1', 'amend-1', 'approve', '123456'), (e: any) => e.statusCode === 409 && /رصيد المحفظة غير كافٍ/.test(e.message) && e.errors?.[0]?.required === 5);
	assert.equal(snapshotMoney(world), before);
	assert.equal(amendmentOf(world).status, 'PENDING_OTHER_PARTY');
	assert.equal(amendmentOf(world).appliedAt, null);
	assert.equal(world.tables.otpVerification.length, 1);
});

// ---------- client-raised increase: the client's OTP-authorized act is the funding intent ----------
test('client-raised increase: the provider cannot apply it before the client authorized the payment (409, nothing changes)', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1' })] });
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), 409, /لم يعتمد العميل دفع/);
	assert.equal(snapshotMoney(world), before);
});

test('client-raised increase: the OTP authorization charges NOTHING; the provider approval applies and debits exactly once', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1' })] });
	await svc.initPaymentAuthorization('client-1', 'amend-1');
	await refused(svc.authorizeFunding('client-1', 'amend-1', '000000'), 400);
	const authorized = await svc.authorizeFunding('client-1', 'amend-1', lastOtpCode(world));
	assert.equal(authorized.fundingAuthorized, true);
	assert.equal(amendmentOf(world).fundingAuthorizedAmount, 5);
	assert.equal(walletOf(world), 100);
	assert.equal(contractOf(world).price, 20);
	const out = await svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve');
	assert.equal(out.effect, 'APPLIED');
	assert.equal(walletOf(world), 95);
	assert.equal(world.tables.walletTransaction.length, 1);
	assert.equal(contractOf(world).price, 25);
	assertInvariant(world);
});

test('client-raised increase: if the wallet no longer covers it when the provider approves, 409 and nothing changes', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1', fundingAuthorizedAt: new Date(), fundingAuthorizedAmount: 5 })], wallet: 1 });
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), 409, /رصيد المحفظة غير كافٍ/);
	assert.equal(snapshotMoney(world), before);
});

test('an authorization stored for another amount does not authorize this one', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1', fundingAuthorizedAt: new Date(), fundingAuthorizedAmount: 3 })] });
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), 409, /لم يعتمد العميل دفع/);
	assert.equal(snapshotMoney(world), before);
});

// ---------- reject / cancel / repeated answers ----------
test('reject (either side) and cancel change nothing: no money, no stage, no wallet row', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow(), amendmentRow({ id: 'amend-2', requestedByRole: 'CLIENT', requestedById: 'client-1' }), amendmentRow({ id: 'amend-3' })] });
	const before = snapshotMoney(world);
	const r1 = await svc.respondToAmendment('client-1', 'amend-1', 'reject');
	const r2 = await svc.respondToAmendmentAsProvider('provider-1', 'amend-2', 'reject');
	const c3 = await svc.cancelAmendment('provider-1', 'PROVIDER', 'amend-3');
	assert.deepEqual([r1.status, r1.effect, r2.status, c3.status, c3.effect], ['REJECTED', 'NONE', 'REJECTED', 'CANCELLED', 'NONE']);
	assert.equal(snapshotMoney(world), before);
	await refused(svc.respondToAmendment('client-1', 'amend-3', 'approve', '123456'), 409);
});

test('cancel: only the raiser, only while pending; the stored funding authorization is cleared', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1', fundingAuthorizedAt: new Date(), fundingAuthorizedAmount: 5 })] });
	await refused(svc.cancelAmendment('provider-1', 'PROVIDER', 'amend-1'), 403);
	await refused(svc.cancelAmendment('client-9', 'CLIENT', 'amend-1'), 403);
	const out = await svc.cancelAmendment('client-1', 'CLIENT', 'amend-1');
	assert.equal(out.status, 'CANCELLED');
	assert.equal(amendmentOf(world).fundingAuthorizedAt, null);
	await refused(svc.cancelAmendment('client-1', 'CLIENT', 'amend-1'), 409);
	await refused(svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), 409);
});

test('double click: the second approval is refused (409); the wallet is debited ONCE and there is ONE wallet row and ONE new stage', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()] });
	await svc.initPaymentAuthorization('client-1', 'amend-1');
	const code = lastOtpCode(world);
	await svc.respondToAmendment('client-1', 'amend-1', 'approve', code);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', code), 409, /مسبقًا/);
	assert.equal(walletOf(world), 95);
	assert.equal(world.tables.walletTransaction.length, 1);
	assert.equal(stagesOf(world).length, 3);
	assertInvariant(world);
});

test('two simultaneous approvals: exactly one wins, the other is a clean 409, one debit', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()] });
	await svc.initPaymentAuthorization('client-1', 'amend-1');
	const code = lastOtpCode(world);
	const results = await Promise.allSettled([svc.respondToAmendment('client-1', 'amend-1', 'approve', code), svc.respondToAmendment('client-1', 'amend-1', 'approve', code)]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
	assert.equal(failure.reason.statusCode, 409);
	assert.equal(walletOf(world), 95);
	assert.equal(world.tables.walletTransaction.length, 1);
	assert.equal(contractOf(world).price, 25);
	assertInvariant(world);
});

test('two simultaneous provider approvals of a client-raised increase: one debit', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1', fundingAuthorizedAt: new Date(), fundingAuthorizedAmount: 5 })] });
	const results = await Promise.allSettled([svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve')]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal(walletOf(world), 95);
	assert.equal(world.tables.walletTransaction.length, 1);
});

test('a client approve racing a client reject: the first decision stands, never both', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ type: 'DURATION', budgetDelta: null, durationDeltaDays: 3 })] });
	const results = await Promise.allSettled([svc.respondToAmendment('client-1', 'amend-1', 'approve'), svc.respondToAmendment('client-1', 'amend-1', 'reject')]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	const status = amendmentOf(world).status;
	assert.ok(status === 'APPROVED' || status === 'REJECTED');
	assert.equal(contractOf(world).durationDays, status === 'APPROVED' ? 17 : 14);
});

// ---------- concurrency with stage approval / dispute / contract state ----------
test('a stage approved right before the amendment applies: the released stage and the escrow release stay untouched, the new stage is appended', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()] });
	await svc.initPaymentAuthorization('client-1', 'amend-1');
	const code = lastOtpCode(world);
	world.hooks.onTransactionStart = (db: any) => {
		// simulates a committed stage approval + release between the pre-read and the amendment transaction
		const s1 = world.tables.projectStage.find(s => s.id === 'stage-1')!; s1.status = 'APPROVED'; s1.approvedAt = new Date();
		world.tables.projectStage.find(s => s.id === 'stage-2')!.status = 'IN_PROGRESS';
		Object.assign(world.tables.escrow[0], { releasedAmount: 10, platformCommissionAmount: 1.28, providerNetReleasedAmount: 8.72 });
		world.hooks.onTransactionStart = undefined;
	};
	const approvedBefore = JSON.stringify(world.tables.projectStage.find(s => s.id === 'stage-1'));
	await svc.respondToAmendment('client-1', 'amend-1', 'approve', code);
	const stages = stagesOf(world);
	assert.deepEqual(stages.map(s => s.amount), [10, 10, 5]);
	assert.equal(JSON.stringify(stages[0]).includes('"APPROVED"'), true);
	assert.equal(stages[0].percentage, 50, 'approved stage keeps its own percentage');
	assert.equal(escrowOf(world).releasedAmount, 10);
	assert.equal(escrowOf(world).platformCommissionAmount, 1.28);
	assert.equal(escrowOf(world).providerNetReleasedAmount, 8.72);
	assert.equal(escrowOf(world).amount, 25);
	assert.equal(approvedBefore.length > 0, true);
	// percentages: approved keeps 50, the unreleased ones share the remaining 50
	assert.ok(Math.abs(stages.reduce((s, x) => s + x.percentage, 0) - 100) <= 0.01);
});

test('the final stage approved right before: the contract is COMPLETED, so the amendment is refused (409) and nothing is charged', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()] });
	await svc.initPaymentAuthorization('client-1', 'amend-1');
	const code = lastOtpCode(world);
	world.hooks.onTransactionStart = () => { world.tables.contract[0].status = 'COMPLETED'; world.tables.escrow[0].status = 'RELEASED'; world.hooks.onTransactionStart = undefined; };
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', code), 409, /العقد غير نشط/);
	assert.equal(walletOf(world), 100);
	assert.equal(stagesOf(world).length, 2);
	assert.equal(amendmentOf(world).status, 'PENDING_OTHER_PARTY');
});

test('a dispute opened right before the amendment applies blocks it (409); RESOLVED / REJECTED disputes do not', async (t) => {
	for (const status of ['OPEN', 'UNDER_REVIEW']) {
		const { world, svc } = await setup(t, { amendments: [amendmentRow({ type: 'DURATION', budgetDelta: null, durationDeltaDays: 2 })], disputes: [{ id: 'd1', projectId: 'project-1', status }] });
		const before = snapshotMoney(world);
		await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve'), 409, /نزاع/);
		assert.equal(snapshotMoney(world), before);
		assert.equal(amendmentOf(world).status, 'PENDING_OTHER_PARTY');
	}
	for (const status of ['RESOLVED', 'REJECTED']) {
		const { world, svc } = await setup(t, { amendments: [amendmentRow({ type: 'DURATION', budgetDelta: null, durationDeltaDays: 2 })], disputes: [{ id: 'd1', projectId: 'project-1', status }] });
		await svc.respondToAmendment('client-1', 'amend-1', 'approve');
		assert.equal(contractOf(world).durationDays, 16);
	}
});

test('asking for a payment code while a dispute is open is refused too', async (t) => {
	const { svc } = await setup(t, { amendments: [amendmentRow()], disputes: [{ id: 'd1', projectId: 'project-1', status: 'OPEN' }] });
	await refused(svc.initPaymentAuthorization('client-1', 'amend-1'), 409, /نزاع/);
});

test('contract not ACTIVE or escrow not HELD: refused (409), nothing changes', async (t) => {
	for (const over of [{ contract: { status: 'DISPUTED' } }, { contract: { status: 'COMPLETED' } }, { escrow: { status: 'RELEASED' } }, { escrow: { status: 'PENDING' } }]) {
		const { world, svc } = await setup(t, { ...over, amendments: [amendmentRow({ type: 'DURATION', budgetDelta: null, durationDeltaDays: 2 })] });
		const before = snapshotMoney(world);
		await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve'), 409);
		assert.equal(snapshotMoney(world), before);
	}
});

test('legacy escrow (no fee-policy-v2 snapshot): a BUDGET amendment is refused with a clear message; a duration-only one still applies', async (t) => {
	const legacy = { feePolicyVersion: null, providerCommissionRateSnapshot: null, providerCommissionLevelSnapshot: null, amount: 22.6 };
	const a = await setup(t, { escrow: legacy, amendments: [amendmentRow(), amendmentRow({ id: 'amend-2', type: 'DURATION', budgetDelta: null, durationDeltaDays: 2 })] });
	await refused(a.svc.initPaymentAuthorization('client-1', 'amend-1'), 409, /عقد قديم/);
	a.world.tables.otpVerification.push(otpRow());
	const before = snapshotMoney(a.world);
	await refused(a.svc.respondToAmendment('client-1', 'amend-1', 'approve', '123456'), 409, /عقد قديم/);
	assert.equal(snapshotMoney(a.world), before);
	await a.svc.respondToAmendment('client-1', 'amend-2', 'approve');
	assert.equal(contractOf(a.world).durationDays, 16);
	assert.equal(escrowOf(a.world).amount, 22.6);
});

// ---------- duration / scope / mixed ----------
test('duration +3: contract days and the stage days move together; no money, no wallet, no OTP', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ type: 'DURATION', budgetDelta: null, durationDeltaDays: 3 })] });
	const before = JSON.stringify({ e: escrowOf(world), u: world.tables.user, tx: world.tables.walletTransaction });
	const out = await svc.respondToAmendment('client-1', 'amend-1', 'approve');
	assert.equal(out.effect, 'APPLIED');
	assert.equal(contractOf(world).durationDays, 17);
	assert.equal(stagesOf(world).reduce((s, x) => s + x.days, 0), 17);
	assert.deepEqual(stagesOf(world).map(s => s.amount), [10, 10]);
	assert.equal(JSON.stringify({ e: escrowOf(world), u: world.tables.user, tx: world.tables.walletTransaction }), before);
	assert.equal(contractOf(world).price, 20);
});

test('duration -3 reduces the unreleased stages (each keeps at least 1 day); below 1 day or below the elapsed days is refused', async (t) => {
	const a = await setup(t, { amendments: [amendmentRow({ type: 'DURATION', budgetDelta: null, durationDeltaDays: -3 })] });
	await a.svc.respondToAmendment('client-1', 'amend-1', 'approve');
	assert.equal(contractOf(a.world).durationDays, 11);
	assert.equal(stagesOf(a.world).reduce((s, x) => s + x.days, 0), 11);
	assert.ok(stagesOf(a.world).every(s => s.days >= 1));
	for (const delta of [-14, -13]) {
		const b = await setup(t, { amendments: [amendmentRow({ type: 'DURATION', budgetDelta: null, durationDeltaDays: delta })] });
		const before = snapshotMoney(b.world);
		await refused(b.svc.respondToAmendment('client-1', 'amend-1', 'approve'), 409);
		assert.equal(snapshotMoney(b.world), before);
	}
});

test('scope addendum is versioned: Contract.termsVersion and one terms row per applied addendum; no money', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ type: 'SCOPE', budgetDelta: null, description: 'إضافة صفحة جديدة للموقع' }), amendmentRow({ id: 'amend-2', type: 'SCOPE', budgetDelta: null, description: 'إضافة لغة ثانية' })] });
	await svc.respondToAmendment('client-1', 'amend-1', 'approve');
	await svc.respondToAmendment('client-1', 'amend-2', 'approve');
	assert.equal(contractOf(world).termsVersion, 3);
	assert.deepEqual(world.tables.contractTermsVersion.map(v => [v.version, v.addendumText, v.amendmentId]), [[2, 'إضافة صفحة جديدة للموقع', 'amend-1'], [3, 'إضافة لغة ثانية', 'amend-2']]);
	assert.equal(contractOf(world).price, 20);
	assert.equal(walletOf(world), 100);
});

test('MIXED applies every part together: money + new stage with the days + addendum', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ type: 'MIXED', budgetDelta: 5, durationDeltaDays: 2, description: 'نطاق إضافي' })] });
	await approveIncreaseAsClient(svc, world);
	assert.equal(contractOf(world).price, 25);
	assert.equal(contractOf(world).durationDays, 16);
	assert.equal(contractOf(world).termsVersion, 2);
	const stages = stagesOf(world);
	assert.equal(stages[2].days, 2);
	assert.equal(stages.reduce((s, x) => s + x.days, 0), 16);
	assertInvariant(world);
});

test('MIXED is all-or-none: a part that cannot apply rolls back the part that already ran (wallet debit, escrow, addendum)', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ type: 'MIXED', budgetDelta: 5, durationDeltaDays: -13, description: 'نطاق' })] });
	await svc.initPaymentAuthorization('client-1', 'amend-1');
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', lastOtpCode(world)), 409);
	assert.equal(snapshotMoney(world), before);
	assert.equal(amendmentOf(world).status, 'PENDING_OTHER_PARTY');
	assert.equal(amendmentOf(world).appliedAt, null);
	assert.equal(world.tables.otpVerification.length, 1, 'the code survives a refused approval');
});

test('a contract with no stage rows yet gets its stage plan first, then the amendment applies', async (t) => {
	const { world, svc } = await setup(t, { stages: [], contract: { project: { description: 'وصف' }, offerId: null, terms: null }, amendments: [amendmentRow()] });
	await approveIncreaseAsClient(svc, world);
	assert.deepEqual(stagesOf(world).map(s => s.amount), [20, 5]);
	assertInvariant(world);
});

// ---------- budget decrease ----------
test('decrease -4 (client-raised, provider approves): refund to the client wallet, the LAST unreleased stage shrinks, escrow and contract follow; no OTP', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1', budgetDelta: -4 })] });
	const out = await svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve');
	assert.equal(out.effect, 'APPLIED');
	assert.equal(walletOf(world), 104);
	assert.deepEqual([world.tables.walletTransaction[0].type, world.tables.walletTransaction[0].amount, world.tables.walletTransaction[0].referenceId], ['AMENDMENT_REFUND', 4, 'amend-1']);
	assert.deepEqual(stagesOf(world).map(s => s.amount), [10, 6]);
	assert.equal(contractOf(world).price, 16);
	assert.equal(escrowOf(world).amount, 16);
	assertInvariant(world);
	assert.equal(escrowOf(world).providerCommissionRateSnapshot, 12.75);
});

test('decrease never touches a stage that is submitted / approved, and never goes below what is released', async (t) => {
	const stages = [
		{ id: 'stage-1', contractId: 'contract-abcdef123', stepOrder: 1, title: 'أ', days: 7, percentage: 50, amount: 10, status: 'APPROVED', amendmentId: null, deliveries: [{ id: 'd' }] },
		{ id: 'stage-2', contractId: 'contract-abcdef123', stepOrder: 2, title: 'ب', days: 7, percentage: 50, amount: 10, status: 'SUBMITTED', amendmentId: null, deliveries: [{ id: 'd2' }] }
	];
	const a = await setup(t, { stages, escrow: { releasedAmount: 10, platformCommissionAmount: 1.28, providerNetReleasedAmount: 8.72 }, amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1', budgetDelta: -2 })] });
	const before = snapshotMoney(a.world);
	await refused(a.svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), 409, /غير المسلَّمة/);
	assert.equal(snapshotMoney(a.world), before);

	// below the released gross
	const b = await setup(t, { escrow: { releasedAmount: 10, platformCommissionAmount: 1.28, providerNetReleasedAmount: 8.72 }, stages: [{ ...stages[0] }, { ...stages[1], status: 'IN_PROGRESS', deliveries: [] }], amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1', budgetDelta: -11 })] });
	await refused(b.svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), 409, /المُفرَج/);
	assert.equal(walletOf(b.world), 100);

	// a valid decrease with one released stage: only the open stage changes, the approved one is byte-for-byte the same
	const c = await setup(t, { escrow: { releasedAmount: 10, platformCommissionAmount: 1.28, providerNetReleasedAmount: 8.72 }, stages: [{ ...stages[0] }, { ...stages[1], status: 'IN_PROGRESS', deliveries: [] }], amendments: [amendmentRow({ requestedByRole: 'CLIENT', requestedById: 'client-1', budgetDelta: -4 })] });
	const approvedBefore = JSON.stringify(stagesOf(c.world)[0]);
	await c.svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve');
	assert.equal(JSON.stringify(stagesOf(c.world)[0]), approvedBefore);
	assert.deepEqual(stagesOf(c.world).map(s => s.amount), [10, 6]);
	assert.equal(escrowOf(c.world).releasedAmount, 10);
	assert.equal(escrowOf(c.world).platformCommissionAmount, 1.28);
	assert.equal(contractOf(c.world).price, 16);
	// the commission of the remaining stage follows the cumulative rule: 16 * 12.75% = 2.04, so 0.76 is left for the last stage
	const rest = splitRelease({ grossReleasedBefore: 10, commissionTotalBefore: 1.28, grossReleasedAfter: 16, ratePercent: 12.75 });
	assert.deepEqual([rest.commission, rest.net, rest.commissionTotalAfter], [0.76, 5.24, 2.04]);
});

test('a decrease asked by the provider needs the client\'s approval, with no code', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ budgetDelta: -3 })] });
	await svc.respondToAmendment('client-1', 'amend-1', 'approve');
	assert.equal(walletOf(world), 103);
	assert.equal(contractOf(world).price, 17);
	assertInvariant(world);
});

// ---------- the money rules after an increase ----------
test('commission after +5: the snapshot rate is kept and the cumulative method gives 1.28 / 1.27 / 0.64 = 3.19 (net 21.81)', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow()] });
	await approveIncreaseAsClient(svc, world);
	const rate = escrowOf(world).providerCommissionRateSnapshot;
	assert.equal(rate, 12.75);
	let released = 0; let commission = 0; const parts: number[] = []; let net = 0;
	for (const stage of stagesOf(world)) {
		const split = splitRelease({ grossReleasedBefore: released, commissionTotalBefore: commission, grossReleasedAfter: released + stage.amount, ratePercent: rate });
		released = split.grossReleasedAfter; commission = split.commissionTotalAfter; parts.push(split.commission); net += split.net;
	}
	assert.deepEqual(parts, [1.28, 1.27, 0.64]);
	assert.equal(cents(commission), 3.19);
	assert.equal(cents(net), 21.81);
	assert.equal(released, contractOf(world).price);
});

test('a released stage and its amounts are never modified by a later increase', async (t) => {
	const stages = [
		{ id: 'stage-1', contractId: 'contract-abcdef123', stepOrder: 1, title: 'أ', days: 7, percentage: 50, amount: 10, status: 'APPROVED', approvedAt: new Date('2026-02-02'), amendmentId: null, deliveries: [{ id: 'd' }] },
		{ id: 'stage-2', contractId: 'contract-abcdef123', stepOrder: 2, title: 'ب', days: 7, percentage: 50, amount: 10, status: 'IN_PROGRESS', amendmentId: null, deliveries: [] }
	];
	const { world, svc } = await setup(t, { stages, escrow: { releasedAmount: 10, platformCommissionAmount: 1.28, providerNetReleasedAmount: 8.72 }, amendments: [amendmentRow()] });
	const releasedBefore = JSON.stringify(stagesOf(world)[0]);
	const escrowBefore = escrowOf(world);
	await approveIncreaseAsClient(svc, world);
	assert.equal(JSON.stringify(stagesOf(world)[0]), releasedBefore);
	for (const k of ['releasedAmount', 'platformCommissionAmount', 'providerNetReleasedAmount', 'providerCommissionRateSnapshot', 'feePolicyVersion']) assert.equal(escrowOf(world)[k], escrowBefore[k], k);
	assert.deepEqual(stagesOf(world).map(s => s.amount), [10, 10, 5]);
	assert.equal(escrowOf(world).amount, 25);
});

test('legacy APPROVED rows (appliedAt NULL) stay recorded-only: listed as RECORD_ONLY, never re-applied', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow({ status: 'APPROVED', respondedAt: new Date() })] });
	const [row] = await svc.listAmendments('client-1');
	assert.equal(row.effect, 'RECORD_ONLY');
	assert.match(row.effectNote, /يُسجَّل للمتابعة فقط/);
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendment('client-1', 'amend-1', 'approve', '123456'), 409, /مسبقًا/);
	assert.equal(snapshotMoney(world), before);
});

test('the payload tells the truth per state: PENDING / APPLIED / NONE, with needsClientPayment on increases', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow(), amendmentRow({ id: 'amend-2', type: 'DURATION', budgetDelta: null, durationDeltaDays: 2 }), amendmentRow({ id: 'amend-3', status: 'REJECTED' })] });
	await svc.respondToAmendment('client-1', 'amend-2', 'approve');
	const rows = await svc.listAmendments('client-1');
	const by = (id: string) => rows.find((r: any) => r.id === id);
	assert.deepEqual([by('amend-1').effect, by('amend-1').needsClientPayment], ['PENDING', true]);
	assert.doesNotMatch(by('amend-1').effectNote, /يُسجَّل للمتابعة فقط/);
	assert.deepEqual([by('amend-2').effect, by('amend-2').durationBefore, by('amend-2').durationAfter, by('amend-2').needsClientPayment], ['APPLIED', 14, 16, false]);
	assert.equal(by('amend-3').effect, 'NONE');
	assert.ok(world);
});

// ---------- ownership / roles ----------
test('ownership and roles: nobody answers or authorizes on a contract that is not theirs, and nobody answers their own request', async (t) => {
	const { world, svc } = await setup(t, { amendments: [amendmentRow(), amendmentRow({ id: 'amend-2', requestedByRole: 'CLIENT', requestedById: 'client-1' })] });
	const before = snapshotMoney(world);
	await refused(svc.respondToAmendment('client-9', 'amend-1', 'approve', '123456'), 403);
	await refused(svc.respondToAmendment('client-1', 'amend-2', 'approve', '123456'), 403, /رفعته أنت/);
	await refused(svc.respondToAmendmentAsProvider('provider-9', 'amend-2', 'approve'), 403);
	await refused(svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), 403, /رفعته أنت/);
	await refused(svc.initPaymentAuthorization('client-9', 'amend-1'), 403);
	await refused(svc.authorizeFunding('client-9', 'amend-2', '123456'), 403);
	await refused(svc.authorizeFunding('client-1', 'amend-1', '123456'), 400, /التي رفعها العميل/);
	assert.equal(snapshotMoney(world), before);
});

test('a payment code is required only where money moves in: duration/scope/decrease never ask for one', async (t) => {
	const { svc } = await setup(t, { amendments: [amendmentRow({ type: 'DURATION', budgetDelta: null, durationDeltaDays: 1 }), amendmentRow({ id: 'amend-2', budgetDelta: -1 })] });
	await refused(svc.initPaymentAuthorization('client-1', 'amend-1'), 400, /لا يتطلب دفعًا/);
	await refused(svc.initPaymentAuthorization('client-1', 'amend-2'), 400, /لا يتطلب دفعًا/);
});

// ---------- static guards ----------
test('static: both respond paths go through applyAmendment; there is no other writer of price / escrow amount for amendments', () => {
	const svc = readFileSync(new URL('./project-amendment.service.ts', import.meta.url), 'utf8');
	assert.equal((svc.match(/applyAmendment\(tx/g) || []).length, 1, 'one call site (the shared approve())');
	assert.match(svc, /this\.approve\('CLIENT'/);
	assert.match(svc, /this\.approve\('PROVIDER'/);
	assert.doesNotMatch(svc, /walletBalance: \{ (decrement|increment|gte)/, 'the service never moves the wallet; only applyAmendment does, inside the transaction');
	const apply = readFileSync(new URL('./amendment-apply.service.ts', import.meta.url), 'utf8');
	assert.match(apply, /walletBalance: \{ gte: budget \}/, 'guarded decrement');
	assert.match(apply, /AMENDMENT_TOPUP/);
});

test('static: a stage approval takes the SAME contract lock first (contract row, then stages / escrow), and uses the committed price for the final release', () => {
	const progress = readFileSync(new URL('./project-progress.service.ts', import.meta.url), 'utf8');
	const txStart = progress.indexOf('const result = await prisma.$transaction(async tx => {');
	const lock = progress.indexOf('const contractLock = await tx.contract.updateMany', txStart);
	const firstStageWrite = progress.indexOf('tx.projectStage.updateMany', txStart);
	assert.ok(lock > txStart && lock < firstStageWrite);
	assert.match(progress, /grossReleasedAfter: livePrice/);
	const apply = readFileSync(new URL('./amendment-apply.service.ts', import.meta.url), 'utf8');
	assert.ok(apply.indexOf('tx.contract.updateMany') < apply.indexOf('tx.projectStage.findMany'));
});

test('static: the dispute check is one isolated helper', () => {
	const guard = readFileSync(new URL('./amendment-dispute-guard.ts', import.meta.url), 'utf8');
	assert.match(guard, /DisputeStatus\.OPEN, DisputeStatus\.UNDER_REVIEW/);
	assert.match(guard, /export async function hasActiveDispute\(projectId: string/);
});
