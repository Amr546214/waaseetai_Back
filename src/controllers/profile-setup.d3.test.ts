import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';

// PR-D3: #17 client setup Zod + agreements, #45 verified identity is frozen / unchanged identity never re-opens a review,
// #13 headline stored where the completion score reads it, #15 GET setup returns portfolioItems.
const mockRes = () => { const r: any = { statusCode: 200, body: undefined }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; };

type W = { cUpsert: any[]; cUpdateMany: any[]; pUpsert: any[]; pUpdateMany: any[]; onbCreate: any[]; onbUpdate: any[] };
let cur: { w: W; stored: any; onboarding: any } = { w: null as any, stored: null, onboarding: null };
const prisma: any = {
	skill: { findMany: async () => [] },
	portfolioItem: { deleteMany: async () => ({}), createMany: async () => ({}) },
	providerProfile: {
		findUnique: async (a: any) => (a.include?.portfolioItems ? { id: 'pp1', portfolioItems: [{ id: 'i1', title: 't' }], skills: [] } : cur.stored),
		upsert: async (a: any) => { cur.w.pUpsert.push(a); return { id: 'pp1', ...cur.stored, ...a.update }; },
		update: async (a: any) => ({ id: 'pp1', ...a.data }),
		updateMany: async (a: any) => { cur.w.pUpdateMany.push(a); return { count: 1 }; }
	},
	clientProfile: {
		findUnique: async () => cur.stored,
		upsert: async (a: any) => { cur.w.cUpsert.push(a); return { id: 'cp1', userId: 'u1', ...cur.stored, ...Object.fromEntries(Object.entries(a.update).filter(([, v]) => v !== undefined)) }; },
		update: async ({ data }: any) => ({ id: 'cp1', ...data }),
		updateMany: async (a: any) => { cur.w.cUpdateMany.push(a); return { count: 1 }; }
	},
	clientOnboarding: {
		findUnique: async () => cur.onboarding,
		create: async ({ data }: any) => { cur.w.onbCreate.push(data); return data; },
		update: async ({ data }: any) => { cur.w.onbUpdate.push(data); return data; }
	},
	user: { findUnique: async () => ({ id: 'u1', status: 'ACTIVE' }), update: async () => ({}) },
	$transaction: async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops({}))
};
const mockedFor = new WeakSet<object>();
function setup(t: TestContext, stored: any = null, onboarding: any = null) {
	cur = { w: { cUpsert: [], cUpdateMany: [], pUpsert: [], pUpdateMany: [], onbCreate: [], onbUpdate: [] }, stored, onboarding };
	if (mockedFor.has(t)) return cur.w;
	mockedFor.add(t);
	t.mock.module('../config/db', { namedExports: { prisma } });
	t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v ?? null, storeKycFileIfNeeded: async (v: any) => (v ? 'private:image:png:x' : null) } });
	t.mock.module('../utils/completion-calculators', { namedExports: { computeProviderCompletion: () => 80, computeClientCompletion: () => 80, computeClientMissingItems: () => [], computeProviderMissingItems: () => [] } });
	t.mock.module('../services/session.service', { namedExports: { sessionService: {} } });
	t.mock.module('../services/provider-profile.service', { namedExports: { providerProfileService: {} } });
	t.mock.module('../services/client-profile.service', { namedExports: { clientProfileService: {} } });
	return cur.w;
}
const IMG = 'data:image/png;base64,AAAA';
const agreements = { accurate: true, terms: true, privacy: true };
const clientBody = (over: any = {}) => ({ details: { idNumber: '1234567890', dob: '1990-05-01T00:00:00.000Z', country: 'السعودية', city: 'الرياض', occupation: 'مهندس', address: 'حي' }, identity: {}, documents: {}, agreements, bank: { paymentType: 'paypal', paypalPayoutEmail: 'a@b.com' }, ...over });
async function client(body: any) {
	const { ClientProfileController } = await import(`./client-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
	const res = mockRes(); let err: any;
	await new ClientProfileController().saveSetupData({ user: { userId: 'u1' }, body } as any, res, (e: any) => { err = e; });
	return { res, err };
}
async function provider(body: any) {
	const { saveSetupData } = await import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
	const res = mockRes();
	await saveSetupData({ user: { id: 'u1' }, body } as any, res);
	return res;
}
const pBody = (details: any = {}, identity: any = {}) => ({ details: { idNumber: '1234567890', occupation: 'مصمم', expYears: '3 الى 5 سنوات', ...details }, identity: { certs: [], ...identity }, bank: {}, documents: {}, agreements, specialties: {}, portfolio: null });

// ── #17 ──
test('#17 client setup: a missing object or a non-true agreement is a 400 with the field named, and nothing is written', async (t) => {
	const w = setup(t);
	for (const [body, field] of [
		[clientBody({ agreements: { accurate: true, terms: false, privacy: true } }), 'agreements.terms'],
		[clientBody({ agreements: { accurate: 'true', terms: true, privacy: true } }), 'agreements.accurate'],
		[clientBody({ agreements: {} }), 'agreements.accurate'],
		[clientBody({ agreements: undefined }), 'agreements'],
		[clientBody({ details: undefined }), 'details'],
		[clientBody({ identity: undefined }), 'identity'],
		[clientBody({ documents: undefined }), 'documents'],
		[{}, 'details'],
	] as const) {
		const { res, err } = await client(body);
		assert.equal(err, undefined, field);
		assert.equal(res.statusCode, 400, field);
		assert.equal(res.body.success, false);
		assert.ok(res.body.errors.some((e: any) => e.field === field), `${field} in ${JSON.stringify(res.body.errors.map((e: any) => e.field))}`);
		assert.match(res.body.message, /[؀-ۿ]/);
	}
	assert.equal(w.cUpsert.length, 0);
});

test('#17 client setup: wrong types / over-long / bad formats are 400, never a 500', async (t) => {
	setup(t);
	for (const [over, field] of [
		[{ details: { ...clientBody().details, city: 123 } }, 'details.city'],
		[{ details: { ...clientBody().details, address: 'x'.repeat(501) } }, 'details.address'],
		[{ details: { ...clientBody().details, idNumber: '123' } }, 'details.idNumber'],
		[{ details: { ...clientBody().details, dob: 'not-a-date' } }, 'details.dob'],
		[{ details: { ...clientBody().details, dob: '2999-01-01' } }, 'details.dob'],
		[{ documents: { notes: 'x'.repeat(1001) } }, 'documents.notes'],
		[{ bank: { paypalPayoutEmail: 'x'.repeat(300) } }, 'bank.paypalPayoutEmail'],
	] as const) {
		const { res } = await client(clientBody(over));
		assert.equal(res.statusCode, 400, field);
		assert.ok(res.body.errors.some((e: any) => e.field === field), field);
	}
});

test('#17 the payload the wizard really sends (4 objects, agreements all true, PayPal, ISO dob, empty uploads) is accepted', async (t) => {
	const w = setup(t);
	const { res } = await client(clientBody({ identity: { frontId: '', backId: '' }, documents: { supportingDocs: '', notes: '' } }));
	assert.equal(res.statusCode, 200);
	assert.equal(w.cUpsert.length, 1);
	assert.equal(w.cUpsert[0].update.termsAgreed, true);
});

// ── #45 ──
const verified = { idNumber: '1234567890', dob: new Date('1990-05-01T00:00:00.000Z'), kycStatus: 'VERIFIED' };

test('#45 client: a VERIFIED account cannot change idNumber or dob (409 Arabic, nothing written); the same values pass', async (t) => {
	const w = setup(t, verified);
	for (const details of [{ ...clientBody().details, idNumber: '2234567890' }, { ...clientBody().details, dob: '1991-01-01T00:00:00.000Z' }]) {
		const { err } = await client(clientBody({ details }));
		assert.equal(err?.statusCode, 409);
		assert.match(err.message, /بعد توثيق حسابك/);
	}
	assert.equal(w.cUpsert.length, 0);
	const { res, err } = await client(clientBody());
	assert.equal(err, undefined);
	assert.equal(res.statusCode, 200);
	assert.equal(w.cUpsert.length, 1);
});

test('#45 client: omitting idNumber/dob on a VERIFIED account keeps the stored values (not erased)', async (t) => {
	const w = setup(t, verified);
	await client(clientBody({ details: { country: 'السعودية', city: 'جدة' } }));
	const up = w.cUpsert[0].update;
	assert.equal(up.idNumber, undefined);
	assert.equal(up.dob, undefined);
});

test('#45 client: re-saving the SAME identity (no new documents) does not re-open a review; a changed idNumber or a new document does', async (t) => {
	const stored = { idNumber: '1234567890', dob: new Date('1990-05-01T00:00:00.000Z'), kycStatus: 'REJECTED', frontIdUrl: 'private:image:png:a', backIdUrl: 'private:image:png:b' };
	const rejected = { userId: 'u1', status: 'REJECTED', documentUrl: 'x' };
	let w = setup(t, stored, rejected);
	await client(clientBody());
	assert.equal(w.cUpdateMany.length, 0, 'kycStatus stays REJECTED');
	assert.equal(w.onbUpdate.length, 0, 'the rejected review is not re-opened');

	// the stored row keeps its documents (the mock upsert merges them), so a changed idNumber alone re-submits
	w = setup(t, stored, rejected);
	await client(clientBody({ details: { ...clientBody().details, idNumber: '2234567890' } }));
	assert.equal(w.cUpdateMany[0]?.data.kycStatus, 'PENDING');
	assert.equal(w.onbUpdate[0]?.status, 'PENDING');

	w = setup(t, stored, rejected);
	await client(clientBody({ identity: { frontId: IMG, backId: IMG } }));
	assert.equal(w.cUpdateMany[0]?.data.kycStatus, 'PENDING', 'a newly uploaded document re-submits');
});

test('#45 provider: a VERIFIED account cannot change idNumber or dob (409 Arabic JSON, nothing written)', async (t) => {
	const w = setup(t, verified);
	for (const details of [{ idNumber: '2234567890' }, { dob: '1991-01-01' }]) {
		const res = await provider(pBody(details));
		assert.equal(res.statusCode, 409);
		assert.match(res.body.message, /بعد توثيق حسابك/);
	}
	assert.equal(w.pUpsert.length, 0);
	assert.equal((await provider(pBody({ dob: '1990-05-01' }))).statusCode, 200);
});

test('#45 provider: an unchanged identity never moves UNVERIFIED/REJECTED to PENDING; a changed one does', async (t) => {
	const stored = { idNumber: '1234567890', dob: null, kycStatus: 'REJECTED', frontIdUrl: 'private:image:png:a', backIdUrl: 'private:image:png:b' };
	let w = setup(t, stored);
	await provider(pBody());
	assert.equal(w.pUpdateMany.length, 0);
	w = setup(t, stored);
	await provider(pBody({ idNumber: '2234567890' }));
	assert.equal(w.pUpdateMany[0]?.data.kycStatus, 'PENDING');
	assert.deepEqual(w.pUpdateMany[0].where.kycStatus, { in: ['UNVERIFIED', 'REJECTED'] });
});

// ── #13 / #15 ──
test('#13 provider wizard stores the job title as headline (and industry), not only industry', async (t) => {
	const w = setup(t, { kycStatus: 'UNVERIFIED' });
	await provider(pBody({ occupation: '  <b>مصمم</b> واجهات ' }));
	const up = w.pUpsert[0].update;
	assert.equal(up.headline, 'مصمم واجهات');
	assert.equal(up.industry, '  <b>مصمم</b> واجهات ');
});

test('#13 the completion "identity" rule counts the headline OR an older wizard save that only has industry', async () => {
	const { computeProviderCompletion } = await import(`../utils/completion-calculators.ts?f=${Math.random()}`);
	const base = { providerProfile: { firstName: 'أ', lastName: 'ب', mainSpecialty: 'تصميم' }, user: {} };
	const only = (pp: any) => computeProviderCompletion({ ...base, providerProfile: { ...base.providerProfile, ...pp } });
	assert.equal(only({ headline: 'مصمم' }), 15);
	assert.equal(only({ industry: 'مصمم' }), 15);
	assert.equal(only({}), 0);
});

test('#15 GET provider setup returns portfolioItems', async (t) => {
	setup(t);
	const { getSetupData } = await import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
	const res = mockRes();
	await getSetupData({ user: { id: 'u1' } } as any, res);
	assert.deepEqual(res.body.data.portfolioItems, [{ id: 'i1', title: 't' }]);
});
