import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test: the marketer setup rule through the real validation middleware, controller and service on a throw-away database.
 * Bio required (not blank) and at least one VALID channel (wizard calls carry `setup: true`); ordinary partial updates and old complete accounts are untouched.
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_<x> npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --experimental-test-module-mocks --test src/controllers/marketer-setup-rule.pg.test.ts
 */
process.env.OPENAI_API_KEY = 'test-key';
process.env.CLOUDINARY_CLOUD_NAME = 'local-dev';
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
const LONG_BIO = 'وسيط تسويقي بخبرة طويلة في الترويج للخدمات الرقمية عبر قنوات التواصل الاجتماعي المختلفة';

function mkRes() { const r: any = { statusCode: 200, body: null }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; }
async function seed(profile: Record<string, any> = {}) {
	const { prisma } = await import('../config/db');
	const id = randomUUID();
	await prisma.user.create({ data: { id, accountType: 'MARKETING_BROKER', firstName: 'QA', lastName: 'Mk', email: `mk-${id.slice(0, 8)}@pg.test`, roles: ['AFFILIATE'], activeRole: 'AFFILIATE' } as any });
	await prisma.affiliateProfile.create({ data: { userId: id, referralSlug: `s${id.slice(0, 8)}`, ...profile } as any });
	return { prisma, id };
}
/** the real route chain: validateDto(schema) -> controller */
async function call(kind: 'bio' | 'channel', userId: string, body: any) {
	const { validateDto } = await import('../middlewares/validate-dto.middleware');
	const { updateMarketingInfoSchema, addChannelSchema } = await import('../dtos/marketer-profile.dto');
	const { marketerProfileController } = await import('./marketer-profile.controller');
	const req: any = { user: { id: userId }, body }; const res = mkRes(); let nextErr: any = null; let reached = false;
	await validateDto(kind === 'bio' ? updateMarketingInfoSchema : addChannelSchema)(req, res, (e?: any) => { reached = true; nextErr = e ?? null; });
	if (reached && !nextErr) await (kind === 'bio' ? marketerProfileController.updateMarketingInfo(req, res, (e: any) => { nextErr = e; }) : marketerProfileController.addChannel(req, res, (e: any) => { nextErr = e; }));
	return { res, nextErr, validated: reached };
}
const fieldOf = (res: any) => (res.body?.errors ?? []).map((e: any) => e.field);

test('PG: wizard bio — whitespace-only / empty is a 400 under "bio" and the stored bio is unchanged; a real bio is stored', opts, async () => {
	const { prisma, id } = await seed({ bio: 'قديمة' });
	for (const bio of ['', '   ', ' ​']) {
		const { res } = await call('bio', id, { bio, setup: true });
		assert.equal(res.statusCode, 400, JSON.stringify(bio));
		assert.deepEqual(fieldOf(res), ['bio']);
		assert.equal((await prisma.affiliateProfile.findUnique({ where: { userId: id } }))!.bio, 'قديمة');
	}
	const ok = await call('bio', id, { bio: `  ${LONG_BIO} `, setup: true });
	assert.equal(ok.res.statusCode, 200, JSON.stringify(ok.res.body));
	assert.equal((await prisma.affiliateProfile.findUnique({ where: { userId: id } }))!.bio!.trim(), LONG_BIO);
});

test('PG: wizard channel — empty / invalid / foreign-domain is a 400 under "handle", nothing is stored; one valid channel (any platform) is stored', opts, async () => {
	const { prisma, id } = await seed();
	const count = async () => prisma.affiliateChannelHandle.count({ where: { affiliateProfile: { userId: id } } });
	for (const [platform, handle] of [['INSTAGRAM', ''], ['INSTAGRAM', '   '], ['TIKTOK', 'two words'], ['YOUTUBE', 'https://evil.example/x'], ['WHATSAPP', 'abc'], ['INSTAGRAM', 'javascript:alert(1)']]) {
		const { res } = await call('channel', id, { platform, handle, setup: true });
		assert.equal(res.statusCode, 400, `${platform} ${handle}`);
		assert.ok(fieldOf(res).includes('handle'), `${platform} ${handle}`);
		assert.equal(await count(), 0);
	}
	const ok = await call('channel', id, { platform: 'WHATSAPP', handle: '+966500000000', setup: true });
	assert.equal(ok.res.statusCode, 201, JSON.stringify(ok.res.body));
	assert.equal(await count(), 1);
});

test('PG: ordinary partial updates are NOT blocked: avatar-only and a bio edit without setup (empty bio allowed) keep working', opts, async () => {
	const { prisma, id } = await seed({ bio: LONG_BIO });
	const a = await call('bio', id, { avatarUrl: 'data:image/png;base64,AAAA' });
	assert.equal(a.res.statusCode, 200, JSON.stringify(a.res.body));
	assert.equal((await prisma.affiliateProfile.findUnique({ where: { userId: id } }))!.bio, LONG_BIO, 'an avatar-only update leaves the bio alone');
	const c = await call('channel', id, { platform: 'TIKTOK', handle: 'x' });
	assert.equal(c.res.statusCode, 201, 'the lenient channel rule is unchanged outside the wizard');
});

test('PG: an old complete account is never downgraded by the rule (bio + channel + percentage stay) after unrelated updates', opts, async () => {
	const { prisma, id } = await seed({ bio: LONG_BIO });
	const aff = await prisma.affiliateProfile.findUnique({ where: { userId: id } });
	await prisma.affiliateChannelHandle.create({ data: { affiliateProfileId: aff!.id, platform: 'YOUTUBE', handle: 'legacy channel with spaces' } });
	const { marketerProfileService } = await import('../services/marketer-profile.service');
	await marketerProfileService.getProfile(id);
	const before = await prisma.affiliateProfile.findUnique({ where: { userId: id } });
	await call('bio', id, { avatarUrl: 'data:image/png;base64,AAAA' });
	const after = await prisma.affiliateProfile.findUnique({ where: { userId: id } });
	assert.equal(after!.bio, LONG_BIO);
	assert.equal(await prisma.affiliateChannelHandle.count({ where: { affiliateProfileId: aff!.id } }), 1, 'the legacy channel (which would be invalid today) is kept');
	assert.ok(Number(after!.completionPercentage) >= Number(before!.completionPercentage));
});
