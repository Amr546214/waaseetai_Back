import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test (G4): the provider setup save with the real stored value shapes found on DEV (Google sign-in photo, legacy bare file name,
 * private ref, own Cloudinary URL). Isolated throw-away database only.
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_<x> npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --experimental-test-module-mocks --test src/controllers/provider-setup-filelink.pg.test.ts
 */
process.env.OPENAI_API_KEY = 'test-key';
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocLabcDEF=s96-c';
function mkRes() { const r: any = { statusCode: null, body: null }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; }
const body = (extra: any = {}) => ({ details: { country: 'SA', city: 'Riyadh', occupation: 'مصمم', bio: 'x'.repeat(60) }, identity: {}, bank: {}, documents: {}, agreements: {}, specialties: { mainSpec: 'تصميم' }, ...extra });

async function seed(stored: Record<string, any>) {
	const { prisma } = await import('../config/db');
	const id = randomUUID();
	await prisma.user.create({ data: { id, accountType: 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: 'G4', email: `g4-${id.slice(0, 8)}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } as any });
	await prisma.providerProfile.create({ data: { userId: id, ...stored } as any });
	return { prisma, id };
}
async function save(id: string, b: any) {
	const { saveSetupData } = await import('./provider-profile.controller');
	const res = mkRes();
	await saveSetupData({ user: { id }, body: b } as any, res);
	return res;
}

test('PG G4: Google photo stored, saved again unchanged -> 200 and kept', opts, async () => {
	const { prisma, id } = await seed({ avatarUrl: GOOGLE });
	const res = await save(id, body({ avatarUrl: GOOGLE }));
	assert.equal(res.statusCode, 200, JSON.stringify(res.body));
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: id } }))!.avatarUrl, GOOGLE);
});

test('PG G4: Google photo stored, a foreign link -> 400, same message, nothing changed', opts, async () => {
	const { prisma, id } = await seed({ avatarUrl: GOOGLE });
	const res = await save(id, body({ avatarUrl: 'https://evil.example.com/a.jpg' }));
	assert.equal(res.statusCode, 400);
	assert.match(JSON.stringify(res.body), /رابط الملف غير مسموح به/);
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: id } }))!.avatarUrl, GOOGLE);
});

test('PG G4: replacement by a direct upload (own storage URL) and retry with the same value both work', opts, async () => {
	const { prisma, id } = await seed({ avatarUrl: GOOGLE });
	const url = `https://res.cloudinary.com/demo/image/upload/v1/waseetai/users/${id}/avatar/avatar.jpg`;
	assert.equal((await save(id, body({ avatarUrl: url }))).statusCode, 200);
	assert.equal((await save(id, body({ avatarUrl: url }))).statusCode, 200);
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: id } }))!.avatarUrl, url);
	// after the replacement the old Google value is no longer "stored": it is refused like any foreign link
	assert.equal((await save(id, body({ avatarUrl: GOOGLE }))).statusCode, 400);
});

test('PG G4: another user\'s Google photo value is refused for this user (stored value of THIS user only)', opts, async () => {
	await seed({ avatarUrl: GOOGLE });
	const other = await seed({});
	assert.equal((await save(other.id, body({ avatarUrl: GOOGLE }))).statusCode, 400);
});

test('PG G4: stored legacy file name / private ref echoed unchanged are kept; a foreign private ref is refused', opts, async () => {
	const { prisma, id } = await seed({ frontIdUrl: 'IMG20260101_1234.jpg', backIdUrl: `private:image:jpg:waseetai/providers/${id0()}/identity/back-id` });
	const res = await save(id, body({ identity: { frontId: 'IMG20260101_1234.jpg' } }));
	assert.equal(res.statusCode, 200, JSON.stringify(res.body));
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: id } }))!.frontIdUrl, 'IMG20260101_1234.jpg');
	const bad = await save(id, body({ identity: { backId: 'private:image:jpg:waseetai/providers/someone-else/identity/back-id' } }));
	assert.equal(bad.statusCode, 400);
	assert.equal((await save(id, body({ identity: { frontId: 'https://evil.example.com/id.jpg' } }))).statusCode, 400);
});
function id0() { return 'x'; }
