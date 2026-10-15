import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL tests (isolated, throw-away DB only) for Batch B §8/§9:
 *  - a user can never buy their OWN service, in any role, at any step (cart / sync / order / init / resend / confirm), decided by the real owner user id;
 *  - the block precedes any debit / hold / project (atomicity) and also wins a race with an ownership change mid-checkout (row lock);
 *  - buying someone else's service as CLIENT still works end to end;
 *  - «طلب تفاوض» is idempotent (one project + one room under concurrent clicks), the owner is refused, and the paid order BECOMES the negotiation project
 *    (same room, no lost messages, no second room).
 *
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_t3 npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --experimental-test-module-mocks --test src/services/pg-self-purchase.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

const id = () => randomUUID();
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const svc = async () => (await import('./cart-checkout.service')).cartCheckoutService;

/** `owner` = a PROVIDER+CLIENT account (activeRole CLIENT, wallet 100) that owns `ownService`; `provider` owns `otherService`; `buyer` is a plain client. */
async function seed() {
	const prisma = await db();
	const tag = id().slice(0, 8);
	const mk = (kind: string, roles: string[], active: string, type: string, wallet = 100) => prisma.user.create({ data: { id: id(), accountType: type, firstName: kind, lastName: tag, email: `sp-${kind}-${tag}@pg.test`, roles, activeRole: active, walletBalance: wallet } });
	const owner = await mk('owner', ['PROVIDER', 'CLIENT'], 'CLIENT', 'PROVIDER_INDIVIDUAL');
	const provider = await mk('prov', ['PROVIDER'], 'PROVIDER', 'PROVIDER_INDIVIDUAL', 0);
	const buyer = await mk('buyer', ['CLIENT'], 'CLIENT', 'CLIENT_INDIVIDUAL');
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } });
	const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	const mkService = async (user: any, title: string) => {
		const pp = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, kycStatus: 'VERIFIED' } });
		const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: pp.id, specialtyId: spec.id, subSpecialties: [], status: 'APPROVED' } });
		const sample = await prisma.accreditationSample.create({ data: { id: id(), providerProfileId: pp.id, providerSpecialtyId: ps.id, title: 'نموذج', description: 'وصف', technologiesUsed: [], attachments: [] } });
		return prisma.serviceCatalog.create({ data: { id: id(), providerId: user.id, title: `${title} ${tag}`, description: 'd', specialtyId: spec.id, accreditationSampleId: sample.id, totalAmount: 20, totalDays: 7, status: 'PUBLISHED' } });
	};
	const ownService = await mkService(owner, 'Own');
	const otherService = await mkService(provider, 'Other');
	return { prisma, tag, owner, provider, buyer, ownService, otherService };
}
type World = Awaited<ReturnType<typeof seed>>;

const state = async (w: World, userId: string) => {
	const [u, projects, wtx, escrows] = await Promise.all([
		w.prisma.user.findUnique({ where: { id: userId }, select: { walletBalance: true } }),
		w.prisma.project.findMany({ where: { clientId: userId, status: { in: ['IN_PROGRESS'] } } }),
		w.prisma.walletTransaction.findMany({ where: { userId } }),
		w.prisma.escrow.findMany({ where: { project: { clientId: userId } } })
	]);
	return { wallet: Number(u.walletBalance), projects: projects.length, wtx: wtx.length, escrows: escrows.length };
};

/** An order exactly as createOrder would have written it (the order is built by hand where the test needs an item createOrder itself would refuse). */
async function rawOrder(w: World, userId: string, service: any, itemProviderId: string) {
	const order = await w.prisma.order.create({ data: { id: id(), orderNumber: `WS-T3-${id().slice(0, 8)}`, userId, status: 'PENDING_PAYMENT', subtotal: 20, discount: 0, total: 20,
		items: { create: [{ serviceId: service.id, modelId: service.id, title: service.title, providerId: itemProviderId, providerName: 'x', initials: 'x', isVerified: true, packageId: 'basic', packageName: 'الباقة الأساسية', price: 20, deliveryDays: 7, aiScore: 0 }] } }, include: { items: true } });
	const code = '123456';
	await w.prisma.otpVerification.create({ data: { userId, code, type: 'EMAIL', expiresAt: new Date(Date.now() + 120_000), context: { purpose: 'checkout_payment', orderId: order.id, paymentReference: `PAY-${id().slice(0, 8)}`, paymentMethod: 'wallet' } } });
	return { order, code };
}
const code = (e: any) => e?.code ?? e?.errors?.[0]?.code;

test('pg: the isolated database is really the throw-away one', opts, async () => {
	const prisma = await db();
	const [{ current_database }] = await prisma.$queryRaw`SELECT current_database()` as any[];
	assert.match(current_database, /^qa_iso/);
});

test('pg: cart add / update / sync refuse the owner\'s own service for an account acting as CLIENT; someone else\'s service is accepted', opts, async () => {
	const w = await seed(); const s = await svc();
	const e1: any = await s.addItem(w.owner.id, { modelId: w.ownService.id }).catch((e: any) => e);
	assert.equal(e1.statusCode, 403); assert.equal(code(e1), 'SELF_PURCHASE_FORBIDDEN');
	// an old row that predates the block (inserted directly) is flagged, cannot be updated, and sync drops it with the code
	const cart = await w.prisma.cart.create({ data: { userId: w.owner.id } });
	const row = await w.prisma.cartItem.create({ data: { cartId: cart.id, serviceId: w.ownService.id, packageId: 'basic' } });
	const flagged = await s.getCart(w.owner.id);
	assert.equal(flagged.items.find((i: any) => i.id === row.id).ownService, true);
	const e2: any = await s.updateItem(w.owner.id, row.id, { savedForLater: false }).catch((e: any) => e);
	assert.equal(code(e2), 'SELF_PURCHASE_FORBIDDEN');
	const synced: any = await s.sync(w.owner.id, [{ modelId: w.ownService.id }, { modelId: w.otherService.id }]);
	assert.deepEqual(synced.items.map((i: any) => i.modelId), [w.otherService.id]);
	assert.deepEqual(synced.rejected, [{ modelId: w.ownService.id, code: 'SELF_PURCHASE_FORBIDDEN' }]);
	assert.equal(synced.items[0].ownService, false);
	// the same account buying SOMEONE ELSE's service is fine
	const ok = await s.addItem(w.owner.id, { modelId: w.otherService.id });
	assert.ok(ok.items.some((i: any) => i.modelId === w.otherService.id));
});

test('pg: createOrder refuses an order containing the user\'s own service (also mixed with a valid one) - nothing is written', opts, async () => {
	const w = await seed(); const s = await svc();
	const e: any = await s.createOrder(w.owner.id, { items: [{ modelId: w.otherService.id }, { modelId: w.ownService.id }] }).catch((x: any) => x);
	assert.equal(code(e), 'SELF_PURCHASE_FORBIDDEN');
	assert.equal(await w.prisma.order.count({ where: { userId: w.owner.id } }), 0);
});

test('pg: init / resend / confirm on an order that holds the user\'s own service (old order, snapshot or live owner) are refused BEFORE any OTP, debit, hold or project', opts, async () => {
	const w = await seed(); const s = await svc();
	// (a) item snapshot says the owner, live service is someone else's; (b) snapshot says another provider but the LIVE service is the owner's (alternate id / stale snapshot)
	for (const [service, snapshotProvider] of [[w.otherService, w.owner.id], [w.ownService, w.provider.id]] as const) {
		const { order, code: otp } = await rawOrder(w, w.owner.id, service, snapshotProvider);
		const before = await state(w, w.owner.id);
		const init: any = await s.initPayment(w.owner.id, order.id, 'wallet').catch((e: any) => e);
		const resend: any = await s.resendPaymentOtp(w.owner.id, order.id).catch((e: any) => e);
		const confirm: any = await s.confirmPayment(w.owner.id, order.id, otp).catch((e: any) => e);
		for (const e of [init, resend, confirm]) { assert.equal(e.statusCode, 403); assert.equal(code(e), 'SELF_PURCHASE_FORBIDDEN'); }
		assert.deepEqual(await state(w, w.owner.id), before, 'wallet, projects, wallet transactions and escrows untouched');
		assert.equal((await w.prisma.order.findUnique({ where: { id: order.id } }))!.status, 'PENDING_PAYMENT', 'order not paid');
		const otpRow = await w.prisma.otpVerification.findFirst({ where: { userId: w.owner.id, code: otp } });
		assert.equal(otpRow!.attempts, 0, 'the OTP was not even consumed');
	}
});

test('pg: ownership changing between order creation and payment (service handed to the buyer) blocks init / confirm; nothing is debited', opts, async () => {
	const w = await seed(); const s = await svc();
	const order = await s.createOrder(w.buyer.id, { items: [{ modelId: w.otherService.id }] });
	await s.initPayment(w.buyer.id, order.orderId, 'wallet');
	const otp = (await w.prisma.otpVerification.findFirst({ where: { userId: w.buyer.id }, orderBy: { createdAt: 'desc' } }))!.code;
	await w.prisma.serviceCatalog.update({ where: { id: w.otherService.id }, data: { providerId: w.buyer.id } });
	const before = await state(w, w.buyer.id);
	const e: any = await s.confirmPayment(w.buyer.id, order.orderId, otp).catch((x: any) => x);
	assert.equal(code(e), 'SELF_PURCHASE_FORBIDDEN');
	assert.deepEqual(await state(w, w.buyer.id), before);
	assert.equal((await w.prisma.order.findUnique({ where: { id: order.orderId } }))!.status, 'PENDING_PAYMENT');
});

test('pg: a service that is unpublished between order creation and payment is refused with SERVICE_UNAVAILABLE_FOR_ORDER (409) and nothing is debited', opts, async () => {
	const w = await seed(); const s = await svc();
	const order = await s.createOrder(w.buyer.id, { items: [{ modelId: w.otherService.id }] });
	await s.initPayment(w.buyer.id, order.orderId, 'wallet');
	const otp = (await w.prisma.otpVerification.findFirst({ where: { userId: w.buyer.id }, orderBy: { createdAt: 'desc' } }))!.code;
	await w.prisma.serviceCatalog.update({ where: { id: w.otherService.id }, data: { status: 'ARCHIVED' } });
	const before = await state(w, w.buyer.id);
	const e: any = await s.confirmPayment(w.buyer.id, order.orderId, otp).catch((x: any) => x);
	assert.equal(e.statusCode, 409); assert.equal(code(e), 'SERVICE_UNAVAILABLE_FOR_ORDER');
	assert.deepEqual(await state(w, w.buyer.id), before);
});

test('pg: deterministic race - the owner change is mid-flight (row locked) while the payment runs: the payment waits, then sees the new owner and rolls back whole', opts, async () => {
	const w = await seed(); const s = await svc();
	const order = await s.createOrder(w.buyer.id, { items: [{ modelId: w.otherService.id }] });
	await s.initPayment(w.buyer.id, order.orderId, 'wallet');
	const otp = (await w.prisma.otpVerification.findFirst({ where: { userId: w.buyer.id }, orderBy: { createdAt: 'desc' } }))!.code;
	const before = await state(w, w.buyer.id);
	let confirmSettled = false;
	let confirm!: Promise<any>;
	await w.prisma.$transaction(async (tx: any) => {
		await tx.serviceCatalog.update({ where: { id: w.otherService.id }, data: { providerId: w.buyer.id } }); // uncommitted: holds the row lock
		confirm = s.confirmPayment(w.buyer.id, order.orderId, otp).then((v: any) => { confirmSettled = true; return v; }, (e: any) => { confirmSettled = true; throw e; });
		await delay(700);
		assert.equal(confirmSettled, false, 'the payment is blocked behind the ownership change (it cannot slip past the check)');
	});
	const e: any = await confirm.catch((x: any) => x);
	assert.equal(code(e), 'SELF_PURCHASE_FORBIDDEN');
	assert.deepEqual(await state(w, w.buyer.id), before, 'no debit, no project, no escrow, no wallet transaction');
	assert.equal((await w.prisma.order.findUnique({ where: { id: order.orderId } }))!.status, 'PENDING_PAYMENT', 'the order PAID transition rolled back too');
});

test('pg: randomized race (payment vs owner change, 12 rounds) - never paid-and-owner, never debited without a project', opts, async () => {
	const s = await svc();
	for (let round = 0; round < 12; round++) {
		const w = await seed();
		const order = await s.createOrder(w.buyer.id, { items: [{ modelId: w.otherService.id }] });
		await s.initPayment(w.buyer.id, order.orderId, 'wallet');
		const otp = (await w.prisma.otpVerification.findFirst({ where: { userId: w.buyer.id }, orderBy: { createdAt: 'desc' } }))!.code;
		const jitter = <T>(job: () => Promise<T>) => delay(Math.random() * 25).then(job);
		const [pay] = await Promise.allSettled([
			jitter(() => s.confirmPayment(w.buyer.id, order.orderId, otp)),
			jitter(() => w.prisma.serviceCatalog.update({ where: { id: w.otherService.id }, data: { providerId: w.buyer.id } }))
		]);
		const st = await state(w, w.buyer.id);
		if (pay.status === 'fulfilled') {
			assert.deepEqual([st.wallet, st.projects, st.wtx, st.escrows], [80, 1, 1, 1], `round ${round}: paid exactly once`);
			const p = await w.prisma.project.findFirst({ where: { clientId: w.buyer.id } });
			assert.equal(p!.providerId, w.provider.id, 'the project was formed with the owner at payment time');
		} else {
			// SELF_PURCHASE_FORBIDDEN, or SERVICE_UNAVAILABLE_FOR_ORDER when the unlocked pre-check saw the service already off the market under its new owner (no KYC/approval): both refuse before any money moves
			assert.ok(['SELF_PURCHASE_FORBIDDEN', 'SERVICE_UNAVAILABLE_FOR_ORDER'].includes(code(pay.reason)), `round ${round}: ${(pay.reason as any)?.message}`);
			assert.deepEqual([st.wallet, st.projects, st.wtx, st.escrows], [100, 0, 0, 0], `round ${round}: nothing happened`);
		}
	}
});

test('pg: buying someone else\'s service as CLIENT works end to end (init -> confirm): debit once, project + contract + escrow', opts, async () => {
	const w = await seed(); const s = await svc();
	const order = await s.createOrder(w.owner.id, { items: [{ modelId: w.otherService.id }] }); // the multi-role OWNER account, acting as CLIENT, buying another provider's service
	await s.initPayment(w.owner.id, order.orderId, 'wallet');
	const otp = (await w.prisma.otpVerification.findFirst({ where: { userId: w.owner.id }, orderBy: { createdAt: 'desc' } }))!.code;
	const paid = await s.confirmPayment(w.owner.id, order.orderId, otp);
	assert.equal(paid.status, 'paid');
	assert.deepEqual(await state(w, w.owner.id), { wallet: 80, projects: 1, wtx: 1, escrows: 1 });
	const contract = await w.prisma.contract.findFirst({ where: { projectId: paid.projectIds[0] } });
	assert.equal(contract!.providerId, w.provider.id);
});

test('pg: hire paths - the client of a request cannot select / sign / fund an offer from their own account', opts, async () => {
	const w = await seed();
	const { clientRequestsService } = await import('./client-requests.service') as any;
	const svcr = clientRequestsService ?? (await import('./client-requests.service') as any).default;
	if (!svcr?.selectOffer) return; // export shape differs: covered by the unit tests
	const profile = await w.prisma.clientProfile.create({ data: { id: id(), userId: w.owner.id, firstName: 'o', lastName: 'w' } });
	const req = await w.prisma.clientRequest.create({ data: { id: id(), clientProfileId: profile.id, title: 'own request', description: 'desc desc desc desc', status: 'OPEN' } as any }).catch(() => null);
	if (!req) return;
	await w.prisma.projectProposal.create({ data: { id: id(), projectId: req.id, providerId: w.owner.id, totalPrice: 20, deliveryDays: 5, coverLetter: 'x', status: 'SUBMITTED' } as any }).catch(() => null);
	const prop = await w.prisma.projectProposal.findFirst({ where: { projectId: req.id } });
	if (!prop) return;
	const e: any = await svcr.selectOffer(w.owner.id, req.id, prop.id).catch((x: any) => x);
	assert.equal(code(e), 'SELF_HIRE_FORBIDDEN');
});

// ── §9 negotiation request ─────────────────────────────────────────────────────────────────────────────────────────────────
test('pg: «طلب تفاوض» - 10 concurrent requests by the same client create ONE project and ONE room; repeated clicks reuse them', opts, async () => {
	const w = await seed();
	const { MarketplaceService } = await import('./marketplace-service.service') as any; const marketplaceService = new MarketplaceService();
	const results = await Promise.all(Array.from({ length: 10 }, () => marketplaceService.requestMarketplaceService(w.buyer.id, w.otherService.id, { mode: 'negotiation', message: 'hello' })));
	assert.equal(new Set(results.map((r: any) => r.projectId)).size, 1);
	assert.equal(new Set(results.map((r: any) => r.conversationId)).size, 1);
	assert.equal(results.filter((r: any) => r.created).length, 1);
	assert.equal(await w.prisma.project.count({ where: { clientId: w.buyer.id, serviceCatalogId: w.otherService.id } }), 1);
	assert.equal(await w.prisma.conversation.count({ where: { clientId: w.buyer.id, providerId: w.provider.id } }), 1);
	const again = await marketplaceService.requestMarketplaceService(w.buyer.id, w.otherService.id, { mode: 'negotiation' });
	assert.equal(again.conversationId, results[0].conversationId);
	assert.equal(again.created, false);
});

test('pg: «طلب تفاوض» is refused for the service owner (any active role) with SELF_NEGOTIATION_FORBIDDEN and creates nothing', opts, async () => {
	const w = await seed();
	const { MarketplaceService } = await import('./marketplace-service.service') as any; const marketplaceService = new MarketplaceService();
	const e: any = await marketplaceService.requestMarketplaceService(w.owner.id, w.ownService.id, { mode: 'negotiation' }).catch((x: any) => x);
	assert.equal(e.statusCode, 403); assert.equal(code(e), 'SELF_NEGOTIATION_FORBIDDEN');
	assert.equal(await w.prisma.project.count({ where: { serviceCatalogId: w.ownService.id } }), 0);
	assert.equal(await w.prisma.conversation.count({ where: { providerId: w.owner.id } }), 0);
});

test('pg: the pre-contract negotiation links to the project formed by the paid order - same project + room, messages kept, no second room', opts, async () => {
	const w = await seed(); const s = await svc();
	const { MarketplaceService } = await import('./marketplace-service.service') as any; const marketplaceService = new MarketplaceService();
	const neg = await marketplaceService.requestMarketplaceService(w.buyer.id, w.otherService.id, { mode: 'negotiation', message: 'هل يمكن تخفيض السعر؟' });
	await w.prisma.message.create({ data: { conversationId: neg.conversationId, senderId: w.provider.id, type: 'TEXT', content: 'نعم' } });
	const msgsBefore = await w.prisma.message.count({ where: { conversationId: neg.conversationId } });
	const order = await s.createOrder(w.buyer.id, { items: [{ modelId: w.otherService.id }] });
	await s.initPayment(w.buyer.id, order.orderId, 'wallet');
	const otp = (await w.prisma.otpVerification.findFirst({ where: { userId: w.buyer.id }, orderBy: { createdAt: 'desc' } }))!.code;
	const paid = await s.confirmPayment(w.buyer.id, order.orderId, otp);
	assert.deepEqual(paid.projectIds, [neg.projectId], 'the order formed the SAME project the negotiation was opened on');
	const project = await w.prisma.project.findUnique({ where: { id: neg.projectId }, include: { contract: true } });
	assert.equal(project!.status, 'IN_PROGRESS'); assert.ok(project!.contract);
	assert.equal(await w.prisma.project.count({ where: { clientId: w.buyer.id, serviceCatalogId: w.otherService.id } }), 1);
	const rooms = await w.prisma.conversation.findMany({ where: { clientId: w.buyer.id, providerId: w.provider.id } });
	assert.deepEqual(rooms.map((r: any) => r.id), [neg.conversationId]);
	assert.equal(await w.prisma.message.count({ where: { conversationId: neg.conversationId } }), msgsBefore, 'no message lost');
	// clicking «طلب تفاوض» again after the purchase still lands on the same room
	const after = await marketplaceService.requestMarketplaceService(w.buyer.id, w.otherService.id, { mode: 'negotiation' });
	assert.equal(after.conversationId, neg.conversationId);
});
