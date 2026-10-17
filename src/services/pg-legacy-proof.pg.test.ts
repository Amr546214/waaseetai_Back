import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test (C4): the older multi-sample submit path (specialtyService.uploadWorkSamples, behind POST /provider/specialties/step2-upload and the
 * same gate as POST /provider-specialty/submit-proof) must not move a specialty to review without a valid, completed, owned proof.
 * Isolated local PostgreSQL only (see pg-approval.pg.test.ts for the pattern):
 *   docker exec qa-pg-isolated psql -U qa -d postgres -c "CREATE DATABASE qa_iso_c4"
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_c4 npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_c4 DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_c4 \
 *     node --import tsx --experimental-test-module-mocks --test src/services/pg-legacy-proof.pg.test.ts
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

process.env.JWT_SECRET ??= 'test-secret';
let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const id = () => randomUUID();

async function seed() {
	const prisma = await db();
	const tag = id().slice(0, 8);
	const mk = async (n: string) => {
		const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: n, lastName: tag, email: `${n}-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
		const profile = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, isProfileSetupComplete: true } });
		const category = (await prisma.category.findUnique({ where: { slug: 'programming-development' } })) ?? (await prisma.category.create({ data: { id: id(), slug: 'programming-development', nameAr: 'x' } }));
		const specialty = await prisma.specialty.create({ data: { id: id(), slug: `sp-${n}-${tag}`, categoryId: category.id, nameAr: `تخصص ${n}` } });
		const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: profile.id, specialtyId: specialty.id, subSpecialties: [], status: 'PENDING_PROOF', isPassed: true, isActive: true } });
		return { user, ps };
	};
	return { prisma, a: await mk('a'), b: await mk('b') };
}
const upload = (prisma: any, owner: any, ps: any, status: string) =>
	prisma.accreditationProofUpload.create({ data: { id: id(), userId: owner.id, providerSpecialtyId: ps.id, privateRef: `private:image:png:waseetai/accreditation/${owner.id}/proofs/${id().slice(0, 8)}`, fileName: 'p.png', mimeType: 'image/png', bytes: 10, status } });
const submit = async (userId: string, psId: string, samples: any[]) => (await import('./specialty.service')).specialtyService.uploadWorkSamples(psId, samples, userId);
const statusOf = async (prisma: any, psId: string) => (await prisma.providerSpecialty.findUnique({ where: { id: psId } })).status;

test('pg: the isolated database is the throw-away one', opts, () => { assert.match(String(PG_URL), /55432/); });

test('no proof: 400, nothing replaced, the specialty stays out of review', opts, async () => {
	const w = await seed();
	await assert.rejects(submit(w.a.user.id, w.a.ps.id, [{ title: 'نموذج', publicSampleUrl: 'https://x/y.png', privateProofUrl: null }]), (e: any) => e.statusCode === 400 && e.errors?.[0]?.field === 'files');
	assert.equal(await statusOf(w.prisma, w.a.ps.id), 'PENDING_PROOF');
	assert.equal(await w.prisma.workSample.count({ where: { providerSpecialtyId: w.a.ps.id } }), 0);
});

test('UPLOADING / FAILED / CANCELLED uploads and another user\'s COMPLETED upload never count as existing proofs', opts, async () => {
	const w = await seed();
	for (const st of ['UPLOADING', 'FAILED', 'CANCELLED']) await upload(w.prisma, w.a.user, w.a.ps, st);
	await upload(w.prisma, w.b.user, w.b.ps, 'COMPLETED'); // belongs to B and B's request
	await assert.rejects(submit(w.a.user.id, w.a.ps.id, [{ title: 'ن' }]), (e: any) => e.statusCode === 400);
	// B's completed proof does not help A even when A names B's request
	await assert.rejects(submit(w.a.user.id, w.b.ps.id, [{ title: 'ن' }]), (e: any) => e.statusCode === 400);
	assert.equal(await statusOf(w.prisma, w.a.ps.id), 'PENDING_PROOF');
});

test('a proof reference from another specialty folder or a plain URL is refused', opts, async () => {
	const w = await seed();
	await assert.rejects(submit(w.a.user.id, w.a.ps.id, [{ title: 'ن', privateProofUrl: `private:image:png:waseetai/specialties/${w.b.ps.id}/proofs/x` }]), (e: any) => e.statusCode === 400);
	await assert.rejects(submit(w.a.user.id, w.a.ps.id, [{ title: 'ن', proofs: [{ url: 'https://evil.example/p.png', name: 'p' }] }]), (e: any) => e.statusCode === 400);
	assert.equal(await statusOf(w.prisma, w.a.ps.id), 'PENDING_PROOF');
});

test('a stored proof of this request is accepted: the samples are saved and the specialty goes to review', opts, async () => {
	const w = await seed();
	await submit(w.a.user.id, w.a.ps.id, [{ title: 'نموذج', privateProofUrl: `private:image:png:waseetai/specialties/${w.a.ps.id}/proofs/ok` }]);
	assert.equal(await statusOf(w.prisma, w.a.ps.id), 'UNDER_AI_REVIEW');
	assert.equal(await w.prisma.proofAttachment.count({ where: { workSample: { providerSpecialtyId: w.a.ps.id } } }), 1);
});

test('edit: an existing COMPLETED owned proof of this request is enough when no new file is sent', opts, async () => {
	const w = await seed();
	await upload(w.prisma, w.a.user, w.a.ps, 'COMPLETED');
	await submit(w.a.user.id, w.a.ps.id, [{ title: 'نموذج معدّل' }]);
	assert.equal(await statusOf(w.prisma, w.a.ps.id), 'UNDER_AI_REVIEW');
});
