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
const upload = (prisma: any, owner: any, ps: any, status: string, ref?: string) =>
	prisma.accreditationProofUpload.create({ data: { id: id(), userId: owner.id, providerSpecialtyId: ps.id, privateRef: ref ?? `private:image:png:waseetai/accreditation/${owner.id}/proofs/${id().slice(0, 8)}`, fileName: 'p.png', mimeType: 'image/png', bytes: 10, status } });
const submit = async (userId: string, psId: string, samples: any[]) => (await import('./specialty.service')).specialtyService.uploadWorkSamples(psId, samples, userId);
const statusOf = async (prisma: any, psId: string) => (await prisma.providerSpecialty.findUnique({ where: { id: psId } })).status;
const specRef = (ps: any, n = id().slice(0, 8)) => `private:image:png:waseetai/specialties/${ps.id}/proofs/${n}`;

// storage stub: the set of refs that "exist" in the private storage (the real probe is the Cloudinary Admin API stat check)
const stored = new Set<string>();
const hookStorage = async () => { const m = await import('./accreditation-proof.service'); m.proofStorage.exists = async r => stored.has(r); };

/** Everything a failed submit must leave untouched: specialty row, samples, attachments, upload rows. */
async function snapshot(prisma: any, psId: string) {
	const ps = await prisma.providerSpecialty.findUnique({ where: { id: psId } });
	const samples = await prisma.workSample.findMany({ where: { providerSpecialtyId: psId }, orderBy: { id: 'asc' } });
	const proofs = await prisma.proofAttachment.findMany({ where: { workSample: { providerSpecialtyId: psId } }, orderBy: { id: 'asc' } });
	const uploads = await prisma.accreditationProofUpload.findMany({ where: { providerSpecialtyId: psId }, orderBy: { id: 'asc' } });
	return JSON.parse(JSON.stringify({ ps, samples, proofs, uploads }));
}
/** A specialty that already has a saved sample + legacy attachment (so "nothing was deleted/replaced" is observable). */
async function withExistingSample(prisma: any, ps: any) {
	const ref = specRef(ps, 'old'); stored.add(ref);
	const sample = await prisma.workSample.create({ data: { providerSpecialtyId: ps.id, title: 'القديم', technologies: [], publicSampleUrl: 'https://res.cloudinary.com/x/old.png', mimeType: 'image/png', fileBytes: 1 } });
	await prisma.proofAttachment.create({ data: { workSampleId: sample.id, fileName: 'old.png', fileUrl: ref, mimeType: 'image/png', fileBytes: 1 } });
	return { ref, sample };
}
const rejected = async (prisma: any, a: { user: any; ps: any }, samples: any[], psId = a.ps.id) => {
	const before = await snapshot(prisma, a.ps.id);
	await assert.rejects(submit(a.user.id, psId, samples), (e: any) => e.statusCode === 400 && e.errors?.[0]?.field === 'files');
	assert.deepEqual(await snapshot(prisma, a.ps.id), before, 'a rejected submit must change nothing');
};

test('pg: the isolated database is the throw-away one', opts, async () => { assert.match(String(PG_URL), /55432/); await hookStorage(); });

test('no proof: 400, nothing replaced or changed (existing sample, attachment and status intact)', opts, async () => {
	const w = await seed(); await withExistingSample(w.prisma, w.a.ps);
	await rejected(w.prisma, w.a, [{ title: 'نموذج', publicSampleUrl: 'https://x/y.png', privateProofUrl: null }]);
});

test('UPLOADING / FAILED / CANCELLED uploads and another user\'s COMPLETED upload never count as existing proofs', opts, async () => {
	const w = await seed(); await withExistingSample(w.prisma, w.a.ps);
	for (const st of ['UPLOADING', 'FAILED', 'CANCELLED']) { const u = await upload(w.prisma, w.a.user, w.a.ps, st); stored.add(u.privateRef); }
	const b = await upload(w.prisma, w.b.user, w.b.ps, 'COMPLETED'); stored.add(b.privateRef);
	await rejected(w.prisma, w.a, [{ title: 'ن' }]);
	await rejected(w.prisma, w.a, [{ title: 'ن' }], w.b.ps.id); // B's completed proof does not help A even when A names B's request
	assert.equal(await statusOf(w.prisma, w.b.ps.id), 'PENDING_PROOF');
});

test('a reference whose upload row is FAILED / UPLOADING, or is someone else\'s row, is refused even though the file exists in storage', opts, async () => {
	const w = await seed(); await withExistingSample(w.prisma, w.a.ps);
	for (const st of ['FAILED', 'UPLOADING', 'CANCELLED']) {
		const ref = specRef(w.a.ps); stored.add(ref); await upload(w.prisma, w.a.user, w.a.ps, st, ref);
		await rejected(w.prisma, w.a, [{ title: 'ن', privateProofUrl: ref }]);
	}
	const foreign = specRef(w.a.ps); stored.add(foreign); await upload(w.prisma, w.b.user, w.b.ps, 'COMPLETED', foreign);
	await rejected(w.prisma, w.a, [{ title: 'ن', privateProofUrl: foreign }]);
});

test('a well-formed reference whose file is MISSING in storage is refused', opts, async () => {
	const w = await seed(); await withExistingSample(w.prisma, w.a.ps);
	await rejected(w.prisma, w.a, [{ title: 'ن', privateProofUrl: specRef(w.a.ps, 'ghost') }]);
});

test('someone else\'s file (their specialty folder / their account folder / a request that is not mine) is refused', opts, async () => {
	const w = await seed(); await withExistingSample(w.prisma, w.a.ps);
	const theirs = specRef(w.b.ps); stored.add(theirs);
	const theirAcc = `private:image:png:waseetai/accreditation/${w.b.user.id}/proofs/z`; stored.add(theirAcc);
	await rejected(w.prisma, w.a, [{ title: 'ن', privateProofUrl: theirs }]);
	await rejected(w.prisma, w.a, [{ title: 'ن', privateProofUrl: theirAcc }]);
	// a valid-looking proof of A named against B's request: A does not own B's specialty
	const mine = specRef(w.a.ps); stored.add(mine);
	await assert.rejects(submit(w.a.user.id, w.b.ps.id, [{ title: 'ن', privateProofUrl: mine }]), (e: any) => e.statusCode === 400);
	assert.equal(await statusOf(w.prisma, w.b.ps.id), 'PENDING_PROOF');
	assert.equal(await w.prisma.workSample.count({ where: { providerSpecialtyId: w.b.ps.id } }), 0);
});

test('arbitrary links / data URIs / non-proof folders are refused, also next to a valid proof, with no partial write', opts, async () => {
	const w = await seed(); await withExistingSample(w.prisma, w.a.ps);
	const good = specRef(w.a.ps); stored.add(good);
	for (const bad of ['https://evil.example/p.png', 'data:image/png;base64,AAAA', `private:image:png:waseetai/specialties/${w.a.ps.id}/samples/x`]) {
		await rejected(w.prisma, w.a, [{ title: 'أول', privateProofUrl: good }, { title: 'ثان', proofs: [{ url: bad, name: 'p' }] }]);
	}
});

test('a proof already attached to ANOTHER specialty\'s sample cannot be reused here', opts, async () => {
	const w = await seed(); await withExistingSample(w.prisma, w.a.ps);
	const { ref } = await withExistingSample(w.prisma, w.b.ps);
	// same ref string lives in B's attachments; A cannot present it (also fails the folder check, which is the point: two independent guards)
	await rejected(w.prisma, w.a, [{ title: 'ن', privateProofUrl: ref }]);
});

test('a stored proof of this request (server-stored, exists, mine) is accepted: samples replaced, attachment saved, specialty goes to review', opts, async () => {
	const w = await seed();
	const ref = specRef(w.a.ps); stored.add(ref);
	await submit(w.a.user.id, w.a.ps.id, [{ title: 'نموذج', privateProofUrl: ref }]);
	assert.equal(await statusOf(w.prisma, w.a.ps.id), 'UNDER_AI_REVIEW');
	assert.equal(await w.prisma.proofAttachment.count({ where: { fileUrl: ref, workSample: { providerSpecialtyId: w.a.ps.id } } }), 1);
});

test('LEGACY: an older account whose proof was stored in the specialty folder with NO upload row can resubmit that same stored ref', opts, async () => {
	const w = await seed(); const { ref } = await withExistingSample(w.prisma, w.a.ps);
	assert.equal(await w.prisma.accreditationProofUpload.count({ where: { providerSpecialtyId: w.a.ps.id } }), 0);
	await submit(w.a.user.id, w.a.ps.id, [{ title: 'معدّل', proofs: [{ url: ref, name: 'old.png' }] }]);
	assert.equal(await statusOf(w.prisma, w.a.ps.id), 'UNDER_AI_REVIEW');
	assert.equal(await w.prisma.proofAttachment.count({ where: { fileUrl: ref } }), 1);
});

test('LEGACY ref that is no longer in storage is refused (not accepted for compatibility)', opts, async () => {
	const w = await seed(); const { ref } = await withExistingSample(w.prisma, w.a.ps);
	stored.delete(ref);
	await rejected(w.prisma, w.a, [{ title: 'معدّل', proofs: [{ url: ref, name: 'old.png' }] }]);
});

test('edit: an existing COMPLETED owned upload that still exists in storage is enough when no new file is sent; missing in storage is not', opts, async () => {
	const w = await seed();
	const u = await upload(w.prisma, w.a.user, w.a.ps, 'COMPLETED');
	await rejected(w.prisma, w.a, [{ title: 'نموذج معدّل' }]); // row says COMPLETED but the object is gone
	stored.add(u.privateRef);
	await submit(w.a.user.id, w.a.ps.id, [{ title: 'نموذج معدّل' }]);
	assert.equal(await statusOf(w.prisma, w.a.ps.id), 'UNDER_AI_REVIEW');
});
