import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL (isolated local :55432), no dev data. Marketplace service create / visibility:
 *  - refusals name their field with a fixed code and an Arabic text (no English reaches the page); nothing is written
 *  - the same service published again (concurrent / lost-answer retry) inside 5 minutes is ONE service; after the window, or with any difference, a new one
 *  - hide / show asked for the state the service is already in is a success (a repeat after a lost answer is not a false failure)
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud';
process.env.CLOUDINARY_API_KEY ??= '123456789012345';
process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';
const id = () => randomUUID();

async function world() {
	const { prisma } = await import('../config/db');
	const { MarketplaceService } = await import('./marketplace-service.service');
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'p', lastName: tag, email: `sc-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } });
	const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	const pp = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, kycStatus: 'VERIFIED' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: pp.id, specialtyId: spec.id, subSpecialties: [], status: 'APPROVED', isPassed: true, isActive: true } as any });
	const sample = await prisma.accreditationSample.create({ data: { id: id(), providerProfileId: pp.id, providerSpecialtyId: ps.id, title: 'نموذج', description: 'وصف', technologiesUsed: [], attachments: [], status: 'AI_VERIFIED' } as any });
	const svc = new MarketplaceService();
	const body = (over: any = {}) => ({ title: `خدمة اختبار ${tag}`, description: 'وصف طويل بما يكفي للخدمة المنشورة', specialtyId: spec.id, accreditationSampleId: sample.id, stages: [{ title: 'مرحلة', description: 'وصف المرحلة', deliveryDays: 5, percentage: 100, computedAmount: 100 }], ...over });
	return { prisma, user, spec, sample, svc, body, tag };
}
const rejection = async (p: Promise<any>) => p.then(() => null, (e: any) => e);

test('PG: refusals name their field with a fixed code and Arabic text, and write nothing', opts, async () => {
	const w = await world();
	const cases: Array<[any, string, string]> = [
		[{ title: 'x' }, 'title', 'SERVICE_TITLE_INVALID'],
		[{ description: 'قصير' }, 'description', 'SERVICE_DESCRIPTION_INVALID'],
		[{ stages: [] }, 'stages', 'SERVICE_STAGES_REQUIRED'],
		[{ stages: [{ title: 'م', deliveryDays: 5, percentage: 60, computedAmount: 60 }] }, 'stages', 'SERVICE_STAGES_PERCENT'],
		[{ stages: [{ title: '', deliveryDays: 5, percentage: 100, computedAmount: 100 }] }, 'stages', 'SERVICE_STAGE_INVALID'],
		[{ stages: [{ title: 'م', deliveryDays: 5, percentage: 100, computedAmount: 0 }] }, 'stages', 'SERVICE_TOTAL_INVALID'],
	];
	for (const [over, field, code] of cases) {
		const e: any = await rejection(w.svc.createService(w.user.id, w.body(over)));
		assert.equal(e?.statusCode, 400, code); assert.equal(e.code, code); assert.equal(e.errors[0].field, field);
		assert.match(e.message, /[؀-ۿ]/, 'Arabic text');
	}
	assert.equal(await w.prisma.serviceCatalog.count({ where: { providerId: w.user.id } }), 0);
	const upd: any = await rejection(w.svc.updateService(w.user.id, id(), w.body()));
	assert.equal(upd.statusCode, 404); assert.equal(upd.code, 'SERVICE_NOT_FOUND');
});

test('PG: the same service published 4 times at once (and again later) is ONE service; a different price, or the same one after the window, is a new one', opts, async () => {
	const w = await world();
	const res: any[] = await Promise.all([1, 2, 3, 4].map(() => w.svc.createService(w.user.id, w.body())));
	assert.equal(new Set(res.map(r => r.id)).size, 1);
	assert.equal(res.filter(r => r.deduplicated).length, 3);
	const again: any = await w.svc.createService(w.user.id, w.body());
	assert.equal(again.deduplicated, true); assert.equal(again.id, res.find(r => !r.deduplicated).id);
	assert.equal(await w.prisma.serviceCatalog.count({ where: { providerId: w.user.id } }), 1);
	const other: any = await w.svc.createService(w.user.id, w.body({ stages: [{ title: 'مرحلة', description: 'وصف المرحلة', deliveryDays: 5, percentage: 100, computedAmount: 150 }] }));
	assert.notEqual(other.deduplicated, true);
	await w.prisma.serviceCatalog.updateMany({ where: { providerId: w.user.id }, data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) } });
	const late: any = await w.svc.createService(w.user.id, w.body());
	assert.notEqual(late.deduplicated, true);
	assert.equal(await w.prisma.serviceCatalog.count({ where: { providerId: w.user.id } }), 3);
});

test('PG: hide / show is idempotent (a repeat after a lost answer succeeds); a not-hidden or unpublished service is refused 409 with a code', opts, async () => {
	const w = await world();
	const s: any = await w.svc.createService(w.user.id, w.body());
	assert.equal((await w.svc.setServiceVisibility(w.user.id, s.id, true)).status, 'PUBLISHED'); // already shown -> success
	assert.equal((await w.svc.setServiceVisibility(w.user.id, s.id, false)).status, 'ARCHIVED');
	assert.equal((await w.svc.setServiceVisibility(w.user.id, s.id, false)).status, 'ARCHIVED'); // repeat of the hide
	assert.equal((await w.svc.setServiceVisibility(w.user.id, s.id, true)).status, 'PUBLISHED');
	await w.prisma.serviceCatalog.update({ where: { id: s.id }, data: { status: 'REJECTED' as any } });
	const hide: any = await rejection(w.svc.setServiceVisibility(w.user.id, s.id, false));
	assert.equal(hide.statusCode, 409); assert.equal(hide.code, 'SERVICE_NOT_PUBLISHED');
	const show: any = await rejection(w.svc.setServiceVisibility(w.user.id, s.id, true));
	assert.equal(show.statusCode, 409); assert.equal(show.code, 'SERVICE_NOT_HIDDEN');
});
