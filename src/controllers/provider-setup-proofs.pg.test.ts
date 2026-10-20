import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test: the provider setup request is refused for a missing / reused / unreadable proof or a missing identity front BEFORE any write, on a throw-away
 * database; a complete request stores the models in one transaction and only then marks the setup complete; no request shape completes it without documents.
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_<x> npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --experimental-test-module-mocks --test src/controllers/provider-setup-proofs.pg.test.ts
 */
process.env.OPENAI_API_KEY = 'test-key';
process.env.CLOUDINARY_CLOUD_NAME = 'local-dev'; // storage stat check answers "exists" and data: URIs are stored locally: no network
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

const AGREE = { accurate: true, terms: true, privacy: true };
function mkRes() { const r: any = { statusCode: null, body: null }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; }
async function seed(stored: Record<string, any> = {}) {
	const { prisma } = await import('../config/db');
	const id = randomUUID();
	await prisma.user.create({ data: { id, accountType: 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: 'Proof', email: `proof-${id.slice(0, 8)}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } as any });
	await prisma.providerProfile.create({ data: { userId: id, ...stored } as any });
	return { prisma, id };
}
const own = (id: string, n: string) => `private:raw:pdf:waseetai/providers/${id}/documents/${n}`;
const body = (id: string, over: any = {}) => ({
	details: { occupation: 'مصمم واجهات', country: 'السعودية', city: 'الرياض', bio: 'خبرة طويلة في التصميم', expYears: '5 الى 10 سنوات' },
	specialties: { mainSpec: 'التصميم', subSpecs: ['واجهات'] }, identity: { frontId: `private:image:png:waseetai/providers/${id}/identity/front`, certs: [] }, agreements: AGREE,
	portfolio: { 'واجهات': [{ review: own(id, 'work'), proofs: [own(id, 'proof')] }] }, ...over,
});
async function save(id: string, b: any) { const { saveSetupData } = await import('./provider-profile.controller'); const res = mkRes(); await saveSetupData({ user: { id }, body: b } as any, res); return res; }
const snapshot = async (prisma: any, id: string) => { const p = await prisma.providerProfile.findUnique({ where: { userId: id }, include: { portfolioItems: true } }); return JSON.stringify({ ...p, portfolioItems: p.portfolioItems.map((i: any) => [i.title, i.description, i.tags]) }); };

test('PG: no proof / the model file reused as proof / a chosen sub-specialty without a model: 400 and the stored profile is byte-identical afterwards', opts, async () => {
	const { prisma, id } = await seed();
	const before = await snapshot(prisma, id);
	for (const portfolio of [{ 'واجهات': [{ review: own(id, 'work'), proofs: [] }] }, { 'واجهات': [{ review: own(id, 'work'), proofs: [own(id, 'work')] }] }, {}]) {
		const res = await save(id, body(id, { portfolio }));
		assert.equal(res.statusCode, 400, JSON.stringify(res.body));
		assert.match(JSON.stringify(res.body.errors), /portfolio\.واجهات/);
		assert.equal(await snapshot(prisma, id), before);
	}
});

test('PG: a wizard submission without an identity front is a 400 before any write, naming identity.frontId', opts, async () => {
	const { prisma, id } = await seed();
	const before = await snapshot(prisma, id);
	const res = await save(id, body(id, { identity: { certs: [] } }));
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.errors[0].field, 'identity.frontId');
	assert.equal(await snapshot(prisma, id), before);
});

test('PG: another account\'s proof reference is refused, nothing written', opts, async () => {
	const { prisma, id } = await seed();
	const other = randomUUID();
	const before = await snapshot(prisma, id);
	const res = await save(id, body(id, { portfolio: { 'واجهات': [{ review: own(id, 'work'), proofs: [own(other, 'proof')] }] } }));
	assert.equal(res.statusCode, 400);
	assert.equal(await snapshot(prisma, id), before);
});

test('PG: a complete submission stores file + proof per model in one go and ONLY then marks the setup complete; a re-submit keeps them through the stored row', opts, async () => {
	const { prisma, id } = await seed();
	const res = await save(id, body(id));
	assert.equal(res.statusCode, 200, JSON.stringify(res.body));
	const p = await prisma.providerProfile.findUnique({ where: { userId: id }, include: { portfolioItems: true } });
	assert.equal(p!.isProfileSetupComplete, true);
	assert.equal(p!.portfolioItems.length, 1);
	assert.equal(p!.portfolioItems[0].description, own(id, 'work'));
	assert.deepEqual(p!.portfolioItems[0].tags, [own(id, 'proof')]);
	const row = p!.portfolioItems[0];
	const again = await save(id, body(id, { identity: { certs: [] }, portfolio: { 'واجهات': [{ id: row.id, keepReview: true, keepProofs: [0] }] } }));
	assert.equal(again.statusCode, 200, JSON.stringify(again.body));
	const p2 = await prisma.providerProfile.findUnique({ where: { userId: id }, include: { portfolioItems: true } });
	assert.deepEqual(p2!.portfolioItems.map(i => [i.description, i.tags]), [[own(id, 'work'), [own(id, 'proof')]]]);
});

test('PG: the same text-only payload WITHOUT the portfolio key (or with null) is saved but the setup stays NOT complete', opts, async () => {
	const { prisma, id } = await seed();
	for (const portfolio of [undefined, null]) {
		const res = await save(id, body(id, { portfolio }));
		assert.equal(res.statusCode, 200, JSON.stringify(res.body));
		assert.equal((await prisma.providerProfile.findUnique({ where: { userId: id } }))!.isProfileSetupComplete, false);
	}
});

test('PG: the free portfolio endpoints cannot forge a setup model row (reserved title) so the stored evidence cannot be faked', opts, async () => {
	const { prisma, id } = await seed({ subSpecialties: ['واجهات'] });
	const { providerProfileService } = await import('../services/provider-profile.service');
	await assert.rejects(() => providerProfileService.addPortfolioItem(id, { title: 'نموذج أعمال - واجهات', description: 'x', tags: ['x'] }), (e: any) => e.statusCode === 400);
	assert.equal(await prisma.portfolioItem.count({ where: { providerProfile: { userId: id } } }), 0);
});
