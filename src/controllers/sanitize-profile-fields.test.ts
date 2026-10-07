import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { updateProfileSchema } from '../dtos/profile.dto';
import { updateBasicsSchema, updateContactSchema, updateIdentitySchema, updateBankingSchema } from '../dtos/profile-tab.dto';
import { clientSetupSchema } from '../dtos/client-profile-setup.dto';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';

// #25 — every free-text profile field strips markup (stored as plain text, never double-escaped by Angular).
const XSS = (word: string) => `<img src=x onerror=alert(1)><b>${word}</b><script></script>`;

test('PUT /profiles/update: companyName, companySize, industry, headline, location, city, country, bio are sanitised', () => {
	const r: any = updateProfileSchema.parse({ companyName: XSS('شركة'), companySize: XSS('10'), industry: XSS('تقنية'), headline: XSS('مصمم'), location: XSS('الرياض'), city: XSS('جدة'), country: XSS('مصر'), bio: XSS('نبذة') });
	assert.deepEqual([r.companyName, r.companySize, r.industry, r.headline, r.location, r.city, r.country, r.bio], ['شركة', '10', 'تقنية', 'مصمم', 'الرياض', 'جدة', 'مصر', 'نبذة']);
});

test('PUT /profiles/update/:tab: contact (address, region, city, country), identity (nationality, country, city), banking (names) and basics are sanitised', () => {
	const c: any = updateContactSchema.parse({ address: XSS('حي'), region: XSS('منطقة'), city: XSS('مدينة'), country: XSS('بلد'), firstName: XSS('سارة') });
	assert.deepEqual([c.address, c.region, c.city, c.country, c.firstName], ['حي', 'منطقة', 'مدينة', 'بلد', 'سارة']);
	const i: any = updateIdentitySchema.parse({ nationality: XSS('سعودي'), country: XSS('السعودية'), city: XSS('الدمام') });
	assert.deepEqual([i.nationality, i.country, i.city], ['سعودي', 'السعودية', 'الدمام']);
	const b: any = updateBankingSchema.parse({ accountHolderName: XSS('أحمد'), bankName: XSS('بنك'), walletProvider: XSS('محفظة') });
	assert.deepEqual([b.accountHolderName, b.bankName, b.walletProvider], ['أحمد', 'بنك', 'محفظة']);
	assert.equal((updateBasicsSchema.parse({ lastName: XSS('علي') }) as any).lastName, 'علي');
});

test('POST /client/profile/setup: details and notes are sanitised (POST /profiles/setup is covered in PR-G)', () => {
	const c: any = clientSetupSchema.parse({ details: { country: XSS('مصر'), city: XSS('القاهرة'), occupation: XSS('مهندس'), address: XSS('شارع') }, identity: {}, documents: { notes: XSS('ملاحظة') }, agreements: { accurate: true, terms: true, privacy: true } });
	assert.deepEqual([c.details.country, c.details.city, c.details.occupation, c.details.address, c.documents.notes], ['مصر', 'القاهرة', 'مهندس', 'شارع', 'ملاحظة']);
});

test('markup-only values become empty and Arabic prose / "5 < 6" is left alone', () => {
	assert.equal((updateContactSchema.parse({ address: '<b></b>' }) as any).address, '');
	assert.equal((updateContactSchema.parse({ address: 'شقة 5 < 6 في الحي' }) as any).address, 'شقة 5 < 6 في الحي');
});

// provider wizard (controller reads the raw body, so it sanitises itself)
const mockRes = () => { const r: any = { statusCode: 200, body: undefined }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; };
const mockedFor = new WeakSet<object>();
function setup(t: TestContext) {
	const w: any = { upsert: [], portfolio: [] };
	if (mockedFor.has(t)) return w;
	mockedFor.add(t);
	const prisma: any = {
		skill: { findMany: async () => [] },
		portfolioItem: { deleteMany: async () => ({}), createMany: async ({ data }: any) => { w.portfolio.push(...data); return {}; } },
		providerProfile: { findUnique: async () => ({ id: 'pp1', kycStatus: 'UNVERIFIED', skills: [], portfolioItems: [] }), upsert: async (a: any) => { w.upsert.push(a); return { id: 'pp1', ...a.create }; }, update: async ({ data }: any) => ({ id: 'pp1', ...data }), updateMany: async () => ({ count: 0 }) },
		user: { findUnique: async () => ({ id: 'u1', status: 'ACTIVE' }) },
		$transaction: async (ops: any) => Promise.all(ops)
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	t.mock.module('../utils/cloudinary-storage', { namedExports: { storeDataUriIfNeeded: async (v: any) => v ?? null, storeKycFileIfNeeded: async (v: any) => v ?? null } });
	t.mock.module('../utils/completion-calculators', { namedExports: { computeProviderCompletion: () => 80 } });
	t.mock.module('../services/session.service', { namedExports: { sessionService: {} } });
	t.mock.module('../services/provider-profile.service', { namedExports: { providerProfileService: {} } });
	return w;
}

test('provider wizard: occupation, country, city, address, languages, specialties, bank names, notes, portfolio review/title are sanitised before storing', async (t) => {
	const w = setup(t);
	const { saveSetupData } = await import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
	const body = {
		details: { occupation: XSS('مصمم'), country: XSS('السعودية'), city: XSS('جدة'), address: XSS('حي'), languages: [XSS('العربية')], bio: XSS('نبذة') },
		identity: { certs: [] }, bank: { bankName: XSS('بنك'), accountHolder: XSS('أحمد') }, documents: { notes: XSS('ملاحظة') }, agreements: {},
		specialties: { mainSpec: XSS('تصميم'), subSpecs: [XSS('شعارات')] }, portfolio: { [XSS('تصميم')]: [{ review: XSS('عمل ممتاز'), proofs: [] }] }
	};
	const res = mockRes();
	await saveSetupData({ user: { id: 'u1' }, body } as any, res);
	assert.equal(res.statusCode, 200);
	const u = w.upsert[0].update;
	assert.deepEqual([u.industry, u.headline, u.country, u.city, u.address, u.languages, u.mainSpecialty, u.subSpecialties, u.bankName, u.accountHolder, u.notes],
		['مصمم', 'مصمم', 'السعودية', 'جدة', 'حي', ['العربية'], 'تصميم', ['شعارات'], 'بنك', 'أحمد', 'ملاحظة']);
	assert.equal(w.portfolio[0].description, 'عمل ممتاز');
	assert.equal(w.portfolio[0].title, 'نموذج أعمال - تصميم');
	assert.doesNotMatch(JSON.stringify(w), /<script|<img|<b>|onerror/);
});
