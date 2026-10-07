import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marketBlockReasons, MARKET_VISIBLE_WHERE } from '../utils/market-visibility';

// AUD-FND-000049 / 000050 — the market shows a published service only while the provider's kycStatus is VERIFIED AND the specialty behind its
// accreditation sample is APPROVED. Services that stop qualifying are NOT deleted or rewritten: they leave the market, appear to their owner as
// "under review" with an Arabic reason, and return by themselves once both conditions hold again (the gate is evaluated on every read).
type Svc = { id: string; providerId: string; status: string; kyc: string; specialty: string };
const state: { services: Svc[] } = { services: [] };

const toRow = (s: Svc) => ({
	id: s.id, providerId: s.providerId, title: `خدمة ${s.id}`, description: 'وصف', status: s.status, totalAmount: 10, viewsCount: 0, salesCount: 0, isFeatured: false,
	discountPercentage: null, offerEndsAt: null, gallery: [], tags: [], subSpecialty: null, aiScore: null, createdAt: new Date(), specialtyId: 'sp1',
	specialty: { name: 'D', nameAr: 'تصميم', slug: 'design', category: { nameAr: 'فئة', slug: 'cat' } }, stages: [], portfolioItem: null, reviews: [],
	accreditationSample: { attachments: [], providerSpecialty: { status: s.specialty } },
	provider: { id: s.providerId, firstName: 'A', lastName: 'B', avatarUrl: null, email: 'p@x.com', currentLevel: null, gamification: null,
		providerProfile: { firstName: 'A', lastName: 'B', avatarUrl: null, isVerified: true, kycStatus: s.kyc, accreditationSamples: [] } }
});

// Evaluates exactly the where-shape the gate produces (status.in + AND[provider.providerProfile.kycStatus, accreditationSample.providerSpecialty.status]).
function matches(s: Svc, where: any = {}): boolean {
	if (where.id && typeof where.id === 'string' && where.id !== s.id) return false;
	if (where.providerId && where.providerId !== s.providerId) return false;
	if (where.status?.in && !where.status.in.includes(s.status)) return false;
	for (const cond of where.AND ?? []) {
		const kyc = cond.provider?.providerProfile?.kycStatus;
		if (kyc && kyc !== s.kyc) return false;
		const sp = cond.accreditationSample?.providerSpecialty?.status;
		if (sp && sp !== s.specialty) return false;
	}
	return true;
}

async function load(t: TestContext) {
	const prisma: any = {
		serviceCatalog: {
			findMany: async (a: any) => state.services.filter(s => matches(s, a.where)).map(toRow),
			count: async (a: any) => state.services.filter(s => matches(s, a.where)).length,
			findUnique: async (a: any) => { const s = state.services.find(x => x.id === a.where.id); return s ? toRow(s) : null; },
			findFirst: async (a: any) => { const s = state.services.find(x => matches(x, a.where)); return s ? toRow(s) : null; },
			update: async () => ({ viewsCount: 1 })
		},
		user: { findUnique: async () => ({ id: 'p1', providerProfile: { id: 'pp1' } }) },
		project: { findMany: async () => [] },
		review: { aggregate: async () => ({ _count: { _all: 0 }, _avg: { rating: null } }) }
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	t.mock.module('./marketplace-ai.service', { namedExports: { marketplaceAiService: {} } });
	const { MarketplaceService } = await import(`./marketplace-service.service.ts?fx=${Date.now()}-${Math.random()}`);
	return new MarketplaceService();
}

const ok = (id: string, over: Partial<Svc> = {}): Svc => ({ id, providerId: 'p1', status: 'PUBLISHED', kyc: 'VERIFIED', specialty: 'APPROVED', ...over });

test('the market lists only services meeting BOTH conditions (KYC verified AND specialty approved)', async (t) => {
	state.services = [ok('a'), ok('b', { kyc: 'PENDING' }), ok('c', { specialty: 'PENDING_AUDIT' }), ok('d', { kyc: 'UNVERIFIED', specialty: 'REJECTED' }), ok('e', { status: 'ARCHIVED' })];
	const svc = await load(t);
	const res = await svc.getMarketplaceModels({});
	assert.deepEqual(res.models.map((m: any) => m.id), ['a']);
	assert.equal(res.total, 1);
});

test('the detail page of a service that does not qualify is "not available" (not a 200), and a qualifying one is served', async (t) => {
	state.services = [ok('a'), ok('b', { kyc: 'PENDING' }), ok('c', { specialty: 'LOCKED_OUT' })];
	const svc = await load(t);
	await assert.rejects(() => svc.getMarketplaceModelById('b'), /غير متوفرة/);
	await assert.rejects(() => svc.getMarketplaceModelById('c'), /غير متوفرة/);
	assert.equal((await svc.getMarketplaceModelById('a')).id, 'a');
});

test('automatic return: the same stored service leaves the market while KYC is pending and comes back once KYC and specialty are met — nothing rewritten', async (t) => {
	state.services = [ok('a', { kyc: 'PENDING', specialty: 'PENDING_AUDIT' })];
	const svc = await load(t);
	assert.equal((await svc.getMarketplaceModels({})).total, 0);
	state.services[0].kyc = 'VERIFIED';
	assert.equal((await svc.getMarketplaceModels({})).total, 0, 'KYC alone is not enough');
	state.services[0].specialty = 'APPROVED';
	assert.deepEqual((await svc.getMarketplaceModels({})).models.map((m: any) => m.id), ['a']);
	assert.equal(state.services[0].status, 'PUBLISHED', 'the stored status was never changed');
	// and it leaves again if the provider's verification is withdrawn
	state.services[0].kyc = 'REJECTED';
	assert.equal((await svc.getMarketplaceModels({})).total, 0);
});

test('the owner dashboard keeps every service, shows non-qualifying ones as UNDER_REVIEW with a clear Arabic reason, and not-visible flag', async (t) => {
	state.services = [ok('a'), ok('b', { kyc: 'PENDING' }), ok('c', { specialty: 'PENDING_AUDIT' }), ok('d', { kyc: 'PENDING', specialty: 'REJECTED' }), ok('e', { status: 'ARCHIVED' })];
	const svc = await load(t);
	const res = await svc.getMyMarketModels('p1', {});
	const by = Object.fromEntries(res.data.models.map((m: any) => [m.id, m]));
	assert.equal(Object.keys(by).length, 5, 'no service is dropped from the owner');
	assert.equal(by.a.status, 'PUBLISHED'); assert.equal(by.a.marketVisible, true); assert.equal(by.a.marketNotice, null);
	assert.equal(by.b.status, 'UNDER_REVIEW'); assert.equal(by.b.marketVisible, false); assert.match(by.b.marketNotice, /توثيق هويتك/);
	assert.equal(by.c.status, 'UNDER_REVIEW'); assert.match(by.c.marketNotice, /التخصص/);
	assert.match(by.d.marketNotice, /توثيق هويتك.*التخصص/s, 'both reasons are given');
	assert.equal(by.e.status, 'ARCHIVED'); assert.equal(by.e.marketVisible, false); assert.equal(by.e.marketNotice, null, 'an owner-hidden service is not blamed on KYC');
	// back to normal once the conditions hold
	state.services[1].kyc = 'VERIFIED'; state.services[2].specialty = 'APPROVED';
	const again = Object.fromEntries((await svc.getMyMarketModels('p1', {})).data.models.map((m: any) => [m.id, m]));
	assert.equal(again.b.status, 'PUBLISHED'); assert.equal(again.c.marketNotice, null);
});

test('favourites, ordering, cart checkout, AI recommendations and the public provider profile all use the same gate (source wiring)', () => {
	for (const f of ['marketplace-service.service.ts', 'marketplace-ai.service.ts', 'provider-profile.service.ts', 'cart-checkout.service.ts']) {
		const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
		assert.match(src, /MARKET_VISIBLE_WHERE/, f);
		assert.doesNotMatch(src, /status: \{ in: \['PUBLISHED', 'APPROVED'\] \}/, `${f} must not keep a bare status-only visibility filter`);
	}
});

test('publishing or editing a service requires the specialty to be APPROVED (not only isPassed)', () => {
	const src = readFileSync(new URL('./marketplace-service.service.ts', import.meta.url), 'utf8');
	const gates = src.match(/isActive: true,\s*isPassed: true,\s*status: 'APPROVED',/g) ?? [];
	assert.equal(gates.length, 2, 'both create and update look the ProviderSpecialty up with status APPROVED');
});

test('marketBlockReasons / MARKET_VISIBLE_WHERE agree on the edge cases (no profile, no sample, null status)', () => {
	assert.deepEqual(marketBlockReasons({ provider: { providerProfile: { kycStatus: 'VERIFIED' } }, accreditationSample: { providerSpecialty: { status: 'APPROVED' } } }), []);
	assert.deepEqual(marketBlockReasons({ provider: { providerProfile: null }, accreditationSample: null }), ['KYC_NOT_VERIFIED', 'SPECIALTY_NOT_APPROVED']);
	assert.deepEqual(marketBlockReasons({ provider: { providerProfile: { kycStatus: null } }, accreditationSample: { providerSpecialty: { status: 'APPROVED' } } }), ['KYC_NOT_VERIFIED']);
	assert.equal(MARKET_VISIBLE_WHERE.AND.length, 2);
});
