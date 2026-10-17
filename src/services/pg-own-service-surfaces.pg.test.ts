import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL tests (isolated, throw-away DB only) for post-Batch-B fix 2: the SAME account (PROVIDER+CLIENT, activeRole switched to CLIENT) never gets
 * a buyable view of its own service: listing + recommendation payloads carry `isOwnService`, every write path refuses with the stable code, and another
 * user with the SAME display name can still buy.
 *
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_pbo npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --experimental-test-module-mocks --test src/services/pg-own-service-surfaces.pg.test.ts
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

const code = (e: any) => e?.code ?? e?.errors?.[0]?.code;

const market = async () => new (await import('./marketplace-service.service')).MarketplaceService();
const asUser = (u: any) => ({ id: u.id, accountType: u.accountType });

test('pg: listing flags the owner\'s own service for the SAME account whatever its account type / active role, and nobody else\'s; guests get no flag', opts, async () => {
	const w = await seed(); const m = await market();
	const find = (res: any, sid: string) => res.models.find((x: any) => x.id === sid);
	// account type PROVIDER_INDIVIDUAL, activeRole CLIENT: the client-only `eligibility` block is absent, the ownership flag must still be there
	const asOwner: any = await m.getMarketplaceModels({ search: w.tag, limit: 50 }, asUser(w.owner));
	assert.equal(find(asOwner, w.ownService.id).isOwnService, true);
	assert.equal(find(asOwner, w.otherService.id).isOwnService, false);
	const asBuyer: any = await m.getMarketplaceModels({ search: w.tag, limit: 50 }, asUser(w.buyer));
	assert.equal(find(asBuyer, w.ownService.id).isOwnService, false);
	assert.equal(find(asBuyer, w.otherService.id).isOwnService, false);
	const guest: any = await m.getMarketplaceModels({ search: w.tag, limit: 50 });
	assert.equal('isOwnService' in find(guest, w.ownService.id), false);
	// the detail payload agrees with the listing
	assert.equal((await m.getMarketplaceModelById(w.ownService.id, asUser(w.owner)) as any).isOwnService, true);
	assert.equal((await m.getMarketplaceModelById(w.ownService.id, asUser(w.buyer)) as any).isOwnService, false);
});

test('pg: recommendations (the suggestions blocks) carry isOwnService per item for an authenticated user, by the provider USER id', opts, async () => {
	const w = await seed(); const m = await market();
	const recs = async (u?: any) => ((await m.getAiRecommendations({ query: w.tag, limit: 10 }, u && asUser(u))) as any).data.recommendations as any[];
	const own = (await recs(w.owner)).find(r => r.id === w.ownService.id);
	assert.equal(own.isOwnService, true); assert.equal(own.provider.id, w.owner.id);
	assert.equal((await recs(w.owner)).find(r => r.id === w.otherService.id).isOwnService, false);
	assert.equal((await recs(w.buyer)).find(r => r.id === w.ownService.id).isOwnService, false);
	assert.equal('isOwnService' in (await recs()).find(r => r.id === w.ownService.id), false);
});

test('pg: a DIFFERENT user with the very same display name can still buy the service (identity is the user id, never the name)', opts, async () => {
	const w = await seed(); const s = await svc(); const m = await market();
	const twin = await w.prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: w.owner.firstName, lastName: w.owner.lastName, email: `twin-${w.tag}@pg.test`, roles: ['CLIENT'], activeRole: 'CLIENT', walletBalance: 100 } });
	assert.equal(`${twin.firstName} ${twin.lastName}`, `${w.owner.firstName} ${w.owner.lastName}`);
	const listed: any = await m.getMarketplaceModels({ search: w.tag, limit: 50 }, asUser(twin));
	assert.equal(listed.models.find((x: any) => x.id === w.ownService.id).isOwnService, false);
	const cart = await s.addItem(twin.id, { modelId: w.ownService.id });
	assert.equal(cart.items[0].ownService, false);
	const order = await s.createOrder(twin.id, { items: [{ modelId: w.ownService.id }] });
	assert.ok(order.orderId);
	await s.initPayment(twin.id, order.orderId, 'wallet');
});

test('pg: the owner is refused through every other id shape of the same service (junk packageId, upper-cased / padded id, order mode request, negotiation) with the stable code; unknown shapes are 404/400, never a purchase', opts, async () => {
	const w = await seed(); const s = await svc(); const m = await market();
	const e1: any = await s.addItem(w.owner.id, { modelId: w.ownService.id, packageId: 'premium-999' }).catch((e: any) => e);
	assert.equal(code(e1), 'SELF_PURCHASE_FORBIDDEN');
	const e2: any = await s.createOrder(w.owner.id, { items: [{ modelId: w.ownService.id, packageId: '../x' }] }).catch((e: any) => e);
	assert.equal(code(e2), 'SELF_PURCHASE_FORBIDDEN');
	// ids that are not the exact service id never resolve to a purchasable service (no fuzzy match that could bypass the owner check)
	for (const bad of [w.ownService.id.toUpperCase(), ` ${w.ownService.id}`, w.ownService.title, w.ownService.specialtyId!]) {
		const e: any = await s.addItem(w.owner.id, { modelId: bad }).catch((x: any) => x);
		assert.ok(e instanceof Error || e?.statusCode, 'rejected');
		assert.equal((await w.prisma.cartItem.count({ where: { cart: { userId: w.owner.id } } })), 0);
	}
	for (const mode of ['order', 'negotiation', undefined]) {
		const e: any = await m.requestMarketplaceService(w.owner.id, w.ownService.id, { mode, message: 'x' }).catch((x: any) => x);
		assert.equal(code(e), 'SELF_NEGOTIATION_FORBIDDEN');
	}
	assert.equal(await w.prisma.project.count({ where: { clientId: w.owner.id } }), 0);
	assert.equal(await w.prisma.order.count({ where: { userId: w.owner.id } }), 0);
});

test('pg: a stale cart row for the user\'s own service (switched account) is flagged, blocks the cart-based order with the code, can be removed, and then checkout of the rest works', opts, async () => {
	const w = await seed(); const s = await svc();
	const cart = await w.prisma.cart.create({ data: { userId: w.owner.id } });
	const row = await w.prisma.cartItem.create({ data: { cartId: cart.id, serviceId: w.ownService.id, packageId: 'basic' } });
	await w.prisma.cartItem.create({ data: { cartId: cart.id, serviceId: w.otherService.id, packageId: 'basic' } });
	const got: any = await s.getCart(w.owner.id);
	assert.deepEqual(got.items.map((i: any) => [i.modelId === w.ownService.id, i.ownService]), [[true, true], [false, false]]);
	const e: any = await s.createOrder(w.owner.id, { items: got.items.map((i: any) => ({ modelId: i.modelId })) }).catch((x: any) => x);
	assert.equal(code(e), 'SELF_PURCHASE_FORBIDDEN');
	const after: any = await s.removeItem(w.owner.id, row.id);
	assert.deepEqual(after.items.map((i: any) => i.modelId), [w.otherService.id]);
	const order = await s.createOrder(w.owner.id, { items: [{ modelId: w.otherService.id }] });
	assert.ok(order.orderId);
});
