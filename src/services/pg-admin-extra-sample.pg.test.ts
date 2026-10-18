import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test (J1 / DEF1): deciding an EXTRA sample of an already-approved specialty.
 * What the code does (accreditation-ai.service.ts):
 *  - approve of an extra sample: the sample becomes AI_VERIFIED + decidedAt + an APPROVED event with the actor + one ACCREDITATION_APPROVED notification; the
 *    specialty is NOT touched (stays APPROVED, badgeGrantedAt / aiScore unchanged).
 *  - reject of an extra sample: the sample becomes REJECTED (+ reason, event, notification); the specialty update is scoped to status != APPROVED, so an approved
 *    specialty and an earlier approved sample are NOT revoked. (A specialty that is NOT approved is moved to REJECTED by a sample reject: existing rule, unchanged.)
 *  - a decided sample (approved / rejected) refuses any second decision with 409; two simultaneous decisions: exactly one wins.
 * Isolated local PostgreSQL only (see pg-approval.pg.test.ts):
 *   docker exec qa-pg-isolated psql -U qa -d postgres -c "CREATE DATABASE qa_iso_j1b"
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_j1b npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=... DATABASE_URL=... node --import tsx --experimental-test-module-mocks --test src/services/pg-admin-extra-sample.pg.test.ts
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
const id = () => randomUUID();
const BADGE = new Date('2026-01-05T10:00:00Z');

async function seed(specialtyStatus = 'APPROVED') {
	const { prisma } = await import('../config/db');
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'P', lastName: tag, email: `x-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const admin = await prisma.user.create({ data: { id: id(), accountType: 'ADMIN', firstName: 'A', lastName: tag, email: `ad-${tag}@pg.test`, roles: ['ADMIN'], activeRole: 'ADMIN' } });
	const profile = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, isProfileSetupComplete: true } });
	const category = (await prisma.category.findUnique({ where: { slug: 'programming-development' } })) ?? (await prisma.category.create({ data: { id: id(), slug: 'programming-development', nameAr: 'x' } }));
	const specialty = await prisma.specialty.create({ data: { id: id(), slug: `sp-${tag}`, categoryId: category.id, nameAr: 'تخصص' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: profile.id, specialtyId: specialty.id, subSpecialties: [], status: specialtyStatus as any, isPassed: true, isActive: true, badgeGrantedAt: specialtyStatus === 'APPROVED' ? BADGE : null, aiScore: 77 } });
	const mk = (status: string, decidedAt: Date | null = null) => prisma.accreditationSample.create({ data: { id: id(), providerProfileId: profile.id, providerSpecialtyId: ps.id, title: `n-${tag}`, description: 'd', technologiesUsed: [], attachments: [], status: status as any, decidedAt } });
	const actor: any = { id: admin.id };
	const counts = async (sampleId: string) => ({
		events: await prisma.accreditationSampleEvent.count({ where: { sampleId } }),
		notes: await prisma.notification.count({ where: { userId: user.id, type: { in: ['ACCREDITATION_APPROVED', 'ACCREDITATION_REJECTED'] }, metadata: { path: ['sampleId'], equals: sampleId } } }),
	});
	const spec = () => prisma.providerSpecialty.findUnique({ where: { id: ps.id } });
	return { prisma, user, ps, mk, actor, counts, spec };
}
const svc = async () => (await import('./accreditation-ai.service')).accreditationAiService;
const code = (e: any) => e?.statusCode;

test('approve an EXTRA sample of an approved specialty: sample decided + event + notification, specialty untouched', opts, async () => {
	const w = await seed(); const s = await svc();
	const earlier = await w.mk('AI_VERIFIED', new Date('2026-01-05T10:00:00Z')); const extra = await w.mk('MANUAL_REVIEW');
	await s.adminApproveSample(extra.id, w.actor);
	const row = await w.prisma.accreditationSample.findUnique({ where: { id: extra.id } });
	assert.equal(row!.status, 'AI_VERIFIED'); assert.ok(row!.decidedAt);
	const ev = await w.prisma.accreditationSampleEvent.findMany({ where: { sampleId: extra.id } });
	assert.deepEqual(ev.map(e => [e.kind, e.actorId]), [['APPROVED', w.actor.id]]);
	assert.deepEqual(await w.counts(extra.id), { events: 1, notes: 1 });
	const sp = await w.spec();
	assert.equal(sp!.status, 'APPROVED'); assert.equal(sp!.badgeGrantedAt!.getTime(), BADGE.getTime(), 'badge date not rewritten'); assert.equal(sp!.aiScore, 77);
	assert.equal((await w.prisma.accreditationSample.findUnique({ where: { id: earlier.id } }))!.status, 'AI_VERIFIED');
});

test('reject an EXTRA sample: the approved specialty and the earlier approved sample are NOT revoked', opts, async () => {
	const w = await seed(); const s = await svc();
	const earlier = await w.mk('AI_VERIFIED', new Date('2026-01-05T10:00:00Z')); const extra = await w.mk('MANUAL_REVIEW');
	await s.adminRejectSample(extra.id, 'الملفات غير واضحة', w.actor);
	const row = await w.prisma.accreditationSample.findUnique({ where: { id: extra.id } });
	assert.equal(row!.status, 'REJECTED'); assert.equal(row!.userNote, 'الملفات غير واضحة');
	assert.equal((await w.spec())!.status, 'APPROVED');
	const e = await w.prisma.accreditationSample.findUnique({ where: { id: earlier.id } });
	assert.equal(e!.status, 'AI_VERIFIED'); assert.ok(e!.decidedAt);
	assert.deepEqual(await w.counts(extra.id), { events: 1, notes: 1 });
});

test('documented existing rule: rejecting a sample of a specialty that is NOT approved moves that specialty to REJECTED', opts, async () => {
	const w = await seed('UNDER_AI_REVIEW'); const s = await svc();
	const smp = await w.mk('MANUAL_REVIEW');
	await s.adminRejectSample(smp.id, 'سبب', w.actor);
	assert.equal((await w.spec())!.status, 'REJECTED');
});

test('a second decision on a decided sample is a 409 and writes nothing (approved, rejected, and approve-after-reject)', opts, async () => {
	const w = await seed(); const s = await svc();
	const a = await w.mk('MANUAL_REVIEW'); const r = await w.mk('MANUAL_REVIEW');
	await s.adminApproveSample(a.id, w.actor); await s.adminRejectSample(r.id, 'سبب', w.actor);
	for (const fn of [() => s.adminApproveSample(a.id, w.actor), () => s.adminRejectSample(a.id, 'سبب ثانٍ', w.actor), () => s.adminApproveSample(r.id, w.actor), () => s.adminRejectSample(r.id, 'سبب ثانٍ', w.actor)]) {
		await assert.rejects(fn, (e: any) => code(e) === 409);
	}
	assert.deepEqual(await w.counts(a.id), { events: 1, notes: 1 });
	assert.deepEqual(await w.counts(r.id), { events: 1, notes: 1 });
	assert.equal((await w.prisma.accreditationSample.findUnique({ where: { id: r.id } }))!.status, 'REJECTED');
});

test('other pending states are decidable: PENDING_AI_AUDIT, NEEDS_COMPLETION, AI_VERIFIED without a decision on a non-approved specialty', opts, async () => {
	const w = await seed('UNDER_AI_REVIEW'); const s = await svc();
	// AI_VERIFIED first: once the specialty is approved it counts as decided
	for (const st of ['AI_VERIFIED', 'PENDING_AI_AUDIT', 'NEEDS_COMPLETION'] ) {
		const smp = await w.mk(st);
		await s.adminApproveSample(smp.id, w.actor);
		assert.equal((await w.prisma.accreditationSample.findUnique({ where: { id: smp.id } }))!.status, 'AI_VERIFIED');
	}
	assert.equal((await w.spec())!.status, 'APPROVED');
});

test('concurrency: two simultaneous approves -> one wins, one 409, one event, one notification; approve vs reject -> one wins', opts, async () => {
	const w = await seed(); const s = await svc();
	const a = await w.mk('MANUAL_REVIEW');
	const res = await Promise.allSettled([s.adminApproveSample(a.id, w.actor), s.adminApproveSample(a.id, w.actor)]);
	assert.equal(res.filter(x => x.status === 'fulfilled').length, 1);
	assert.equal(res.filter(x => x.status === 'rejected' && code((x as any).reason) === 409).length, 1);
	assert.deepEqual(await w.counts(a.id), { events: 1, notes: 1 });
	const b = await w.mk('MANUAL_REVIEW');
	const mixed = await Promise.allSettled([s.adminApproveSample(b.id, w.actor), s.adminRejectSample(b.id, 'سبب', w.actor)]);
	assert.equal(mixed.filter(x => x.status === 'fulfilled').length, 1);
	assert.equal((await w.counts(b.id)).events, 1);
	assert.equal((await w.spec())!.status, 'APPROVED');
});
