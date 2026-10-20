import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// The provider setup request is judged on documents BEFORE any write, and "complete" rests on stored evidence:
//  - a business model without a completed ownership proof (or with the model file reused as proof) is a 400 and nothing is written;
//  - a missing / unreadable / foreign identity front on a wizard submission is a 400 and nothing is written;
//  - a proof that is not in the storage (upload never finished) is a 400; a storage outage fails closed (503) with nothing written;
//  - no request shape completes the setup without documents (a partial save never marks it complete); an already complete profile is not downgraded.
function mockRes() { const res: any = { statusCode: 200, body: undefined }; res.status = (c: number) => { res.statusCode = c; return res; }; res.json = (b: any) => { res.body = b; return res; }; return res; }
const store: { provider: any; writes: number; exists: (ref: string) => Promise<boolean> } = { provider: null, writes: 0, exists: async () => true };
const merge = (cur: any, patch: any) => { const next = { ...(cur ?? {}) }; for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v; return next; };
const prisma: any = {
	skill: { findMany: async () => [] },
	portfolioItem: {
		deleteMany: async () => { store.writes++; if (store.provider) store.provider = { ...store.provider, portfolioItems: [] }; return {}; },
		createMany: async ({ data }: any) => { store.writes++; store.provider = { ...store.provider, portfolioItems: [...(store.provider?.portfolioItems ?? []), ...data.map((d: any, i: number) => ({ id: `row-${i + 1}`, ...d }))] }; return {}; },
	},
	providerProfile: {
		findUnique: async () => (store.provider ? { id: 'pp1', skills: [], portfolioItems: [], ...store.provider } : null),
		upsert: async (a: any) => { store.writes++; store.provider = merge(store.provider ?? { kycStatus: 'UNVERIFIED' }, a.update); return { id: 'pp1', ...store.provider }; },
		update: async (a: any) => { store.writes++; store.provider = merge(store.provider, a.data); return { id: 'pp1', ...store.provider }; },
		updateMany: async () => ({ count: 1 }),
	},
	user: { findUnique: async () => ({ id: 'u1', status: 'ACTIVE' }), update: async ({ data }: any) => ({ id: 'u1', ...data }) },
	$transaction: async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops({})),
};
const mocked = new WeakSet<object>();
async function controller(t: TestContext, seed: any = null) {
	store.provider = seed; store.writes = 0; store.exists = async () => true;
	if (!mocked.has(t)) {
		mocked.add(t);
		t.mock.module('../config/db', { namedExports: { prisma } });
		t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v ?? null, storeKycFileIfNeeded: async (v: any) => v ?? null, privateFileExists: (ref: string) => store.exists(ref) } });
		t.mock.module('../services/session.service', { namedExports: { sessionService: {} } });
		t.mock.module('../services/provider-profile.service', { namedExports: { providerProfileService: {} } });
		t.mock.module('../services/client-profile.service', { namedExports: { clientProfileService: {} } });
	}
	return import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
}
const AGREE = { accurate: true, terms: true, privacy: true };
const own = (n: string) => `private:raw:pdf:waseetai/providers/u1/documents/${n}`;
const FRONT = 'private:image:png:waseetai/providers/u1/identity/front';
const body = (over: any = {}) => ({
	details: { occupation: 'مصمم واجهات', country: 'السعودية', city: 'الرياض', bio: 'خبرة طويلة في التصميم', expYears: '5 الى 10 سنوات' },
	specialties: { mainSpec: 'التصميم', subSpecs: ['واجهات'] }, identity: { frontId: FRONT, certs: [] }, agreements: AGREE,
	portfolio: { 'واجهات': [{ review: own('work'), proofs: [own('proof')] }] }, ...over,
});
const post = async (c: any, b: any) => { const res = mockRes(); await c.saveSetupData({ user: { id: 'u1' }, body: b } as any, res); return res; };
const refused = (res: any, field: string, code: string) => { assert.equal(res.statusCode, 400, JSON.stringify(res.body)); assert.equal(res.body.errors?.[0]?.field, field); assert.equal(res.body.errors?.[0]?.code, code); assert.equal(store.writes, 0, 'nothing was written'); };

test('model file without a proof / with its own file as the proof: 400 PROOF_REQUIRED, nothing written, setup not complete', async (t) => {
	const c = await controller(t);
	refused(await post(c, body({ portfolio: { 'واجهات': [{ review: own('work'), proofs: [] }] } })), 'portfolio.واجهات', 'PROOF_REQUIRED');
	refused(await post(c, body({ portfolio: { 'واجهات': [{ review: own('work'), proofs: [own('work')] }] } })), 'portfolio.واجهات', 'PROOF_REQUIRED');
	assert.equal(store.provider, null);
});

test('a chosen sub-specialty with no model at all is a 400 naming it', async (t) => {
	const c = await controller(t);
	refused(await post(c, body({ specialties: { mainSpec: 'التصميم', subSpecs: ['واجهات', 'شعارات'] } })), 'portfolio.شعارات', 'MODEL_FILE_REQUIRED');
});

test('a proof that is not in the storage (never finished uploading) is refused; a storage outage fails closed (503); nothing is written either way', async (t) => {
	const c = await controller(t);
	store.exists = async ref => !ref.endsWith('/proof');
	refused(await post(c, body()), 'portfolio.واجهات', 'PROOF_INVALID');
	store.exists = async () => { throw new Error('storage down'); };
	const res = await post(c, body());
	assert.equal(res.statusCode, 503); assert.equal(store.writes, 0);
});

test('a wizard submission without an identity front (nothing stored, no review running) is a 400 DOCUMENT_REQUIRED before any write; a foreign front is DOCUMENT_INVALID', async (t) => {
	const c = await controller(t);
	refused(await post(c, body({ identity: { certs: [] } })), 'identity.frontId', 'DOCUMENT_REQUIRED');
	// a foreign reference or an outside link is stopped by the KYC value guard (its own 400 body): still refused before any write
	for (const frontId of ['private:image:png:waseetai/providers/u2/identity/front', 'https://evil.example/id.png']) {
		const res = await post(c, body({ identity: { frontId, certs: [] } }));
		assert.equal(res.statusCode, 400, frontId); assert.equal(store.writes, 0);
	}
});

test('the identity front already stored (or a review already running) satisfies the identity rule without re-sending it', async (t) => {
	const c = await controller(t, { kycStatus: 'UNVERIFIED', frontIdUrl: FRONT });
	assert.equal((await post(c, body({ identity: { certs: [] } }))).statusCode, 200);
	const c2 = await controller(t, { kycStatus: 'PENDING' });
	assert.equal((await post(c2, body({ identity: { certs: [] } }))).statusCode, 200);
});

test('a complete submission stores the models (file + proof) and ONLY then marks the setup complete', async (t) => {
	const c = await controller(t);
	const res = await post(c, body());
	assert.equal(res.statusCode, 200, JSON.stringify(res.body));
	assert.equal(store.provider.portfolioItems.length, 1);
	assert.equal(store.provider.portfolioItems[0].description, own('work'));
	assert.deepEqual(store.provider.portfolioItems[0].tags, [own('proof')]);
	assert.equal(store.provider.isProfileSetupComplete, true);
});

test('no request shape completes the setup without documents: the same payload WITHOUT the portfolio key stays incomplete', async (t) => {
	const c = await controller(t);
	const res = await post(c, body({ portfolio: undefined }));
	assert.equal(res.statusCode, 200);
	assert.equal(store.provider.isProfileSetupComplete, false);
	const res2 = await post(c, body({ portfolio: null }));
	assert.equal(res2.statusCode, 200);
	assert.equal(store.provider.isProfileSetupComplete, false);
});

test('an already complete profile is not downgraded by a later partial save', async (t) => {
	const c = await controller(t, { kycStatus: 'UNVERIFIED', isProfileSetupComplete: true });
	const res = await post(c, { details: { city: 'جدة' }, agreements: AGREE });
	assert.equal(res.statusCode, 200);
	assert.equal(store.provider.isProfileSetupComplete, true);
});

test('stored models are kept through their row (id + keep flags) when the wizard is resumed and re-submitted', async (t) => {
	const c = await controller(t);
	assert.equal((await post(c, body())).statusCode, 200);
	const row = store.provider.portfolioItems[0];
	const writesBefore = store.writes;
	const res = await post(c, body({ identity: { certs: [] }, portfolio: { 'واجهات': [{ id: row.id, keepReview: true, keepProofs: [0] }] } }));
	assert.equal(res.statusCode, 200, JSON.stringify(res.body));
	assert.ok(store.writes > writesBefore);
	assert.equal(store.provider.portfolioItems[0].description, own('work'));
	assert.deepEqual(store.provider.portfolioItems[0].tags, [own('proof')]);
});
