import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Wallet vs ledger, per currency, on a REAL isolated PostgreSQL. For every currency: starting balance + the sum of that currency's ledger rows == the balance now; every debit/credit lives in the
 * SAME transaction as the thing it pays for; concurrency never overspends or goes negative; a replay never pays twice; the browser decides neither the price, the balance nor the currency.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
const id = () => randomUUID();
let _db: any; const db = async () => (_db ??= (await import('../config/db')).prisma);

async function world(usd: number, sar: number) {
	const prisma = await db(); const tag = id().slice(0, 8);
	const mk = (kind: string, roles: string[], type: string, wallet = 0) => prisma.user.create({ data: { id: id(), accountType: type, firstName: kind, lastName: tag, email: `wl-${kind}-${tag}@pg.test`, roles, activeRole: roles[0], walletBalance: wallet } });
	const provider = await mk('prov', ['PROVIDER'], 'PROVIDER_INDIVIDUAL'), buyer = await mk('buyer', ['CLIENT'], 'CLIENT_INDIVIDUAL', usd);
	// the opening balances are themselves ledger rows (a deposit), so the invariant is exact from the first row
	if (usd) await prisma.walletTransaction.create({ data: { userId: buyer.id, type: 'DEPOSIT', amount: usd, currency: 'USD', status: 'COMPLETED', paymentMethod: 'PAYPAL', referenceId: `OPEN-USD-${tag}` } });
	if (sar) { await prisma.walletBalance.create({ data: { userId: buyer.id, currency: 'SAR', balance: sar } }); await prisma.walletTransaction.create({ data: { userId: buyer.id, type: 'DEPOSIT', amount: sar, currency: 'SAR', status: 'COMPLETED', paymentMethod: 'TEST', referenceId: `OPEN-SAR-${tag}` } }); }
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } });
	const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	const pp = await prisma.providerProfile.create({ data: { id: id(), userId: provider.id, kycStatus: 'VERIFIED' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: pp.id, specialtyId: spec.id, subSpecialties: [], status: 'APPROVED' } });
	const sample = await prisma.accreditationSample.create({ data: { id: id(), providerProfileId: pp.id, providerSpecialtyId: ps.id, title: 'نموذج', description: 'وصف', technologiesUsed: [], attachments: [] } });
	const svc = (currency: string, amount = 20) => prisma.serviceCatalog.create({ data: { id: id(), providerId: provider.id, title: `خدمة ${id().slice(0, 5)}`, description: 'd', specialtyId: spec.id, accreditationSampleId: sample.id, totalAmount: amount, totalDays: 7, status: 'PUBLISHED', currency } });
	return { prisma, tag, provider, buyer, svc };
}
type W = Awaited<ReturnType<typeof world>>;
async function order(w: W, service: any, currency: string, total = 20) {
	const o = await w.prisma.order.create({ data: { id: id(), orderNumber: `WS-WL-${id().slice(0, 8)}`, userId: w.buyer.id, status: 'PENDING_PAYMENT', subtotal: total, discount: 0, total, currency,
		items: { create: [{ serviceId: service.id, modelId: service.id, title: service.title, providerId: w.provider.id, providerName: 'x', initials: 'x', isVerified: true, packageId: 'basic', packageName: 'الباقة الأساسية', price: total, deliveryDays: 7, aiScore: 0 }] } } });
	await w.prisma.otpVerification.create({ data: { userId: w.buyer.id, code: '123456', type: 'EMAIL', expiresAt: new Date(Date.now() + 120_000), context: { purpose: 'checkout_payment', orderId: o.id, paymentReference: `PAY-${id().slice(0, 8)}`, paymentMethod: 'wallet' } } });
	return o;
}
/** per currency: the ledger sum and the live balance */
async function books(w: W) {
	const rows = await w.prisma.walletTransaction.groupBy({ by: ['currency'], where: { userId: w.buyer.id, status: 'COMPLETED' }, _sum: { amount: true } });
	const ledger: Record<string, number> = {}; for (const r of rows) ledger[r.currency] = Math.round(Number(r._sum.amount ?? 0) * 100) / 100;
	const usd = Number((await w.prisma.user.findUniqueOrThrow({ where: { id: w.buyer.id } })).walletBalance);
	const sar = Number((await w.prisma.walletBalance.findUnique({ where: { userId_currency: { userId: w.buyer.id, currency: 'SAR' } } }))?.balance ?? 0);
	return { ledger, balance: { USD: usd, SAR: sar } };
}

test('pg ledger: per currency, opening balance + the ledger == the balance, through USD and SAR checkouts and a refund; nothing crosses currencies', opts, async () => {
	const w = await world(100, 50); const { cartCheckoutService } = await import('./cart-checkout.service'); const { creditWallet } = await import('../utils/wallet-balance');
	await cartCheckoutService.confirmPayment(w.buyer.id, (await order(w, await w.svc('USD'), 'USD')).id, '123456');
	await cartCheckoutService.confirmPayment(w.buyer.id, (await order(w, await w.svc('SAR'), 'SAR')).id, '123456');
	// a refund in SAR, as the dispute path does it: the credit and its ledger row in ONE transaction
	await w.prisma.$transaction(async (tx: any) => { await creditWallet(tx, w.buyer.id, 'SAR', 5); await tx.walletTransaction.create({ data: { userId: w.buyer.id, type: 'REFUND', amount: 5, currency: 'SAR', status: 'COMPLETED', paymentMethod: 'ESCROW', referenceId: `R-${id()}` } }); });
	const b = await books(w);
	assert.deepEqual(b.ledger, { USD: b.balance.USD, SAR: b.balance.SAR }, 'ledger sum == balance for each currency'); assert.deepEqual(b.balance, { USD: 80, SAR: 35 });
});

test('pg ledger: a failure after the debit rolls the debit back (no money moves without its ledger row and its contract)', opts, async () => {
	const w = await world(100, 0); const { cartCheckoutService } = await import('./cart-checkout.service');
	const o = await order(w, await w.svc('USD'), 'USD');
	await w.prisma.order.update({ where: { id: o.id }, data: { total: 20, subtotal: 20, discount: 5 } }); // total != price - discount: the service refuses the whole payment after the debit step
	const e: any = await cartCheckoutService.confirmPayment(w.buyer.id, o.id, '123456').catch((x: any) => x);
	assert.ok(e?.statusCode >= 400, 'refused');
	const b = await books(w); assert.equal(b.balance.USD, 100); assert.deepEqual(b.ledger, { USD: 100 }, 'no ORDER_PAYMENT row survived'); assert.equal(await w.prisma.escrow.count({ where: { project: { clientId: w.buyer.id } } }), 0);
});

test('pg ledger: concurrent debits never overspend or go negative, in either currency', opts, async () => {
	const w = await world(100, 100); const { debitWalletIfCovered } = await import('../utils/wallet-balance');
	for (const cur of ['USD', 'SAR']) {
		const results = await Promise.all(Array.from({ length: 12 }, () => w.prisma.$transaction((tx: any) => debitWalletIfCovered(tx, w.buyer.id, cur, 30))));
		assert.equal(results.filter(Boolean).length, 3, `${cur}: only 3 x 30 fit in 100`);
	}
	const b = await books(w); assert.deepEqual(b.balance, { USD: 10, SAR: 10 }); assert.ok(b.balance.USD >= 0 && b.balance.SAR >= 0);
});

test('pg ledger: two simultaneous payments of the same order, and the same order replayed, pay exactly once', opts, async () => {
	const w = await world(100, 0); const { cartCheckoutService } = await import('./cart-checkout.service');
	const o = await order(w, await w.svc('USD'), 'USD');
	const rs = await Promise.all([cartCheckoutService.confirmPayment(w.buyer.id, o.id, '123456').catch((e: any) => e), cartCheckoutService.confirmPayment(w.buyer.id, o.id, '123456').catch((e: any) => e)]);
	assert.equal(rs.filter((r: any) => !(r instanceof Error) && !r?.statusCode).length >= 1, true);
	const again: any = await cartCheckoutService.confirmPayment(w.buyer.id, o.id, '123456').catch((e: any) => e); assert.ok(again?.statusCode >= 400, 'a replay is refused');
	const b = await books(w); assert.equal(b.balance.USD, 80, 'debited once'); assert.equal(await w.prisma.walletTransaction.count({ where: { userId: w.buyer.id, type: 'ORDER_PAYMENT' } }), 1);
});

test('pg ledger: the browser decides neither the price, nor the balance, nor the currency - extra fields in the request are ignored and the stored order/service values win', opts, async () => {
	const w = await world(100, 0); const { cartCheckoutService } = await import('./cart-checkout.service'); const s = await w.svc('USD', 20);
	const o: any = await cartCheckoutService.createOrder(w.buyer.id, { items: [{ modelId: s.id }], total: 1, currency: 'SAR', walletBalance: 1e9, price: 0.01 } as any);
	const row = await w.prisma.order.findUniqueOrThrow({ where: { id: o.id } }); assert.equal(row.total, 20); assert.equal(row.currency, 'USD');
	const { readFileSync } = await import('node:fs'); const src = readFileSync(new URL('./client-requests.service.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(src.slice(src.indexOf('public async depositEscrow'), src.indexOf('public async depositEscrow') + 300), /amount: number/, 'the escrow deposit takes no amount from the client: the contract price funds it');
});

test('pg ledger: a PayPal payment row in a currency the gateway does not take is FAILED by the webhook and credits nothing', opts, async () => {
	const w = await world(0, 0); const { paypalFinanceService } = await import('./paypal-finance.service');
	const pid = id(); await w.prisma.paypalPayment.create({ data: { id: pid, userId: w.buyer.id, paypalOrderId: `ORD-${pid}`, amount: 100, currency: 'SAR', status: 'PENDING', reference: `REF-${pid}` } });
	const r = await paypalFinanceService.completeFromWebhook({ paypalOrderId: `ORD-${pid}`, paypalCaptureId: `CAP-${pid}`, currency: 'SAR', amountValue: '100.00' });
	assert.equal(r.handled, false); assert.equal((await w.prisma.paypalPayment.findUniqueOrThrow({ where: { id: pid } })).status, 'FAILED');
	assert.equal(await w.prisma.walletTransaction.count({ where: { userId: w.buyer.id } }), 0); assert.deepEqual((await books(w)).balance, { USD: 0, SAR: 0 });
});
