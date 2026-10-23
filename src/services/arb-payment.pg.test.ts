import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * REAL PostgreSQL (isolated local :55432, database qa_iso_arb) + SIMULATED bank (arb-sim-bank.testutil.ts). No real bank, no real money.
 * Proves the ARB wallet-deposit rules: server-derived amount, one open attempt, verification before credit, exactly-once credit,
 * out-of-order / duplicate / late callbacks, lost answers, database failure during apply.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud';
process.env.CLOUDINARY_API_KEY ??= '123456789012345';
process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';
process.env.FRONTEND_URL ??= 'https://front.test';

async function env(cfgOver: any = {}) {
	const { prisma } = await import('../config/db');
	const { ArbPaymentService } = await import('./arb-payment.service');
	const { SimBank, testConfig } = await import('./arb-sim-bank.testutil');
	// the migration's partial unique index (Prisma cannot express it; `db push` does not create it) — applied from the migration file itself
	const sql = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261023100000_arb_payments/migration.sql'), 'utf8');
	const idx = sql.slice(sql.indexOf('CREATE UNIQUE INDEX "ux_arb_payments_one_open_per_user"')).split(';')[0].trim().replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX IF NOT EXISTS');
	await prisma.$executeRawUnsafe(idx);
	// the database-level financial invariant (also from the migration file)
	const chk = sql.slice(sql.indexOf('ALTER TABLE "arb_payments" ADD CONSTRAINT "arb_payments_applied_consistent"')).split(';')[0].trim();
	const have: any[] = await prisma.$queryRawUnsafe("SELECT 1 AS one FROM pg_constraint WHERE conname = 'arb_payments_applied_consistent'");
	if (have.length === 0) await prisma.$executeRawUnsafe(chk);
	const bank = new SimBank();
	const clock = { t: Date.now() };
	const svc = new ArbPaymentService({ prisma: prisma as any, http: bank, config: () => testConfig(cfgOver), now: () => new Date(clock.t) });
	const mkUser = async () => prisma.user.create({ data: { id: randomUUID(), accountType: 'CLIENT_INDIVIDUAL', firstName: 'c', lastName: 'q', email: `arb-${randomUUID().slice(0, 8)}@pg.test`, roles: ['CLIENT'], activeRole: 'CLIENT', walletBalance: 0 } as any });
	const balance = async (id: string) => Number((await prisma.user.findUniqueOrThrow({ where: { id } })).walletBalance);
	const walletRows = (userId: string) => prisma.walletTransaction.count({ where: { userId, paymentMethod: 'ARB_CARD' } });
	const row = (id: string) => prisma.arbPayment.findUniqueOrThrow({ where: { id } });
	/** user pays on the bank page; the browser returns with the bank's trandata */
	const payAndReturn = async (ref: string, result = 'CAPTURED') => {
		const a = await row(ref);
		bank.settle(a.bankPaymentId!, result);
		return svc.handleReturn({ paymentId: a.bankPaymentId!, trandata: bank.trandataFor(bank.byPayment(a.bankPaymentId!)) });
	};
	return { prisma, svc, bank, clock, mkUser, balance, walletRows, row, payAndReturn };
}
const IP = '203.0.113.7';
const fixtureNote = 'fixture numbers only (fee 2.5 %, 3.75 SAR/USD): no fee or rate is approved';

test('PG: amount, currency and fee are derived on the server; the bank receives exactly amountSar in 682; the browser only sends net USD', opts, async () => {
	const { svc, bank, mkUser, row } = await env();
	const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal(v.state, 'WAITING_PAGE');
	assert.match(v.redirectUrl!, /^https:\/\/sim-bank\.test\/pg\/paymentpage\.htm\?PaymentID=\d+$/);
	const a = await row(v.reference);
	// FIXTURE inputs (no fee/rate is approved): fee 2.5 %, 3.75 SAR/USD: gross = 100 / 0.975 = 102.56 ; fee 2.56 ; x 3.75 = 384.60 SAR
	assert.equal(a.grossUsd.toFixed(2), '102.56'); assert.equal(a.feeUsd.toFixed(2), '2.56'); assert.equal(a.amountSar.toFixed(2), '384.60'); assert.equal(a.currencyCode, '682');
	assert.equal(bank.log[0].plain.amt, '384.60'); assert.equal(bank.log[0].plain.currencyCode, '682');
	assert.equal(bank.log[0].plain.udf1, a.id); assert.equal(bank.log[0].plain.udf3, u.id);
	assert.equal(bank.log[0].headers['X-FORWARDED-FOR'], IP);
	assert.match(bank.log[0].plain.responseURL, /^https:\/\/app\.test\/api\/payments\/arb\/response$/);
	assert.match(bank.log[0].plain.errorURL, /^https:\/\/app\.test\/api\/payments\/arb\/error$/);
	assert.match(a.trackId, /^\d{16}$/);
	await assert.rejects(svc.initiate(u.id, 10, IP), /بين 50/); // bounds are enforced server-side too
	await assert.rejects(svc.initiate(u.id, NaN, IP));
});

test('PG: not configured / switched off / no customer address -> clear refusal, no row, no bank call', opts, async () => {
	for (const over of [{ enabled: false }, { sarPerUsd: 0 }, { feePercent: null }, { allowedUserIds: [] }, { resourceKey: 'short' }, { hostedTokenUrl: '' }]) {
		const { svc, bank, mkUser, prisma } = await env(over); const u = await mkUser();
		await assert.rejects(svc.initiate(u.id, 100, IP), (e: any) => e.statusCode === 503 || e.status === 503 || /غير متاح/.test(e.message));
		assert.equal(bank.creates, 0); assert.equal(await prisma.arbPayment.count({ where: { userId: u.id } }), 0);
	}
	const { svc, mkUser } = await env(); const u = await mkUser();
	await assert.rejects(svc.initiate(u.id, 100, 'unknown'), /عنوانك/);
});

test('PG: double click / 12 concurrent starts -> ONE row, ONE bank create call, everybody gets the same attempt', opts, async () => {
	const { svc, bank, mkUser, prisma } = await env(); const u = await mkUser();
	bank.delayCreateMs = 60;
	const views = await Promise.all(Array.from({ length: 12 }, () => svc.initiate(u.id, 100, IP).catch((e: any) => ({ error: String(e?.message) }))));
	assert.equal(bank.creates, 1);
	assert.equal(await prisma.arbPayment.count({ where: { userId: u.id } }), 1);
	const refs = new Set(views.map((v: any) => v.reference).filter(Boolean));
	assert.equal(refs.size, 1, JSON.stringify(views));
	assert.equal(views.filter((v: any) => v.error).length, 0);
});

test('PG: a second start while the first is still open returns the SAME page, no second bank call', opts, async () => {
	const { svc, bank, mkUser } = await env(); const u = await mkUser();
	const a = await svc.initiate(u.id, 100, IP); const b = await svc.initiate(u.id, 100, IP);
	assert.equal(a.reference, b.reference); assert.equal(a.redirectUrl, b.redirectUrl); assert.equal(bank.creates, 1);
});

test('PG: the bank refuses the create -> FAILED state, nothing to pay, a new attempt may start; no money touched', opts, async () => {
	const { svc, bank, mkUser, balance } = await env(); const u = await mkUser();
	bank.rejectCreate = 'IPAY0100024';
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal(v.state, 'FAILED'); assert.equal(v.redirectUrl, null); assert.ok(!/IPAY/.test(v.message + v.nextStep));
	bank.rejectCreate = null;
	const w = await svc.initiate(u.id, 100, IP);
	assert.equal(w.state, 'WAITING_PAGE'); assert.notEqual(w.reference, v.reference); assert.equal(await balance(u.id), 0);
});

test('PG: LOST create answer: «verifying» while in flight; afterwards it STILL blocks a new start (time and our own timeout prove nothing: the bank may have kept the payment payable); a late capture is applied once', opts, async () => {
	const { svc, bank, mkUser, clock, row, balance, prisma, walletRows } = await env(); const u = await mkUser();
	await prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED','AUTH_ONLY')`);
	bank.dropCreateAnswer = true;
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal(v.state, 'VERIFYING'); assert.equal(v.redirectUrl, null);
	assert.equal((await row(v.reference)).status, 'CREATE_UNKNOWN');
	bank.dropCreateAnswer = false;
	const again = await svc.initiate(u.id, 100, IP);
	assert.equal(again.reference, v.reference); assert.equal(bank.creates, 1); // young unknown create: not judged, not duplicated
	for (const step of [100_000, 3_600_000, 24 * 3_600_000]) { // our call can no longer be pending, but the bank's processing may continue: still no new start
		clock.t += step;
		const blocked = await svc.initiate(u.id, 100, IP);
		assert.equal(blocked.state, 'UNSETTLED', `after +${step} ms`); assert.equal(blocked.redirectUrl, null); assert.equal(bank.creates, 1);
		assert.equal((await row(v.reference)).bankFinalAt, null);
	}
	// the bank DOES know it (processed, answer lost) and it is paid late: found by TrackID, applied once
	bank.settle(bank.txns[0].paymentId, 'CAPTURED'); clock.t += 25 * 3_600_000;
	await svc.reconcileOnce();
	assert.equal((await row(v.reference)).status, 'CAPTURED_APPLIED'); assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1);
	assert.equal((await svc.initiate(u.id, 100, IP)).state, 'WAITING_PAGE'); // the bank spoke: a new start is possible
});

test('PG: lost create answer where the bank answers «no record»: NOT settled by time or by the bank\'s no-record error alone; it is released only when the bank has CONFIRMED that code (ARB_BANK_RELEASE_CODES) and a full window passed', opts, async () => {
	const lostCreate = async (cfg: any) => {
		const e = await env(cfg); const u = await e.mkUser();
		await e.prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED','AUTH_ONLY')`);
		(e.bank as any).create = async () => { throw new Error('ETIMEDOUT'); }; // our request may or may not have reached the bank
		const v = await e.svc.initiate(u.id, 100, IP); assert.equal((await e.row(v.reference)).status, 'CREATE_UNKNOWN');
		delete (e.bank as any).create; e.bank.failInquiry = 'notfound';
		return { ...e, u, v };
	};
	// no confirmed code: forever unsettled, blocked, still reconciled
	const n = await lostCreate({});
	for (const step of [100_000, 31 * 60_000, 24 * 3_600_000]) { n.clock.t += step; assert.equal((await n.svc.initiate(n.u.id, 100, IP)).state, 'UNSETTLED'); }
	await n.svc.reconcileOnce();
	const still = await n.row(n.v.reference); assert.ok(['CREATE_UNKNOWN', 'UNCONFIRMED'].includes(still.status)); assert.equal(still.bankFinalAt, null); assert.equal(n.bank.creates, 0);
	// code confirmed by the bank: released only after the full window
	const c = await lostCreate({ releaseCodes: ['IPAY0100054'] });
	c.clock.t += 100_000; assert.equal((await c.svc.initiate(c.u.id, 100, IP)).state, 'UNSETTLED'); // the window has not passed yet
	c.clock.t += 31 * 60_000; c.bank.failInquiry = 'notfound';
	const w = await c.svc.initiate(c.u.id, 100, IP);
	assert.equal(w.state, 'WAITING_PAGE'); const closed = await c.row(c.v.reference); assert.equal(closed.status, 'CREATE_REJECTED'); assert.ok(closed.bankFinalAt);
});

test('PG: happy path - return + verified CAPTURED credits the NET USD once, with the full audit trail', opts, async () => {
	const { svc, mkUser, balance, walletRows, row, payAndReturn, prisma } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP);
	const out = await payAndReturn(v.reference);
	assert.equal(out.reference, v.reference);
	const a = await row(v.reference);
	assert.equal(a.status, 'CAPTURED_APPLIED'); assert.ok(a.appliedAt && a.verifiedAt && a.bankTransId && a.walletTxId);
	assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1);
	const wt = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: a.walletTxId! } });
	assert.equal(wt.currency, 'USD'); assert.equal(wt.referenceId, `arb:${a.bankTransId}`);
	const meta: any = wt.metadata; assert.equal(meta.chargedSar, 384.6); assert.equal(meta.currencyCode, '682'); assert.equal(meta.fxSarPerUsd, 3.75); assert.equal(meta.netCredited, 100);
	const st = await svc.statusFor(u.id, v.reference);
	assert.equal(st.state, 'PAID'); assert.equal(st.creditedUsd, 100); assert.equal(st.chargedSar, 384.6);
	assert.equal(await prisma.accountAuditLog.count({ where: { userId: u.id, eventType: 'WALLET_DEPOSIT_COMPLETED' } }), 1);
});

test('PG: the browser coming back (even with a forged "success") is NOT proof: no capture at the bank -> no credit', opts, async () => {
	const { svc, bank, mkUser, balance, row } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	const { encryptTrandata } = await import('../utils/arb-crypto'); const { TEST_KEY } = await import('./arb-sim-bank.testutil');
	const forged = encryptTrandata(JSON.stringify([{ paymentId: a.bankPaymentId, result: 'CAPTURED', transId: '999', trackId: a.trackId, amt: '384.60', udf1: a.id, actionCode: '1' }]), TEST_KEY);
	await svc.handleReturn({ paymentId: a.bankPaymentId!, trandata: forged }); // even a perfectly formed trandata only triggers the Inquiry
	assert.ok(bank.inquiries >= 1);
	assert.equal(await balance(u.id), 0); assert.notEqual((await row(v.reference)).status, 'CAPTURED_APPLIED');
	await svc.handleReturn({ paymentId: a.bankPaymentId!, trandata: 'not-hex' });
	await svc.handleReturn({ paymentId: a.bankPaymentId! });
	assert.equal(await balance(u.id), 0);
});

test('PG: someone else returning with my payment id credits only the attempt owner, never the caller', opts, async () => {
	const { svc, mkUser, balance, row, bank } = await env(); const a = await mkUser(); const b = await mkUser();
	const va = await svc.initiate(a.id, 100, IP); const ra = await row(va.reference);
	bank.settle(ra.bankPaymentId!, 'CAPTURED');
	await svc.handleReturn({ paymentId: ra.bankPaymentId! });
	assert.equal(await balance(a.id), 100); assert.equal(await balance(b.id), 0);
	await assert.rejects(svc.statusFor(b.id, va.reference), /غير موجودة/);
});

test('PG: amount / currency / ids that do not match THIS attempt are never credited', opts, async () => {
	for (const bad of [{ amtOverride: '1.00' }, { amtOverride: '384.61' }, { udf1Override: 'another-attempt' }, { trackOverride: '111111111111111111' }, { paymentOverride: '999999999999999999' }, { actionOverride: '4' }]) {
		const { svc, bank, mkUser, balance, row } = await env(); const u = await mkUser();
		const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
		Object.assign(bank.byPayment(a.bankPaymentId!), bad);
		bank.settle(a.bankPaymentId!, 'CAPTURED');
		await svc.handleReturn({ paymentId: a.bankPaymentId! });
		assert.equal(await balance(u.id), 0, JSON.stringify(bad));
		assert.notEqual((await row(v.reference)).status, 'CAPTURED_APPLIED', JSON.stringify(bad));
	}
	// a different currency is detected through the echoed udf2 and the bank's own currency validation of the Inquiry
	const { svc, bank, mkUser, balance, row } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	bank.byPayment(a.bankPaymentId!).udf2 = '840'; bank.settle(a.bankPaymentId!, 'CAPTURED');
	await svc.handleReturn({ paymentId: a.bankPaymentId! });
	assert.equal(await balance(u.id), 0);
});

test('PG: APPROVED (authorization) is not a capture; declined stays declined; a late "captured" cannot revive a declined attempt', opts, async () => {
	const e1 = await env(); const u1 = await e1.mkUser();
	const v1 = await e1.svc.initiate(u1.id, 100, IP); await e1.payAndReturn(v1.reference, 'APPROVED');
	assert.equal((await e1.row(v1.reference)).status, 'AUTH_ONLY'); assert.equal(await e1.balance(u1.id), 0);
	assert.equal((await e1.svc.statusFor(u1.id, v1.reference)).state, 'REVIEW');
	// an authorization the bank holds is NOT a release: it stays unsettled, blocks a new purchase (REVIEW, not permission to pay again) and keeps being reconciled
	assert.equal((await e1.row(v1.reference)).bankFinalAt, null);
	e1.clock.t += 5_000; const hold = await e1.svc.initiate(u1.id, 100, IP);
	assert.equal(hold.state, 'REVIEW'); assert.equal(hold.reference, v1.reference); assert.equal(e1.bank.creates, 1);
	for (const step of [3_600_000, 30 * 24 * 3_600_000]) { e1.clock.t += step; assert.equal((await e1.svc.initiate(u1.id, 100, IP)).state, 'REVIEW'); }
	assert.equal(await e1.balance(u1.id), 0);
	// when the bank itself later captures it, it is credited once; only then can a new payment start
	e1.bank.settle((await e1.row(v1.reference)).bankPaymentId!, 'CAPTURED'); e1.clock.t += 25 * 3_600_000; await e1.svc.reconcileOnce();
	assert.equal(await e1.balance(u1.id), 100); assert.equal((await e1.svc.initiate(u1.id, 100, IP)).state, 'WAITING_PAGE');
	const e2 = await env(); const u2 = await e2.mkUser();
	const v2 = await e2.svc.initiate(u2.id, 100, IP); await e2.payAndReturn(v2.reference, 'NOT CAPTURED');
	assert.equal((await e2.row(v2.reference)).status, 'DECLINED'); assert.equal((await e2.svc.statusFor(u2.id, v2.reference)).state, 'DECLINED');
	const a2 = await e2.row(v2.reference); e2.bank.settle(a2.bankPaymentId!, 'CAPTURED');
	await e2.svc.handleReturn({ paymentId: a2.bankPaymentId! }); await e2.svc.verify(v2.reference);
	assert.equal((await e2.row(v2.reference)).status, 'DECLINED'); assert.equal(await e2.balance(u2.id), 0);
});

test('PG: an unknown result word is UNCONFIRMED, never paid and never failed', opts, async () => {
	const { svc, bank, mkUser, balance, row } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	bank.settle(a.bankPaymentId!, 'PROCESSING');
	await svc.handleReturn({ paymentId: a.bankPaymentId! });
	assert.equal((await row(v.reference)).status, 'UNCONFIRMED');
	const st = await svc.statusFor(u.id, v.reference);
	assert.equal(st.state, 'VERIFYING'); assert.ok(/لا تُعد الدفع/.test(st.nextStep)); assert.equal(await balance(u.id), 0);
});

test('PG: bank unreachable / garbage during Inquiry -> "verifying", NOT "failed"; verified later, credited once', opts, async () => {
	const { svc, bank, mkUser, balance, row, clock } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	bank.settle(a.bankPaymentId!, 'CAPTURED');
	for (const mode of ['timeout', 'garbage'] as const) {
		bank.failInquiry = mode; clock.t += 5_000;
		await svc.handleReturn({ paymentId: a.bankPaymentId! });
		const st = await svc.statusFor(u.id, v.reference);
		assert.equal(st.state, 'VERIFYING', mode); assert.notEqual(st.state, 'FAILED');
		assert.equal(await balance(u.id), 0);
	}
	bank.failInquiry = 'none'; clock.t += 5_000;
	await svc.handleReturn({ paymentId: a.bankPaymentId! });
	assert.equal((await row(v.reference)).status, 'CAPTURED_APPLIED'); assert.equal(await balance(u.id), 100);
});

test('PG: duplicate / concurrent callbacks (browser x6, notification x3, polls x4 at once) credit exactly ONCE', opts, async () => {
	const { svc, bank, mkUser, balance, walletRows, row, prisma } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	bank.settle(a.bankPaymentId!, 'CAPTURED');
	const td = bank.trandataFor(bank.byPayment(a.bankPaymentId!));
	await Promise.all([
		...Array.from({ length: 6 }, () => svc.handleReturn({ paymentId: a.bankPaymentId!, trandata: td })),
		...Array.from({ length: 3 }, () => svc.handleNotification({ paymentId: a.bankPaymentId!, trandata: td })),
		...Array.from({ length: 4 }, () => svc.statusFor(u.id, v.reference)),
		...Array.from({ length: 4 }, () => svc.verify(v.reference)),
	]);
	await svc.verify(v.reference);
	assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1);
	assert.equal(await prisma.accountAuditLog.count({ where: { userId: u.id, eventType: 'WALLET_DEPOSIT_COMPLETED' } }), 1);
	assert.equal(await prisma.notification.count({ where: { userId: u.id, title: 'تم إيداع الرصيد بنجاح' } }), 1);
	// opening the return link again / refreshing the page changes nothing
	for (let i = 0; i < 3; i++) await svc.handleReturn({ paymentId: a.bankPaymentId! });
	assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1);
});

test('PG: late callback after the user cancelled / the attempt expired still applies a VERIFIED capture (the bank took the money) - once', opts, async () => {
	const e1 = await env(); const u1 = await e1.mkUser();
	const v1 = await e1.svc.initiate(u1.id, 100, IP); const a1 = await e1.row(v1.reference);
	await e1.svc.handleError({ paymentId: a1.bankPaymentId! }); // user left the page: soft CANCELLED
	assert.equal((await e1.row(v1.reference)).status, 'CANCELLED'); assert.equal(await e1.balance(u1.id), 0);
	e1.bank.settle(a1.bankPaymentId!, 'CAPTURED'); e1.clock.t += 10_000;
	await e1.svc.handleReturn({ paymentId: a1.bankPaymentId! }); await e1.svc.handleReturn({ paymentId: a1.bankPaymentId! });
	assert.equal((await e1.row(v1.reference)).status, 'CAPTURED_APPLIED'); assert.equal(await e1.balance(u1.id), 100); assert.equal(await e1.walletRows(u1.id), 1);
	const e2 = await env(); const u2 = await e2.mkUser();
	const v2 = await e2.svc.initiate(u2.id, 100, IP); const a2 = await e2.row(v2.reference);
	e2.clock.t += 31 * 60_000; await e2.svc.statusFor(u2.id, v2.reference);
	assert.equal((await e2.row(v2.reference)).status, 'EXPIRED');
	e2.bank.settle(a2.bankPaymentId!, 'CAPTURED'); e2.clock.t += 10_000;
	await e2.svc.handleReturn({ paymentId: a2.bankPaymentId! });
	assert.equal(await e2.balance(u2.id), 100); assert.equal(await e2.walletRows(u2.id), 1);
});

test('PG: a late DECLINED/odd answer after the capture was applied changes nothing (terminal)', opts, async () => {
	const { svc, bank, mkUser, balance, row, payAndReturn, clock } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); await payAndReturn(v.reference);
	const a = await row(v.reference); bank.byPayment(a.bankPaymentId!).result = 'DECLINED'; clock.t += 10_000;
	await svc.handleReturn({ paymentId: a.bankPaymentId! }); await svc.verify(v.reference);
	assert.equal((await row(v.reference)).status, 'CAPTURED_APPLIED'); assert.equal(await balance(u.id), 100);
});

test('PG: database failure while applying -> NOTHING committed (no wallet row, no balance, not applied); the retry applies once', opts, async () => {
	const { svc, bank, mkUser, balance, walletRows, row, prisma, clock } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	bank.settle(a.bankPaymentId!, 'CAPTURED');
	const realUpdate = (prisma.user as any).update; let failed = 0;
	// the transaction callback receives its own tx client; make the balance increment fail ONCE (after the claim and the wallet row were written in the tx)
	const realTx = (prisma as any).$transaction.bind(prisma);
	(prisma as any).$transaction = async (fn: any, o?: any) => realTx(async (tx: any) => {
		const proxy = new Proxy(tx, { get: (t, k) => k === 'user' ? { ...t.user, update: async (...args: any[]) => { if (!failed++) throw new Error('simulated database failure'); return t.user.update(...args); } } : t[k] });
		return fn(proxy);
	}, o);
	await assert.rejects(svc.handleReturn({ paymentId: a.bankPaymentId! }), /simulated database failure/);
	assert.equal(await balance(u.id), 0); assert.equal(await walletRows(u.id), 0);
	assert.notEqual((await row(v.reference)).status, 'CAPTURED_APPLIED'); assert.equal((await row(v.reference)).appliedAt, null);
	assert.equal((await svc.statusFor(u.id, v.reference)).state === 'PAID', false);
	clock.t += 10_000;
	await svc.handleReturn({ paymentId: a.bankPaymentId! });
	assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1); assert.equal((await row(v.reference)).status, 'CAPTURED_APPLIED');
	(prisma as any).$transaction = realTx; (prisma.user as any).update = realUpdate;
});

test('PG: two attempts can never share one bank transaction id (unique) - the second is not credited', opts, async () => {
	const { svc, bank, mkUser, balance, row, prisma, clock } = await env(); const u1 = await mkUser(); const u2 = await mkUser();
	const v1 = await svc.initiate(u1.id, 100, IP); const v2 = await svc.initiate(u2.id, 100, IP);
	const a1 = await row(v1.reference); const a2 = await row(v2.reference);
	const tid = String(Date.now()) + String(Math.floor(Math.random() * 1000));
	bank.settle(a1.bankPaymentId!, 'CAPTURED', tid); bank.settle(a2.bankPaymentId!, 'CAPTURED', tid);
	await svc.handleReturn({ paymentId: a1.bankPaymentId! }); clock.t += 5_000;
	await svc.handleReturn({ paymentId: a2.bankPaymentId! });
	assert.equal(await balance(u1.id), 100); assert.equal(await balance(u2.id), 0);
	assert.equal(await prisma.walletTransaction.count({ where: { referenceId: `arb:${tid}` } }), 1);
	assert.notEqual((await row(v2.reference)).status, 'CAPTURED_APPLIED');
});

test('PG: notification (guide p.187-194): acknowledged only for a matching known attempt; mismatch / unknown are NOT acknowledged', opts, async () => {
	const { svc, bank, mkUser, row, balance } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	bank.settle(a.bankPaymentId!, 'CAPTURED');
	const good = bank.trandataFor(bank.byPayment(a.bankPaymentId!));
	const ok = await svc.handleNotification({ paymentId: a.bankPaymentId!, trandata: good });
	assert.equal(ok.ack, true); assert.equal(ok.responseUrl, 'https://app.test/api/payments/arb/response');
	assert.equal((await svc.handleNotification({ paymentId: a.bankPaymentId!, trandata: good })).ack, true); // idempotent
	Object.assign(bank.byPayment(a.bankPaymentId!), { amtOverride: '1.00' });
	assert.equal((await svc.handleNotification({ paymentId: a.bankPaymentId!, trandata: bank.trandataFor(bank.byPayment(a.bankPaymentId!)) })).ack, false);
	assert.equal((await svc.handleNotification({ paymentId: a.bankPaymentId!, trandata: 'zz' })).ack, false);
	Object.assign(bank.byPayment(a.bankPaymentId!), { amtOverride: undefined, paymentOverride: '1234567890123456', trackOverride: '123456789012345678' });
	assert.equal((await svc.handleNotification({ paymentId: '1234567890123456', trandata: bank.trandataFor(bank.byPayment(a.bankPaymentId!)) })).ack, false);
	assert.ok((await balance(u.id)) >= 0);
});

test('PG: statusFor is owner-only and shows safe Arabic text (no codes, no raw bank words)', opts, async () => {
	const { svc, mkUser, bank, row } = await env(); const u = await mkUser(); const x = await mkUser();
	const v = await svc.initiate(u.id, 100, IP);
	await assert.rejects(svc.statusFor(x.id, v.reference), /غير موجودة/);
	const a = await row(v.reference); bank.settle(a.bankPaymentId!, 'IPAY0100045 - DENIED BY RISK');
	await svc.handleReturn({ paymentId: a.bankPaymentId! });
	const st = await svc.statusFor(u.id, v.reference);
	assert.equal(st.state, 'DECLINED'); assert.ok(!/IPAY|DENIED|RISK|CAPTURED|APPROVED/.test(JSON.stringify(st)));
});

test('PG: the migration file really contains the one-open-attempt partial index and no destructive statement', opts, async () => {
	const sql = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261023100000_arb_payments/migration.sql'), 'utf8');
	assert.match(sql, /CREATE UNIQUE INDEX "ux_arb_payments_one_open_per_user"[\s\S]*WHERE "status" IN \('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','AUTH_ONLY'\)/);
	assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE|ALTER TABLE "(?!arb_payments)\w+")\b/i.test(sql.replace(/--.*$/gm, '').replace(/ON (DELETE|UPDATE) (CASCADE|RESTRICT|NO ACTION|SET NULL)/gi, '')));
});

test('PG: the quote is derived exactly like the charge, and openAttemptFor resumes the user\'s open attempt (refresh / reopen)', opts, async () => {
	const { svc, mkUser, row } = await env(); const u = await mkUser();
	const q = svc.quote(u.id, 100);
	assert.deepEqual(q, { netUsd: 100, feePercent: 2.5, feeUsd: 2.56, grossUsd: 102.56, chargedSar: 384.6, currency: 'SAR', sarPerUsd: 3.75 });
	assert.throws(() => svc.quote(u.id, 5), /بين 50/);
	assert.equal(await svc.openAttemptFor(u.id), null);
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal((await row(v.reference)).amountSar.toNumber(), q.chargedSar); // the quote and the charge never disagree
	const open = await svc.openAttemptFor(u.id);
	assert.equal(open?.reference, v.reference); assert.equal(open?.state, 'WAITING_PAGE');
});


test('PG: the rail is open ONLY to the listed user ids (UAT = QA accounts); anyone else sees it unavailable and reaches no bank call', opts, async () => {
	const { mkUser } = await env(); const qa = await mkUser(); const other = await mkUser();
	const e = await env({ allowedUserIds: [qa.id] });
	assert.equal(e.svc.isAvailable(qa.id), true); assert.equal(e.svc.isAvailable(other.id), false);
	await assert.rejects(e.svc.initiate(other.id, 100, IP), /لحسابك/); await assert.rejects(async () => e.svc.quote(other.id, 100), /لحسابك/);
	assert.equal(await e.svc.openAttemptFor(other.id), null); assert.equal(e.bank.creates, 0);
	assert.equal((await e.svc.initiate(qa.id, 100, IP)).state, 'WAITING_PAGE'); assert.equal(e.bank.creates, 1);
	// nobody listed = nobody
	const none = await env({ allowedUserIds: [] }); assert.equal(none.svc.isAvailable(qa.id), false);
});

test('PG: a private / loopback / missing customer address is refused (the bank would decline it); a public one is passed first in X-FORWARDED-FOR', opts, async () => {
	const { svc, bank, mkUser } = await env(); const u = await mkUser();
	for (const ip of ['unknown', '', '127.0.0.1', '10.1.2.3', '172.23.0.1', '192.168.1.5', '::1', 'fd00::1', '100.64.0.1', 'not-an-ip']) await assert.rejects(svc.initiate(u.id, 100, ip), /عنوانك/, ip);
	assert.equal(bank.creates, 0);
	await svc.initiate(u.id, 100, '198.51.100.20'); assert.equal(bank.log[0].headers['X-FORWARDED-FOR'], '198.51.100.20');
});

test('PG: while an attempt can still be collected a NEW one is BLOCKED (no override, no acknowledgement); the status can be refreshed; a late capture of the old one is credited; only then a new start is possible', opts, async () => {
	const { svc, bank, mkUser, balance, walletRows, row, clock } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	await svc.handleError({ paymentId: a.bankPaymentId! }); // the browser left the bank page (errorURL): LOCAL cancel only
	assert.equal((await row(v.reference)).status, 'CANCELLED'); assert.equal((await row(v.reference)).bankFinalAt, null);
	clock.t += 5_000;
	const blocked = await svc.initiate(u.id, 100, IP);
	assert.equal(blocked.state, 'UNSETTLED'); assert.equal(blocked.requiresAcknowledgement, false); assert.equal(blocked.previousReference, v.reference); assert.equal(bank.creates, 1);
	assert.match(blocked.nextStep, /تحديث الحالة/);
	assert.equal((await svc.initiate(u.id, 100, IP)).state, 'UNSETTLED'); assert.equal(bank.creates, 1); // asking again changes nothing
	clock.t += 5_000; const refreshed = await svc.statusFor(u.id, v.reference); // the «refresh status» button
	assert.equal(refreshed.bankFinal, false); assert.ok(['CANCELLED', 'EXPIRED', 'VERIFYING'].includes(refreshed.state));
	bank.settle(a.bankPaymentId!, 'CAPTURED'); clock.t += 5_000; // the old page is paid late
	const after = await svc.initiate(u.id, 100, IP);
	assert.equal(after.state, 'PAID'); assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1);
	const next = await svc.initiate(u.id, 100, IP); // the bank has spoken: a new start is now possible
	assert.equal(next.state, 'WAITING_PAGE'); assert.equal(bank.creates, 2);
});

test('PG: only the BANK settles an attempt: a bank decline (or an error code the bank confirmed) unlocks a new start; elapsed time, local expiry and an unconfirmed error code do not', opts, async () => {
	const e1 = await env(); const u1 = await e1.mkUser();
	const v1 = await e1.svc.initiate(u1.id, 100, IP); const a1 = await e1.row(v1.reference);
	e1.bank.settle(a1.bankPaymentId!, 'NOT CAPTURED'); e1.clock.t += 5_000;
	const n1 = await e1.svc.initiate(u1.id, 100, IP); // the bank gave a final refusal: no acknowledgement needed
	assert.equal(n1.state, 'WAITING_PAGE'); assert.ok((await e1.row(v1.reference)).bankFinalAt);
	// IPAY0100042 («PaymentId Expired», p.274) alone releases NOTHING: what it means for a payment that was already started is the bank's to confirm
	const e2 = await env(); const u2 = await e2.mkUser();
	const v2 = await e2.svc.initiate(u2.id, 100, IP); await e2.svc.handleError({ paymentId: (await e2.row(v2.reference)).bankPaymentId! });
	e2.bank.failInquiry = 'expired'; e2.clock.t += 5_000;
	const n2 = await e2.svc.initiate(u2.id, 100, IP);
	assert.equal(n2.state, 'UNSETTLED'); const r2 = await e2.row(v2.reference); assert.equal(r2.bankFinalAt, null); assert.equal(r2.bankResult, 'IPAY0100042');
	// ...unless the bank confirmed that code as «never collectable» (ARB_BANK_RELEASE_CODES)
	const e2b = await env({ releaseCodes: ['IPAY0100042'] }); const u2b = await e2b.mkUser();
	const v2b = await e2b.svc.initiate(u2b.id, 100, IP); await e2b.svc.handleError({ paymentId: (await e2b.row(v2b.reference)).bankPaymentId! });
	e2b.bank.failInquiry = 'expired'; e2b.clock.t += 5_000;
	assert.equal((await e2b.svc.initiate(u2b.id, 100, IP)).state, 'WAITING_PAGE'); const r2b = await e2b.row(v2b.reference); assert.equal(r2b.status, 'EXPIRED'); assert.ok(r2b.bankFinalAt);
	// TIME is not evidence: an hour, a day, a month later the previous attempt is still unsettled and a new start stays blocked
	const e3 = await env(); const u3 = await e3.mkUser();
	await e3.prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED','AUTH_ONLY')`); // rows of earlier tests in the shared test DB
	const v3 = await e3.svc.initiate(u3.id, 100, IP);
	for (const step of [31 * 60_000, 3_600_000, 24 * 3_600_000, 30 * 24 * 3_600_000]) {
		e3.clock.t += step;
		const r = await e3.svc.initiate(u3.id, 100, IP);
		assert.equal(r.state, 'UNSETTLED', `after +${step} ms`); assert.equal(r.requiresAcknowledgement, false);
		assert.equal((await e3.row(v3.reference)).bankFinalAt, null);
	}
	assert.equal(e3.bank.creates, 1);
	const a3 = await e3.row(v3.reference); e3.bank.settle(a3.bankPaymentId!, 'CAPTURED'); e3.clock.t += 25 * 3_600_000; // the daily back-off of a month-old attempt
	await e3.svc.reconcileOnce(); // a month later the reconciler still asks, and the late capture is applied
	assert.equal(await e3.balance(u3.id), 100); assert.equal(await e3.walletRows(u3.id), 1);
});

test('PG: server-side reconciliation - no browser ever came back, a NEW service instance (restart) finds the capture and applies it once, also when two runs overlap', opts, async () => {
	const e = await env(); const u = await e.mkUser();
	await e.prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED','AUTH_ONLY')`); // the shared test database holds open rows of earlier tests
	const v = await e.svc.initiate(u.id, 100, IP); const a = await e.row(v.reference);
	e.bank.settle(a.bankPaymentId!, 'CAPTURED'); // paid at the bank; the user closed the browser, no callback arrived
	const { ArbPaymentService } = await import('./arb-payment.service'); const { testConfig } = await import('./arb-sim-bank.testutil');
	const restarted = new ArbPaymentService({ prisma: e.prisma as any, http: e.bank, config: () => testConfig(), now: () => new Date(e.clock.t) });
	e.clock.t += 60_000;
	const [r1, r2] = await Promise.all([restarted.reconcileOnce(), restarted.reconcileOnce()]);
	assert.ok(r1.checked + r2.checked >= 1);
	assert.equal(await e.balance(u.id), 100); assert.equal(await e.walletRows(u.id), 1); assert.equal((await e.row(v.reference)).status, 'CAPTURED_APPLIED');
	const again = await restarted.reconcileOnce(); assert.equal(again.checked, 0); assert.equal(await e.walletRows(u.id), 1);
});

test('PG: reconciliation back-off, young in-flight creates skipped, nothing credited when the bank has no capture, expiry after the TTL', opts, async () => {
	const e = await env(); const u = await e.mkUser(); const u2 = await e.mkUser();
	await e.prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED','AUTH_ONLY')`); // the shared test database holds open rows of earlier tests
	const v = await e.svc.initiate(u.id, 100, IP);
	await e.svc.reconcileOnce(); const n1 = e.bank.inquiries; // just created: its last inquiry is "never" => checked once
	await e.svc.reconcileOnce(); assert.equal(e.bank.inquiries, n1); // back-off: not asked again within 30 s
	e.clock.t += 31 * 60_000;
	await e.svc.reconcileOnce();
	assert.equal(await e.balance(u.id), 0); assert.equal((await e.row(v.reference)).status, 'EXPIRED'); assert.equal((await e.row(v.reference)).bankFinalAt, null); // LOCAL label only: the bank has not said final, a later capture would still apply
	// a lost create younger than 90 s is left alone
	e.bank.dropCreateAnswer = true; const lost = await e.svc.initiate(u2.id, 100, IP); e.bank.dropCreateAnswer = false;
	await e.svc.reconcileOnce(); assert.equal((await e.row(lost.reference)).inquiryCount, 0); assert.equal((await e.row(lost.reference)).status, 'CREATE_UNKNOWN'); // young lost create: not asked about
});

test('PG: the card brand reported by the bank is recorded after payment, and the charged amount never depends on it', opts, async () => {
	const { svc, mkUser, row, payAndReturn, prisma } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const before = (await row(v.reference)).amountSar.toFixed(2);
	await payAndReturn(v.reference);
	const a = await row(v.reference); assert.equal(a.bankCardType, 'Mada'); assert.equal(a.amountSar.toFixed(2), before);
	assert.equal(((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: a.walletTxId! } })).metadata as any).cardType, 'Mada');
});

test('PG: the DATABASE refuses an applied attempt without its wallet transaction / bank id (CHECK), and the wallet reference is unique across attempts', opts, async () => {
	const { svc, mkUser, prisma, row } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP);
	await assert.rejects(prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'CAPTURED_APPLIED', "appliedAt" = now() WHERE id = '${v.reference}'`), /arb_payments_applied_consistent|check constraint/i);
	assert.notEqual((await row(v.reference)).status, 'CAPTURED_APPLIED');
});

test('PG: logs never contain the resource key, the tranportal password or an encrypted payload', opts, async () => {
	const { logger } = await import('../config/logger'); const { TEST_KEY } = await import('./arb-sim-bank.testutil');
	const seen: string[] = []; const orig: Record<string, any> = {};
	for (const k of ['info', 'warn', 'error', 'debug', 'log'] as const) { orig[k] = (logger as any)[k]; (logger as any)[k] = (...a: any[]) => { seen.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); }; }
	try {
		const e = await env(); const u = await e.mkUser();
		const v = await e.svc.initiate(u.id, 100, IP); const a = await e.row(v.reference);
		Object.assign(e.bank.byPayment(a.bankPaymentId!), { amtOverride: '1.00' }); e.bank.settle(a.bankPaymentId!, 'CAPTURED');
		await e.svc.handleReturn({ paymentId: a.bankPaymentId!, trandata: 'ZZ' + e.bank.trandataFor(e.bank.byPayment(a.bankPaymentId!)) });
		e.bank.rejectCreate = 'IPAY0100024'; await e.svc.initiate((await e.mkUser()).id, 100, IP);
	} finally { for (const k of Object.keys(orig)) (logger as any)[k] = orig[k]; }
	const all = seen.join('\n');
	assert.ok(all.length > 0);
	assert.ok(!all.includes(TEST_KEY) && !all.includes('test-password') && !/[0-9A-F]{64,}/.test(all), 'a secret or an encrypted payload reached the log');
});


test('PG: webhook flow (guide p.179-186): plain JSON, acknowledged `[{status:1}]` once processed; it is only a HINT - a webhook that says CAPTURED credits nothing unless the bank confirms by Inquiry, then exactly once', opts, async () => {
	const { svc, bank, mkUser, balance, walletRows, row, clock } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	const hook = (status: string, extra: any = {}) => [{ result: [{ status }], responseURL: 'https://app.test/x', type: 'PAYMENT', payLoad: [{ paymentId: a.bankPaymentId, trackId: Number(a.trackId), transId: 202110527755152, amt: 384.6, actionCode: '1', udf1: a.id, ...extra }] }];
	// 1) the webhook SAYS captured but the bank has no capture: acknowledged, nothing credited
	assert.deepEqual(await svc.handleWebhook(hook('CAPTURED')), { ack: true });
	await new Promise(r => setTimeout(r, 150));
	assert.equal(await balance(u.id), 0); assert.notEqual((await row(v.reference)).status, 'CAPTURED_APPLIED');
	// 2) the bank really captured: the webhook wakes the verification, the credit happens ONCE even with repeated webhooks
	bank.settle(a.bankPaymentId!, 'CAPTURED'); clock.t += 5_000;
	await Promise.all([svc.handleWebhook(hook('CAPTURED')), svc.handleWebhook(hook('CAPTURED')), svc.handleWebhook(hook('CAPTURED'))]);
	await new Promise(r => setTimeout(r, 400)); await svc.verify(v.reference);
	assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1);
	// 3) every documented status shape is accepted and acknowledged; an unknown attempt is acknowledged without effect; garbage is not acknowledged
	for (const st of ['NOT CAPTURED', 'HOST TIMEOUT', 'VOIDED', 'APPROVED', 'NOT APPROVED']) assert.deepEqual(await svc.handleWebhook(hook(st)), { ack: true }, st);
	assert.deepEqual(await svc.handleWebhook([{ type: 'RISK FAILURE', result: '[{"status":"IPAY0100045 - DENIED BY RISK"}]', payLoad: [{ paymentId: '999999999999999999', trackId: '1', amt: 35.0 }] }]), { ack: true });
	assert.deepEqual(await svc.handleWebhook('<html>'), { ack: false }); assert.deepEqual(await svc.handleWebhook([]), { ack: false }); assert.deepEqual(await svc.handleWebhook([{ type: 'PAYMENT', payLoad: [{}] }]), { ack: false });
	assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1);
});

test('PG: webhook hardening - never changes a status, bounded Inquiry load (per attempt + global), unknown/forged hints cost nothing, its own responseURL is ignored, ids are read exactly', opts, async () => {
	const { svc, bank, mkUser, row, clock, prisma } = await env(); const u = await mkUser();
	await prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED','AUTH_ONLY')`);
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	const hook = (p: any) => [{ type: 'PAYMENT', result: [{ status: 'CAPTURED' }], responseURL: 'https://evil.example/steal', payLoad: [p] }];
	// 1) unknown ids / numeric ids that may be rounded: acknowledged, NO Inquiry, NO row touched
	const n0 = bank.inquiries;
	for (let i = 0; i < 200; i++) await svc.handleWebhook(hook({ trackId: String(1_000_000_000_000 + i), paymentId: '700000000000000000' }));
	await svc.handleWebhook(hook({ paymentId: Number(a.bankPaymentId) })); // a JSON number id: ignored (it may have been rounded)
	assert.equal(bank.inquiries, n0);
	// 2) a webhook never writes a status: REDIRECTED stays REDIRECTED even though the hook says CAPTURED
	clock.t += 20_000; assert.deepEqual(await svc.handleWebhook(hook({ trackId: a.trackId })), { ack: true });
	await new Promise(r => setTimeout(r, 200));
	const after = await row(v.reference); assert.equal(after.status, 'REDIRECTED'); assert.equal(after.appliedAt, null);
	// 3) a flood for the SAME attempt: at most one Inquiry per 15 s and one in flight
	const n1 = bank.inquiries;
	await Promise.all(Array.from({ length: 100 }, () => svc.handleWebhook(hook({ trackId: a.trackId }))));
	await new Promise(r => setTimeout(r, 300));
	assert.ok(bank.inquiries - n1 <= 1, `inquiries during flood: ${bank.inquiries - n1}`);
	// 4) a flood across MANY attempts: bounded by the global budget (30 a minute)
	const users = await Promise.all(Array.from({ length: 45 }, () => mkUser()));
	const refs: any[] = [];
	for (const x of users) { const r = await svc.initiate(x.id, 100, IP); refs.push(await row(r.reference)); }
	clock.t += 20_000; const n2 = bank.inquiries;
	await Promise.all(refs.map(r => svc.handleWebhook(hook({ trackId: r.trackId }))));
	await new Promise(r => setTimeout(r, 600));
	assert.ok(bank.inquiries - n2 <= 31, `inquiries from a many-attempt flood: ${bank.inquiries - n2}`);
});

test('PG: the acknowledgement never waits for the bank: a slow Inquiry does not delay the notification answer or the webhook answer', opts, async () => {
	const { svc, bank, mkUser, row, clock } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	bank.settle(a.bankPaymentId!, 'CAPTURED'); bank.delayMs = 1500; clock.t += 20_000;
	const trandata = bank.trandataFor(bank.byPayment(a.bankPaymentId!));
	const t0 = Date.now(); const n = await svc.handleNotification({ paymentId: a.bankPaymentId!, trandata }); const dt = Date.now() - t0;
	assert.equal(n.ack, true); assert.ok(dt < 700, `notification answered in ${dt} ms`);
	const e = await env(); const u2 = await e.mkUser(); const v2 = await e.svc.initiate(u2.id, 100, IP); const a2 = await e.row(v2.reference);
	e.bank.delayMs = 1500; e.clock.t += 20_000;
	const t1 = Date.now(); const w = await e.svc.handleWebhook([{ type: 'PAYMENT', payLoad: [{ trackId: a2.trackId }] }]); const d2 = Date.now() - t1;
	assert.equal(w.ack, true); assert.ok(d2 < 700, `webhook answered in ${d2} ms`);
	await new Promise(r => setTimeout(r, 1800)); // let the background checks finish before the next test
});

test('PG: a notification for an attempt we already declined is NOT acknowledged (the bank voids it, so nothing is collected that would never be credited)', opts, async () => {
	const { svc, bank, mkUser, row, payAndReturn, clock } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); await payAndReturn(v.reference, 'NOT CAPTURED');
	const a = await row(v.reference); assert.equal(a.status, 'DECLINED'); clock.t += 5_000;
	const out = await svc.handleNotification({ paymentId: a.bankPaymentId!, trandata: bank.trandataFor(bank.byPayment(a.bankPaymentId!)) });
	assert.equal(out.ack, false);
});

test('PG: the DATABASE also refuses a second open attempt while the bank holds an authorization (AUTH_ONLY is inside the one-open index)', opts, async () => {
	const { svc, mkUser, row, payAndReturn, prisma } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); await payAndReturn(v.reference, 'APPROVED');
	assert.equal((await row(v.reference)).status, 'AUTH_ONLY');
	await assert.rejects(() => prisma.arbPayment.create({ data: { userId: u.id, trackId: `9${Date.now()}${Math.floor(Math.random() * 1000)}`, status: 'CREATED', netUsd: 100, feeUsd: 0, feePercent: 0, grossUsd: 100, fxSarPerUsd: 3.75, amountSar: 375, currencyCode: '682', customerIp: IP, expiresAt: new Date(Date.now() + 60_000) } as any }), /Unique constraint/);
});
