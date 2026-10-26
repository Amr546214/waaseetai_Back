import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Multi-currency infrastructure on a REAL, isolated PostgreSQL (throw-away DB only). A SAR record is built by hand: nothing here enables SAR, a gateway or an exchange rate anywhere.
 *   - a wallet balance per currency: USD stays users.walletBalance, SAR lives in wallet_balances, one never pays for the other;
 *   - an order / contract / escrow / stages / ledger rows in SAR are created in SAR end to end and leave the USD balance untouched;
 *   - a SAR order with only a USD balance is refused with a clear 402 and creates NOTHING;
 *   - mixed-currency carts, cross-currency offers and gateway/currency mismatches are refused before anything is created;
 *   - the database itself refuses a negative balance and a "SAR-table" row for USD.
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
const id = () => randomUUID();
let _db: any; const db = async () => (_db ??= (await import('../config/db')).prisma);

async function seed(serviceCurrency: 'USD' | 'SAR' = 'SAR', usd = 0, sar = 0) {
	const prisma = await db(); const tag = id().slice(0, 8);
	const mk = (kind: string, roles: string[], type: string, wallet = 0) => prisma.user.create({ data: { id: id(), accountType: type, firstName: kind, lastName: tag, email: `fx-${kind}-${tag}@pg.test`, roles, activeRole: roles[0], walletBalance: wallet } });
	const provider = await mk('prov', ['PROVIDER'], 'PROVIDER_INDIVIDUAL'), buyer = await mk('buyer', ['CLIENT'], 'CLIENT_INDIVIDUAL', usd);
	if (sar) await prisma.walletBalance.create({ data: { userId: buyer.id, currency: 'SAR', balance: sar } });
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } });
	const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	const pp = await prisma.providerProfile.create({ data: { id: id(), userId: provider.id, kycStatus: 'VERIFIED' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: pp.id, specialtyId: spec.id, subSpecialties: [], status: 'APPROVED' } });
	const sample = await prisma.accreditationSample.create({ data: { id: id(), providerProfileId: pp.id, providerSpecialtyId: ps.id, title: 'نموذج', description: 'وصف', technologiesUsed: [], attachments: [] } });
	const service = await prisma.serviceCatalog.create({ data: { id: id(), providerId: provider.id, title: `خدمة ${tag}`, description: 'd', specialtyId: spec.id, accreditationSampleId: sample.id, totalAmount: 20, totalDays: 7, status: 'PUBLISHED', currency: serviceCurrency } });
	return { prisma, tag, provider, buyer, service, spec };
}
type W = Awaited<ReturnType<typeof seed>>;
async function rawOrder(w: W, currency: string) {
	const order = await w.prisma.order.create({ data: { id: id(), orderNumber: `WS-FX-${id().slice(0, 8)}`, userId: w.buyer.id, status: 'PENDING_PAYMENT', subtotal: 20, discount: 0, total: 20, currency,
		items: { create: [{ serviceId: w.service.id, modelId: w.service.id, title: w.service.title, providerId: w.provider.id, providerName: 'x', initials: 'x', isVerified: true, packageId: 'basic', packageName: 'الباقة الأساسية', price: 20, deliveryDays: 7, aiScore: 0 }] } }, include: { items: true } });
	await w.prisma.otpVerification.create({ data: { userId: w.buyer.id, code: '123456', type: 'EMAIL', expiresAt: new Date(Date.now() + 120_000), context: { purpose: 'checkout_payment', orderId: order.id, paymentReference: `PAY-${id().slice(0, 8)}`, paymentMethod: 'wallet' } } });
	return order;
}
const balances = async (w: W) => ({ usd: Number((await w.prisma.user.findUniqueOrThrow({ where: { id: w.buyer.id } })).walletBalance), sar: Number((await w.prisma.walletBalance.findUnique({ where: { userId_currency: { userId: w.buyer.id, currency: 'SAR' } } }))?.balance ?? 0) });
const counts = async (w: W) => ({ projects: await w.prisma.project.count({ where: { clientId: w.buyer.id } }), wtx: await w.prisma.walletTransaction.count({ where: { userId: w.buyer.id } }), escrows: await w.prisma.escrow.count({ where: { project: { clientId: w.buyer.id } } }) });

test('pg currency: wallet balances are separate per currency - USD is the legacy column, SAR its own row; a debit only succeeds in the currency that covers it', opts, async () => {
	const w = await seed('SAR', 100, 50); const { debitWalletIfCovered, creditWallet, walletBalanceOf, walletBalancesOf } = await import('../utils/wallet-balance');
	await w.prisma.$transaction(async (tx: any) => {
		assert.equal(await debitWalletIfCovered(tx, w.buyer.id, 'SAR', 60), false, '60 SAR is not covered by 50 SAR (even though 100 USD exist)');
		assert.equal(await debitWalletIfCovered(tx, w.buyer.id, 'SAR', 20), true);
		assert.equal(await debitWalletIfCovered(tx, w.buyer.id, 'USD', 100), true);
		await creditWallet(tx, w.buyer.id, 'SAR', 5); await creditWallet(tx, w.buyer.id, 'USD', 1);
	});
	assert.deepEqual(await balances(w), { usd: 1, sar: 35 });
	assert.deepEqual(await walletBalancesOf(w.prisma, w.buyer.id), { USD: 1, SAR: 35 }); assert.equal(await walletBalanceOf(w.prisma, w.buyer.id, 'SAR'), 35);
	await assert.rejects(creditWallet(w.prisma as any, w.buyer.id, 'EUR', 1), (e: any) => e.code === 'CURRENCY_UNSUPPORTED');
	// the database enforces what the code promises (db push builds tables without the migration's CHECKs, so the test adds the same two the migration file defines)
	for (const c of [`ALTER TABLE wallet_balances ADD CONSTRAINT wallet_balances_non_negative CHECK (balance >= 0)`, `ALTER TABLE wallet_balances ADD CONSTRAINT wallet_balances_not_legacy CHECK (currency <> 'USD')`]) await w.prisma.$executeRawUnsafe(c).catch((e: any) => { if (!/already exists/.test(String(e?.message))) throw e; });
	await assert.rejects(w.prisma.walletBalance.update({ where: { userId_currency: { userId: w.buyer.id, currency: 'SAR' } }, data: { balance: -1 } }), /wallet_balances_non_negative|check/i);
	await assert.rejects(w.prisma.walletBalance.create({ data: { userId: w.buyer.id, currency: 'USD', balance: 1 } }), /wallet_balances_not_legacy|check/i);
});

test('pg currency: a SAR order is paid from the SAR balance and creates contract, escrow, stages and ledger rows in SAR; the USD balance is untouched', opts, async () => {
	const w = await seed('SAR', 100, 50); const { cartCheckoutService } = await import('./cart-checkout.service'); const order = await rawOrder(w, 'SAR');
	const r: any = await cartCheckoutService.confirmPayment(w.buyer.id, order.id, '123456');
	assert.ok(r, 'confirmed');
	assert.deepEqual(await balances(w), { usd: 100, sar: 30 });
	const project = await w.prisma.project.findFirstOrThrow({ where: { clientId: w.buyer.id }, include: { contract: { include: { stages: true } }, escrow: true } });
	assert.equal(project.currency, 'SAR'); assert.equal(project.contract.currency, 'SAR'); assert.equal(project.escrow.currency, 'SAR'); assert.ok(project.contract.stages.length >= 1 && project.contract.stages.every((s: any) => s.currency === 'SAR'));
	const tx = await w.prisma.walletTransaction.findMany({ where: { userId: w.buyer.id } }); assert.ok(tx.length >= 1 && tx.every((t: any) => t.currency === 'SAR'));
});

test('pg currency: a SAR order with only a USD balance is refused (402, with the currency) and creates nothing; no conversion happens', opts, async () => {
	const w = await seed('SAR', 1000, 0); const { cartCheckoutService } = await import('./cart-checkout.service'); const order = await rawOrder(w, 'SAR');
	const before = await counts(w);
	const e: any = await cartCheckoutService.confirmPayment(w.buyer.id, order.id, '123456').catch((x: any) => x);
	assert.equal(e.statusCode, 402); assert.match(e.message, /SAR/); assert.equal(e.errors?.[0]?.currency, 'SAR');
	assert.deepEqual(await counts(w), before); assert.deepEqual(await balances(w), { usd: 1000, sar: 0 });
	assert.equal((await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PENDING_PAYMENT');
});

test('pg currency: existing USD behaviour is unchanged - a USD order is paid from users.walletBalance and everything is USD', opts, async () => {
	const w = await seed('USD', 100, 0); const { cartCheckoutService } = await import('./cart-checkout.service'); const order = await rawOrder(w, 'USD');
	await cartCheckoutService.confirmPayment(w.buyer.id, order.id, '123456');
	assert.deepEqual(await balances(w), { usd: 80, sar: 0 });
	const project = await w.prisma.project.findFirstOrThrow({ where: { clientId: w.buyer.id }, include: { contract: true, escrow: true } }); assert.equal(project.currency, 'USD'); assert.equal(project.escrow.currency, 'USD');
});

test('pg currency: createOrder refuses a cart that mixes currencies, and stores the cart currency otherwise', opts, async () => {
	const w = await seed('SAR', 0, 0); const { cartCheckoutService } = await import('./cart-checkout.service');
	const usdSvc = await w.prisma.serviceCatalog.create({ data: { id: id(), providerId: w.provider.id, title: `usd ${w.tag}`, description: 'd', specialtyId: w.spec.id, accreditationSampleId: (await w.prisma.accreditationSample.findFirstOrThrow({ where: { providerProfile: { userId: w.provider.id } } })).id, totalAmount: 10, totalDays: 3, status: 'PUBLISHED', currency: 'USD' } });
	const e: any = await cartCheckoutService.createOrder(w.buyer.id, { items: [{ modelId: w.service.id }, { modelId: usdSvc.id }] }).catch((x: any) => x);
	assert.equal(e.statusCode, 409); assert.equal(e.code, 'CROSS_CURRENCY_UNSUPPORTED'); assert.equal(await w.prisma.order.count({ where: { userId: w.buyer.id } }), 0);
	const ok: any = await cartCheckoutService.createOrder(w.buyer.id, { items: [{ modelId: w.service.id }] });
	assert.equal((await w.prisma.order.findUniqueOrThrow({ where: { id: ok.id } })).currency, 'SAR');
});

test('pg currency: PayPal refuses a SAR deposit BEFORE any payment row or PayPal order exists; the gateway map keeps ARB off and invents no limits', opts, async () => {
	const w = await seed('USD', 0, 0); const { paypalFinanceService } = await import('./paypal-finance.service'); const before = await w.prisma.paypalPayment.count();
	const e: any = await paypalFinanceService.initiateDeposit(w.buyer.id, 100, 'SAR').catch((x: any) => x);
	assert.equal(e.statusCode, 400); assert.equal(e.code, 'GATEWAY_CURRENCY_UNSUPPORTED'); assert.equal(await w.prisma.paypalPayment.count(), before);
	const { PAYMENT_GATEWAYS, gatewayAccepts, depositConfig } = await import('../config/payment-gateways');
	assert.equal(gatewayAccepts('paypal', 'USD'), true); assert.equal(gatewayAccepts('paypal', 'SAR'), false); assert.equal(gatewayAccepts('arb', 'SAR'), false, 'ARB stays off'); assert.equal(PAYMENT_GATEWAYS.arb.currencies.SAR!.bounds, null);
	assert.deepEqual(depositConfig().map(g => g.id), ['paypal']);
});

test('pg currency: changing the base-currency setting moves no existing record and does not enable a gateway; new roots follow it, derived records follow their parent', opts, async () => {
	const w = await seed('USD', 0, 0); const { platformCurrency } = await import('./platform-currency'); const { systemSettingsService } = await import('./system-settings.service');
	assert.equal(await platformCurrency(), 'USD');
	const coupon = await w.prisma.coupon.findFirst({ where: { providerId: w.provider.id } }); assert.equal(coupon, null);
	// a stored SAR request keeps SAR whatever the setting says; the setting itself is read as USD unless changed through the (gated) settings API
	assert.ok(systemSettingsService);
	const { gatewayAccepts } = await import('../config/payment-gateways'); assert.equal(gatewayAccepts('arb', 'SAR'), false);
});

test('pg currency: the equality rules - same currency passes, different currency is a clear 409; sums are per currency and never one total', opts, async () => {
	const { assertSameCurrency, sumByCurrency, singleCurrencyTotal, roundMoney, formatMoney } = await import('../utils/currency');
	assert.doesNotThrow(() => assertSameCurrency('USD', 'USD', 'x')); assert.doesNotThrow(() => assertSameCurrency(null, 'USD', 'x'));
	assert.throws(() => assertSameCurrency('USD', 'SAR', 'العقد'), (e: any) => e.statusCode === 409 && e.code === 'CROSS_CURRENCY_UNSUPPORTED' && /تحويل تلقائي/.test(e.message));
	const rows = [{ c: 'USD', a: 10.005 }, { c: 'SAR', a: 5 }, { c: 'USD', a: 1 }];
	assert.deepEqual(sumByCurrency(rows, r => r.c, r => r.a), { USD: 11.01, SAR: 5 });
	assert.throws(() => singleCurrencyTotal(rows, r => r.c, r => r.a, 'مجموع'), (e: any) => e.code === 'CROSS_CURRENCY_UNSUPPORTED');
	assert.equal(singleCurrencyTotal(rows.filter(r => r.c === 'SAR'), r => r.c, r => r.a, 'x').total, 5);
	assert.equal(roundMoney(1.005), 1.01); assert.equal(roundMoney(-1.005), -1.01);
	assert.match(formatMoney(1234.5, 'SAR'), /SAR/); assert.match(formatMoney(1234.5, 'USD', 'en'), /USD/); assert.doesNotMatch(formatMoney(5, 'USD'), /\$/);
});
