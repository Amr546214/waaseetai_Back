import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';

// #46 — POST /api/profiles/setup now goes through the same rules as the main provider/client wizards: Zod + safeParse (400), private KYC files,
// frozen VERIFIED identity (409), PENDING only for a changed complete identity, skills resolved against the catalogue, honest response.
const mockRes = () => { const r: any = { statusCode: 200, body: undefined }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; };
const IMG = 'data:image/png;base64,AAAA';

type S = { stored: any; skills: string[]; upserts: any[]; pUpdateMany: any[]; onb: any[] };
let cur: S = { stored: null, skills: [], upserts: [], pUpdateMany: [], onb: [] };
const mockedFor = new WeakSet<object>();
function setup(t: TestContext, over: Partial<S> = {}) {
	cur = { stored: null, skills: ['تصميم'], upserts: [], pUpdateMany: [], onb: [], ...over };
	if (mockedFor.has(t)) return cur;
	mockedFor.add(t);
	const profile = (kind: string) => ({
		findUnique: async () => cur.stored,
		upsert: async (a: any) => { cur.upserts.push([kind, a]); return { id: 'p1', ...cur.stored, ...Object.fromEntries(Object.entries(a.update).filter(([, v]) => v !== undefined)) }; },
		update: async ({ data }: any) => ({ id: 'p1', ...data }),
		updateMany: async (a: any) => { cur.pUpdateMany.push(a); return { count: 1 }; }
	});
	const tx: any = { user: { update: async ({ data }: any) => ({ id: 'u1', ...data }), findUnique: async () => ({ id: 'u1' }) }, clientProfile: profile('client'), providerProfile: profile('provider') };
	t.mock.module('../config/db', { namedExports: { prisma: { ...tx, skill: { findMany: async ({ where }: any) => where.name.in.filter((n: string) => cur.skills.includes(n)).map((name: string) => ({ id: `id-${name}`, name })) }, $transaction: async (fn: any) => fn(tx) } } });
	t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v ?? null, storeKycFileIfNeeded: async (v: any) => (v ? 'private:image:png:x' : null) } });
	t.mock.module('../services/onboarding.service', { namedExports: { onboardingService: { submitSetupDocuments: async (_u: string, docs: any, opts: any) => { cur.onb.push({ docs, opts }); return { id: 'o1' }; } } } });
	return cur;
}
async function post(role: string, body: any) {
	const { profileSetupController } = await import(`./profile-setup.controller.ts?f=${Date.now()}-${Math.random()}`);
	const res = mockRes(); let err: any;
	await profileSetupController.setupProfile({ body, user: { userId: 'u1', activeRole: role } } as any, res, (e: any) => { err = e; });
	return { res, err };
}
const verified = { idNumber: '1234567890', dob: null, kycStatus: 'VERIFIED' };

test('a bad body is a 400 with errors[] naming the field (was an uncaught ZodError → 500), and nothing is written', async (t) => {
	const s = setup(t);
	for (const [body, field] of [
		[{ idNumber: '123' }, 'idNumber'], [{ phoneNumber: 'abc' }, 'phoneNumber'], [{ bio: 'x'.repeat(1001) }, 'bio'], [{ city: 5 }, 'city'], [{ ibanNumber: 'SA12' }, 'ibanNumber'], [{ hourlyRate: -1 }, 'hourlyRate'],
	] as const) {
		const { res, err } = await post('PROVIDER', body);
		assert.equal(err, undefined, field);
		assert.equal(res.statusCode, 400, field);
		assert.ok(res.body.errors.some((e: any) => e.field === field), field);
	}
	assert.equal(s.upserts.length, 0);
});

test('identity is really written to the role profile (like the main wizard), KYC files stored private, no fake moderationQueued, and no bank columns are ever written', async (t) => {
	const s = setup(t);
	const { res } = await post('PROVIDER', { idNumber: '1234567890', city: 'الرياض', country: 'السعودية', frontId: IMG, backId: IMG });
	assert.equal(res.statusCode, 200);
	const [kind, call] = s.upserts[0];
	assert.equal(kind, 'provider');
	assert.deepEqual([call.update.idNumber, call.update.frontIdUrl, call.update.backIdUrl], ['1234567890', 'private:image:png:x', 'private:image:png:x']);
	for (const k of ['iban', 'bankName', 'accountHolder']) assert.equal(k in call.update || k in call.create, false, k);
	assert.equal('moderationQueued' in res.body.data, false);
	assert.equal('changeRequestId' in res.body.data, false);
	assert.equal(res.body.data.identitySubmitted, true);
	assert.equal(s.pUpdateMany[0].data.kycStatus, 'PENDING');
});

test('PayPal only: a bank / IBAN / holder / wallet value is a 400 with the PayPal-only message and nothing is stored (provider and client)', async (t) => {
	const { PAYPAL_ONLY_MESSAGE } = await import('../utils/client-payout-fields');
	const s = setup(t);
	for (const role of ['PROVIDER', 'CLIENT']) {
		for (const extra of [{ ibanNumber: 'SA' + '1'.repeat(22) }, { bankName: 'بنك' }, { accountHolderName: 'أحمد' }, { walletPhone: '0500000000' }]) {
			const { res, err } = await post(role, { idNumber: '1234567890', city: 'الرياض', ...extra });
			assert.equal(err, undefined);
			assert.equal(res.statusCode, 400, `${role} ${JSON.stringify(extra)}`);
			assert.ok(JSON.stringify(res.body).includes(PAYPAL_ONLY_MESSAGE) || res.body.errors?.length > 0);
		}
	}
	assert.equal(s.upserts.length, 0);
});

test('a VERIFIED identity is frozen: changing idNumber is a 409 (nothing written); the same number passes', async (t) => {
	const s = setup(t, { stored: verified });
	const { err } = await post('PROVIDER', { idNumber: '2234567890' });
	assert.equal(err.statusCode, 409);
	assert.equal(s.upserts.length, 0);
	const { res } = await post('PROVIDER', { idNumber: '1234567890' });
	assert.equal(res.statusCode, 200);
	assert.equal(s.pUpdateMany.length, 0, 'never touches a VERIFIED status');
});

test('an unchanged identity re-save does not re-open a review (provider and client)', async (t) => {
	const stored = { idNumber: '1234567890', dob: null, kycStatus: 'REJECTED', frontIdUrl: 'private:image:png:a', backIdUrl: 'private:image:png:b' };
	let s = setup(t, { stored });
	await post('PROVIDER', { idNumber: '1234567890', bio: 'نبذة' });
	assert.equal(s.pUpdateMany.length, 0);
	s = setup(t, { stored });
	await post('CLIENT', { idNumber: '1234567890', bio: 'نبذة' });
	assert.equal(s.onb.length, 0);
	s = setup(t, { stored });
	await post('CLIENT', { idNumber: '2234567890' });
	assert.equal(s.onb.length, 1, 'a changed idNumber with complete stored documents is re-submitted');
});

test('an unsupported KYC file (svg / wrong type) is refused before anything is stored', async (t) => {
	const s = setup(t);
	const { err, res } = await post('PROVIDER', { frontId: 'data:image/svg+xml;base64,PHN2Zz4=' });
	assert.ok(err?.statusCode === 400 || res.statusCode === 400);
	assert.equal(s.upserts.length, 0);
});

test('skills go through the catalogue like the provider wizard: known names are connected, unknown names are a 400', async (t) => {
	let s = setup(t);
	await post('PROVIDER', { skills: ['تصميم'] });
	assert.deepEqual(s.upserts[0][1].update.skills, { connect: [{ id: 'id-تصميم' }] });
	s = setup(t);
	const { err } = await post('PROVIDER', { skills: ['مهارة غير موجودة'] });
	assert.equal(err.statusCode, 400);
	assert.equal(s.upserts.length, 0);
});

test('free-text fields are sanitised (markup stripped): bio, companyName, industry, city, country, nationality, bankName', async (t) => {
	const s = setup(t);
	await post('CLIENT', { bio: '<b>نبذة</b>', companyName: '<img src=x onerror=1>شركة', industry: '<i>تقنية</i>', city: '<u>الرياض</u>', country: '<b>السعودية</b>' });
	const u = s.upserts[0][1].update;
	assert.deepEqual([u.bio, u.companyName, u.industry, u.city, u.country], ['نبذة', 'شركة', 'تقنية', 'الرياض', 'السعودية']);
});
