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
	assert.match(a.trackId, /^\d{18}$/);
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

test('PG: LOST create answer (bank processed it, answer dropped): "verifying" while in flight, no second attempt; once stale it is closed (the user was never given a URL, so nothing can be paid) and the USER may start again', opts, async () => {
	const { svc, bank, mkUser, clock, row, prisma } = await env(); const u = await mkUser();
	bank.dropCreateAnswer = true;
	const v = await svc.initiate(u.id, 100, IP);
	assert.equal(v.state, 'VERIFYING'); assert.equal(v.redirectUrl, null);
	assert.equal((await row(v.reference)).status, 'CREATE_UNKNOWN');
	bank.dropCreateAnswer = false;
	const again = await svc.initiate(u.id, 100, IP);
	assert.equal(again.reference, v.reference); assert.equal(bank.creates, 1); // young unknown create: not judged, not duplicated
	clock.t += 100_000; // stale: no URL was ever shown, so no money can move on it -> closed, the user may start again (never automatically)
	const fresh = await svc.initiate(u.id, 100, IP);
	assert.notEqual(fresh.reference, v.reference); assert.equal(bank.creates, 2);
	const old = await row(v.reference); assert.equal(old.status, 'CREATE_REJECTED'); assert.ok(old.bankFinalAt);
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

test('PG: «I left the bank page» is a LOCAL cancel: no silent re-pay - the bank is asked, the user is warned and must acknowledge; a late capture of the old attempt is never ignored', opts, async () => {
	const { svc, bank, mkUser, balance, walletRows, row, clock } = await env(); const u = await mkUser(); const x = await mkUser();
	const v = await svc.initiate(u.id, 100, IP);
	await assert.rejects(svc.abandon(x.id, v.reference), /غير موجودة/);
	const ab = await svc.abandon(u.id, v.reference);
	assert.equal(ab.state, 'CANCELLED'); assert.equal(ab.bankFinal, false); assert.match(ab.message + ab.nextStep, /لم يؤكد بعد|لا تُعد الدفع/);
	assert.ok(bank.inquiries >= 1); // abandon asked the bank at once
	// start over WITHOUT acknowledging: refused with a warning, no new bank call
	clock.t += 5_000;
	const blocked = await svc.initiate(u.id, 100, IP);
	assert.equal(blocked.state, 'UNSETTLED'); assert.equal(blocked.requiresAcknowledgement, true); assert.equal(blocked.previousReference, v.reference); assert.equal(bank.creates, 1);
	// acknowledged: the new attempt starts and records which attempt it replaces
	const w = await svc.initiate(u.id, 100, IP, { acknowledgePreviousRisk: true });
	assert.equal(w.state, 'WAITING_PAGE'); assert.notEqual(w.reference, v.reference); assert.equal(bank.creates, 2);
	assert.equal((await row(w.reference)).replacesId, v.reference);
	// the OLD page is paid late, AFTER the new attempt started: credited once, never ignored
	const a = await row(v.reference); bank.settle(a.bankPaymentId!, 'CAPTURED'); clock.t += 10_000;
	await svc.handleReturn({ paymentId: a.bankPaymentId! }); await svc.handleReturn({ paymentId: a.bankPaymentId! });
	assert.equal(await balance(u.id), 100); assert.equal(await walletRows(u.id), 1); assert.equal((await row(v.reference)).status, 'CAPTURED_APPLIED');
	// and the NEW attempt, if it is also paid, is credited separately (two real payments = two credits, none lost, none repeated)
	const b2 = await row(w.reference); bank.settle(b2.bankPaymentId!, 'CAPTURED'); clock.t += 10_000;
	await svc.handleReturn({ paymentId: b2.bankPaymentId! }); await svc.handleReturn({ paymentId: b2.bankPaymentId! });
	assert.equal(await balance(u.id), 200); assert.equal(await walletRows(u.id), 2);
	assert.equal((await svc.abandon(u.id, v.reference)).state, 'PAID'); // a paid attempt cannot be abandoned
});

test('PG: only the BANK settles an attempt: a bank decline or a bank-reported expired payment id unlocks a new start silently; elapsed time and local expiry do not', opts, async () => {
	const e1 = await env(); const u1 = await e1.mkUser();
	const v1 = await e1.svc.initiate(u1.id, 100, IP); const a1 = await e1.row(v1.reference);
	e1.bank.settle(a1.bankPaymentId!, 'NOT CAPTURED'); e1.clock.t += 5_000;
	const n1 = await e1.svc.initiate(u1.id, 100, IP); // the bank gave a final refusal: no acknowledgement needed
	assert.equal(n1.state, 'WAITING_PAGE'); assert.ok((await e1.row(v1.reference)).bankFinalAt);
	const e2 = await env(); const u2 = await e2.mkUser();
	const v2 = await e2.svc.initiate(u2.id, 100, IP); await e2.svc.abandon(u2.id, v2.reference);
	e2.bank.failInquiry = 'expired'; e2.clock.t += 5_000; // the bank itself says the payment id is expired (IPAY0100042)
	const n2 = await e2.svc.initiate(u2.id, 100, IP);
	assert.equal(n2.state, 'WAITING_PAGE'); const r2 = await e2.row(v2.reference); assert.equal(r2.status, 'EXPIRED'); assert.ok(r2.bankFinalAt);
	// TIME is not evidence: an hour, a day, a month later the previous attempt is still unsettled and still needs the acknowledgement
	const e3 = await env(); const u3 = await e3.mkUser();
	await e3.prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED')`); // rows of earlier tests in the shared test DB
	const v3 = await e3.svc.initiate(u3.id, 100, IP);
	for (const step of [31 * 60_000, 3_600_000, 24 * 3_600_000, 30 * 24 * 3_600_000]) {
		e3.clock.t += step;
		const r = await e3.svc.initiate(u3.id, 100, IP);
		assert.equal(r.state, 'UNSETTLED', `after +${step} ms`); assert.equal(r.requiresAcknowledgement, true);
		assert.equal((await e3.row(v3.reference)).bankFinalAt, null);
	}
	assert.equal(e3.bank.creates, 1);
	const a3 = await e3.row(v3.reference); e3.bank.settle(a3.bankPaymentId!, 'CAPTURED'); e3.clock.t += 25 * 3_600_000; // the daily back-off of a month-old attempt
	await e3.svc.reconcileOnce(); // a month later the reconciler still asks, and the late capture is applied
	assert.equal(await e3.balance(u3.id), 100); assert.equal(await e3.walletRows(u3.id), 1);
});

test('PG: server-side reconciliation - no browser ever came back, a NEW service instance (restart) finds the capture and applies it once, also when two runs overlap', opts, async () => {
	const e = await env(); const u = await e.mkUser();
	await e.prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED')`); // the shared test database holds open rows of earlier tests
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
	await e.prisma.$executeRawUnsafe(`UPDATE arb_payments SET status = 'DECLINED' WHERE status IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED')`); // the shared test database holds open rows of earlier tests
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
