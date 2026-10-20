import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test (throw-away database): the provider setup save is ALL-OR-NOTHING and only touches the setup models.
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_<x> npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --experimental-test-module-mocks --test src/controllers/provider-setup-atomic.pg.test.ts
 * The storage is replaced by a fake (an upload whose payload contains FAILUPLOAD throws); the database is the real one.
 */
process.env.OPENAI_API_KEY = 'test-key';
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

const AGREE = { accurate: true, terms: true, privacy: true };
const warnings: string[] = [];
let uploadCalls = 0;
function mkRes() { const r: any = { statusCode: null, body: null }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; }
let wired = false;
async function load(t: any) {
	if (!wired) {
		wired = true;
		const real = await import('../utils/cloudinary-storage');
		t.mock.module('../utils/cloudinary-storage', { namedExports: { ...real,
			privateFileExists: async () => true,
			storeDataUriIfNeeded: async (v: any, folder: string, name: string) => { if (typeof v === 'string' && v.startsWith('data:')) { uploadCalls++; if (v.includes('FAILUPLOAD')) throw new Error('storage down'); return `https://res.cloudinary.com/demo/image/upload/v1/${folder}/${name}.pdf`; } return v ?? null; },
			storeKycFileIfNeeded: async (v: any, folder: string, name: string) => { if (typeof v === 'string' && v.startsWith('data:')) { uploadCalls++; if (v.includes('FAILUPLOAD')) throw new Error('storage down'); return `private:image:png:${folder}/${name}`; } return v ?? null; },
		} });
		t.mock.module('../config/logger', { namedExports: { logger: { info() {}, error() {}, debug() {}, warn: (m: string) => warnings.push(String(m)) } } });
	}
	const { prisma } = await import('../config/db');
	const controller = await import('./provider-profile.controller');
	const { specialtyService } = await import('../services/specialty.service');
	return { prisma, controller, specialtyService };
}
async function seed(prisma: any, stored: Record<string, any> = {}) {
	const id = randomUUID();
	await prisma.user.create({ data: { id, accountType: 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: 'Atomic', email: `atomic-${id.slice(0, 8)}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } as any });
	const profile = await prisma.providerProfile.create({ data: { userId: id, ...stored } as any });
	return { id, profile };
}
const own = (id: string, n: string) => `private:raw:pdf:waseetai/providers/${id}/documents/${n}`;
const body = (id: string, over: any = {}) => ({
	details: { occupation: 'مصمم واجهات', country: 'السعودية', city: 'الرياض', bio: 'خبرة طويلة في التصميم', expYears: '5 الى 10 سنوات' },
	specialties: { mainSpec: 'التصميم', subSpecs: ['واجهات'] }, identity: { frontId: `private:image:png:waseetai/providers/${id}/identity/front`, certs: [] }, agreements: AGREE,
	portfolio: { 'واجهات': [{ review: own(id, 'work'), proofs: [own(id, 'proof')] }] }, ...over,
});
async function save(controller: any, id: string, b: any) { const res = mkRes(); await controller.saveSetupData({ user: { id }, body: b } as any, res); return res; }
async function snapshot(prisma: any, id: string) {
	const p = await prisma.providerProfile.findUnique({ where: { userId: id }, include: { portfolioItems: { orderBy: { title: 'asc' } }, providerSpecialties: true, skills: true } });
	return JSON.stringify({ ...p, portfolioItems: p.portfolioItems.map((i: any) => [i.id, i.title, i.description, i.tags, i.coverImage]), specialties: p.providerSpecialties.map((s: any) => s.id) });
}

test('PG: a file upload that fails BEFORE the database writes: nothing changes (profile, specialties, models, completion flag), and the files already uploaded are reported', opts, async (t) => {
	const { prisma, controller } = await load(t);
	const { id } = await seed(prisma, { frontIdUrl: `private:image:png:waseetai/providers/__ID__/identity/front` });
	await prisma.providerProfile.update({ where: { userId: id }, data: { frontIdUrl: `private:image:png:waseetai/providers/${id}/identity/front` } });
	const before = await snapshot(prisma, id);
	warnings.length = 0; uploadCalls = 0;
	// the new identity front uploads fine (first), then a proof upload fails: the request fails and the front that already reached the storage is reported
	const res = await save(controller, id, body(id, { identity: { frontId: 'data:image/png;base64,AAAA', certs: [] }, portfolio: { 'واجهات': [{ review: 'data:application/pdf;base64,AAAA', proofs: ['data:application/pdf;base64,FAILUPLOAD'] }] } }));
	assert.equal(res.statusCode, 500);
	assert.equal(await snapshot(prisma, id), before, 'nothing of the request was written');
	assert.ok(uploadCalls >= 1);
	assert.ok(warnings.some(w => /\[ProviderSetup\]/.test(w) && /1 file\(s\) were uploaded/.test(w) && /identity\/front-id/.test(w)), 'the files uploaded before the failure are listed apart from the error');
});

test('PG: a database failure INSIDE the transaction (after the profile row and before the models) rolls EVERYTHING back', opts, async (t) => {
	const { prisma, controller, specialtyService } = await load(t);
	const { id } = await seed(prisma, { bio: 'نبذة قديمة', city: 'جدة' });
	const before = await snapshot(prisma, id);
	t.mock.method(specialtyService, 'syncProviderSpecialtiesFromProfile', async () => { throw new Error('sync failed'); });
	const res = await save(controller, id, body(id));
	assert.equal(res.statusCode, 500);
	assert.equal(await snapshot(prisma, id), before, 'profile fields, models, flag: all unchanged after the rollback');
});

test('PG: the setup models are replaced but the provider\'s ORDINARY portfolio works are never touched', opts, async (t) => {
	const { prisma, controller } = await load(t);
	const { id, profile } = await seed(prisma);
	await prisma.portfolioItem.createMany({ data: [
		{ providerProfileId: profile.id, title: 'مشروعي الأول', description: 'عمل عادي', tags: ['a'] },
		{ providerProfileId: profile.id, title: 'متجر إلكتروني', description: 'عمل ثانٍ', tags: [] },
		{ providerProfileId: profile.id, title: 'نموذج أعمال - قديم', description: own(id, 'old'), tags: [own(id, 'oldp')] },
	] });
	const ordinaryBefore = JSON.stringify((await prisma.portfolioItem.findMany({ where: { providerProfileId: profile.id, NOT: { title: { startsWith: 'نموذج أعمال - ' } } }, orderBy: { title: 'asc' } })));
	const res = await save(controller, id, body(id));
	assert.equal(res.statusCode, 200, JSON.stringify(res.body));
	const ordinaryAfter = JSON.stringify((await prisma.portfolioItem.findMany({ where: { providerProfileId: profile.id, NOT: { title: { startsWith: 'نموذج أعمال - ' } } }, orderBy: { title: 'asc' } })));
	assert.equal(ordinaryAfter, ordinaryBefore, 'ordinary works unchanged');
	const models = await prisma.portfolioItem.findMany({ where: { providerProfileId: profile.id, title: { startsWith: 'نموذج أعمال - ' } } });
	assert.deepEqual(models.map(m => m.title), ['نموذج أعمال - واجهات'], 'the old setup model was replaced by the new one');
});

test('PG: a PENDING account with NO stored document does not complete the setup and the message names the identity front; nothing is written', opts, async (t) => {
	const { prisma, controller } = await load(t);
	const { id } = await seed(prisma, { kycStatus: 'PENDING' });
	const before = await snapshot(prisma, id);
	const res = await save(controller, id, body(id, { identity: { certs: [] } }));
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.errors[0].field, 'identity.frontId');
	assert.equal(await snapshot(prisma, id), before);
	// the same account saving WITHOUT the wizard payload is saved but never complete
	const partial = await save(controller, id, body(id, { identity: { certs: [] }, portfolio: undefined }));
	assert.equal(partial.statusCode, 200);
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: id } }))!.isProfileSetupComplete, false);
});

test('PG: DELETE of a required setup model is refused (rows and completion flag unchanged); an ordinary work can still be deleted', opts, async (t) => {
	const { prisma, controller } = await load(t);
	const { id } = await seed(prisma);
	assert.equal((await save(controller, id, body(id))).statusCode, 200);
	const profile = await prisma.providerProfile.findUnique({ where: { userId: id }, include: { portfolioItems: true } });
	assert.equal(profile!.isProfileSetupComplete, true);
	const ordinary = await prisma.portfolioItem.create({ data: { providerProfileId: profile!.id, title: 'عمل عادي', description: 'x', tags: [] } });
	const model = profile!.portfolioItems.find(i => i.title.startsWith('نموذج أعمال - '))!;
	const before = await snapshot(prisma, id);
	const del = mkRes(); await controller.deletePortfolioItem({ user: { id }, params: { id: model.id } } as any, del);
	assert.equal(del.statusCode, 400);
	assert.match(del.body.message, /مطلوب/);
	assert.equal(await snapshot(prisma, id), before);
	const del2 = mkRes(); await controller.deletePortfolioItem({ user: { id }, params: { id: ordinary.id } } as any, del2);
	assert.notEqual(del2.statusCode, 400); assert.notEqual(del2.statusCode, 500);
	assert.equal(await prisma.portfolioItem.count({ where: { id: ordinary.id } }), 0);
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: id } }))!.isProfileSetupComplete, true);
});

test('PG: a PENDING account whose ID document is a DOCUMENTS request waiting for the admin (or the approved account document) DOES have a document on file; a foreign one does not', opts, async (t) => {
	const { prisma, controller } = await load(t);
	const a = await seed(prisma, { kycStatus: 'PENDING' });
	await prisma.profileModificationRequest.create({ data: { providerId: a.id, fieldName: 'idDocumentUrl', fieldLabel: 'الهوية', requestedValue: `private:image:png:waseetai/providers/${a.id}/documents/id`, category: 'DOCUMENTS', status: 'PENDING_HUMAN_REVIEW' as any } });
	const ok = await save(controller, a.id, body(a.id, { identity: { certs: [] } }));
	assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: a.id } }))!.isProfileSetupComplete, true);
	const b = await seed(prisma, { kycStatus: 'PENDING' });
	await prisma.profileModificationRequest.create({ data: { providerId: b.id, fieldName: 'idDocumentUrl', fieldLabel: 'الهوية', requestedValue: `private:image:png:waseetai/providers/${randomUUID()}/documents/id`, category: 'DOCUMENTS', status: 'PENDING_HUMAN_REVIEW' as any } });
	const before = await snapshot(prisma, b.id);
	const no = await save(controller, b.id, body(b.id, { identity: { certs: [] } }));
	assert.equal(no.statusCode, 400);
	assert.equal(no.body.errors[0].field, 'identity.frontId');
	assert.equal(await snapshot(prisma, b.id), before);
});

test('PG: a PENDING account with NO document can send the missing front (no 409 dead end) and then completes; with a document on file a NEW front is still refused (409)', opts, async (t) => {
	const { prisma, controller } = await load(t);
	const a = await seed(prisma, { kycStatus: 'PENDING' });
	const ok = await save(controller, a.id, body(a.id));
	assert.equal(ok.statusCode, 200);
	const stored = await prisma.providerProfile.findUnique({ where: { userId: a.id } });
	assert.ok(stored!.frontIdUrl, 'the missing document is stored');
	assert.equal(stored!.isProfileSetupComplete, true);
	const b = await seed(prisma, { kycStatus: 'PENDING', frontIdUrl: `private:image:png:waseetai/providers/__ID__/identity/old` });
	await prisma.providerProfile.update({ where: { userId: b.id }, data: { frontIdUrl: `private:image:png:waseetai/providers/${b.id}/identity/old` } });
	const before = await snapshot(prisma, b.id);
	const refused = await save(controller, b.id, body(b.id));
	assert.equal(refused.statusCode, 409);
	assert.equal(await snapshot(prisma, b.id), before);
});
