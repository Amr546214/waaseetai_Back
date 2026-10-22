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
	const idx = sql.slice(sql.indexOf('CREATE UNIQUE INDEX "ux_arb_payments_one_open_per_user"')).trim().replace(/;$/, '').replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX IF NOT EXISTS');
	await prisma.$executeRawUnsafe(idx);
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

test('PG: amount, currency and fee are derived on the server; the bank receives exactly amountSar in 682; the browser only sends net USD', opts, async () => {
	const { svc, bank, mkUser, row } = await env();
	const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal(v.state, 'WAITING_PAGE');
	assert.match(v.redirectUrl!, /^https:\/\/sim-bank\.test\/pg\/paymentpage\.htm\?PaymentID=\d+$/);
	const a = await row(v.reference);
	// mada 4.25 %: gross = 100 / (1 - 0.0425) = 104.44 ; x 3.75 (TEST fixture rate) = 391.65
	assert.equal(a.grossUsd.toFixed(2), '104.44'); assert.equal(a.feeUsd.toFixed(2), '4.44'); assert.equal(a.amountSar.toFixed(2), '391.65'); assert.equal(a.currencyCode, '682');
	assert.equal(bank.log[0].plain.amt, '391.65'); assert.equal(bank.log[0].plain.currencyCode, '682');
	assert.equal(bank.log[0].plain.udf1, a.id); assert.equal(bank.log[0].plain.udf3, u.id);
	assert.equal(bank.log[0].headers['X-FORWARDED-FOR'], IP);
	assert.match(bank.log[0].plain.responseURL, /^https:\/\/app\.test\/api\/payments\/arb\/response$/);
	assert.match(bank.log[0].plain.errorURL, /^https:\/\/app\.test\/api\/payments\/arb\/error$/);
	assert.match(a.trackId, /^\d{18}$/);
	await assert.rejects(svc.initiate(u.id, 10, IP), /بين 50/); // bounds are enforced server-side too
	await assert.rejects(svc.initiate(u.id, NaN, IP));
});

test('PG: not configured / switched off / no customer address -> clear refusal, no row, no bank call', opts, async () => {
	for (const over of [{ enabled: false }, { sarPerUsd: 0 }, { resourceKey: 'short' }, { hostedTokenUrl: '' }]) {
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

test('PG: LOST create answer (bank processed it, answer dropped): shown as "verifying", no second attempt while in doubt, later checked with Inquiry', opts, async () => {
	const { svc, bank, mkUser, clock, row, prisma } = await env(); const u = await mkUser();
	bank.dropCreateAnswer = true;
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal(v.state, 'VERIFYING'); assert.equal(v.redirectUrl, null); // the user never got a URL, so nothing can be paid
	assert.equal((await row(v.reference)).status, 'CREATE_UNKNOWN');
	bank.dropCreateAnswer = false;
	const again = await svc.initiate(u.id, 100, IP);
	assert.equal(again.reference, v.reference); assert.equal(bank.creates, 1); // young unknown create: not judged, not duplicated
	clock.t += 100_000; // now stale: Inquiry by TrackID finds the bank's record (never paid) -> unconfirmed, still no new attempt
	const stale = await svc.initiate(u.id, 100, IP);
	assert.equal(stale.reference, v.reference); assert.equal(bank.creates, 1); assert.ok(bank.inquiries >= 1);
	clock.t += 3_600_000; // far past the horizon with no capture: closed (soft), the USER may start a new one
	const fresh = await svc.initiate(u.id, 100, IP);
	assert.notEqual(fresh.reference, v.reference); assert.equal(bank.creates, 2);
	assert.equal((await row(v.reference)).status, 'EXPIRED');
	assert.equal(await prisma.arbPayment.count({ where: { userId: u.id, status: 'CAPTURED_APPLIED' } }), 0);
});

test('PG: lost create answer where the bank has NO record -> the stale attempt is closed and a new one starts', opts, async () => {
	const { svc, bank, mkUser, clock, row } = await env(); const u = await mkUser();
	bank.failInquiry = 'notfound';
	// simulate: our request never reached the bank (timeout before processing)
	(bank as any).create = async () => { throw new Error('ETIMEDOUT'); };
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal((await row(v.reference)).status, 'CREATE_UNKNOWN');
	clock.t += 100_000;
	delete (bank as any).create; bank.failInquiry = 'notfound';
	const w = await svc.initiate(u.id, 100, IP);
	assert.equal((await row(v.reference)).status, 'CREATE_REJECTED'); assert.notEqual(w.reference, v.reference);
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
	const meta: any = wt.metadata; assert.equal(meta.chargedSar, 391.65); assert.equal(meta.currencyCode, '682'); assert.equal(meta.fxSarPerUsd, 3.75); assert.equal(meta.netCredited, 100);
	const st = await svc.statusFor(u.id, v.reference);
	assert.equal(st.state, 'PAID'); assert.equal(st.creditedUsd, 100); assert.equal(st.chargedSar, 391.65);
	assert.equal(await prisma.accountAuditLog.count({ where: { userId: u.id, eventType: 'WALLET_DEPOSIT_COMPLETED' } }), 1);
});

test('PG: the browser coming back (even with a forged "success") is NOT proof: no capture at the bank -> no credit', opts, async () => {
	const { svc, bank, mkUser, balance, row } = await env(); const u = await mkUser();
	const v = await svc.initiate(u.id, 100, IP); const a = await row(v.reference);
	const { encryptTrandata } = await import('../utils/arb-crypto'); const { TEST_KEY } = await import('./arb-sim-bank.testutil');
	const forged = encryptTrandata(JSON.stringify([{ paymentId: a.bankPaymentId, result: 'CAPTURED', transId: '999', trackId: a.trackId, amt: '391.65', udf1: a.id, actionCode: '1' }]), TEST_KEY);
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
	for (const bad of [{ amtOverride: '1.00' }, { amtOverride: '391.66' }, { udf1Override: 'another-attempt' }, { trackOverride: '111111111111111111' }, { paymentOverride: '999999999999999999' }, { actionOverride: '4' }]) {
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

test('PG: notification (guide p.187-194): acknowledged only for a matching known attempt; mismatch / unknown / disabled are NOT acknowledged', opts, async () => {
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
	const off = await env({ notificationEnabled: false }); const u2 = await off.mkUser(); const v2 = await off.svc.initiate(u2.id, 100, IP); const a2 = await off.row(v2.reference);
	off.bank.settle(a2.bankPaymentId!, 'CAPTURED');
	assert.equal((await off.svc.handleNotification({ paymentId: a2.bankPaymentId!, trandata: off.bank.trandataFor(off.bank.byPayment(a2.bankPaymentId!)) })).ack, false);
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
	assert.match(sql, /CREATE UNIQUE INDEX "ux_arb_payments_one_open_per_user"[\s\S]*WHERE "status" IN \('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED'\)/);
	assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE|ALTER TABLE "(?!arb_payments)\w+")\b/i.test(sql.replace(/--.*$/gm, '').replace(/ON (DELETE|UPDATE) (CASCADE|RESTRICT|NO ACTION|SET NULL)/gi, '')));
});

test('PG: the quote is derived exactly like the charge, and openAttemptFor resumes the user\'s open attempt (refresh / reopen)', opts, async () => {
	const { svc, mkUser, row } = await env(); const u = await mkUser();
	const q = svc.quote(100);
	assert.deepEqual(q, { netUsd: 100, feePercent: 4.25, feeUsd: 4.44, grossUsd: 104.44, chargedSar: 391.65, currency: 'SAR', sarPerUsd: 3.75 });
	assert.throws(() => svc.quote(5), /بين 50/);
	assert.equal(await svc.openAttemptFor(u.id), null);
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal((await row(v.reference)).amountSar.toNumber(), q.chargedSar); // the quote and the charge never disagree
	const open = await svc.openAttemptFor(u.id);
	assert.equal(open?.reference, v.reference); assert.equal(open?.state, 'WAITING_PAGE');
});
