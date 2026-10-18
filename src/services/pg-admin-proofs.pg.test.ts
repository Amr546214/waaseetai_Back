import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test (J1 / D-B1): the admin accreditation detail query returns the proof list of BOTH shapes from real rows, never a private reference,
 * and the access-link resolves an upload row and a sample attachment from the database. Isolated local PostgreSQL only (see pg-approval.pg.test.ts):
 *   docker exec qa-pg-isolated psql -U qa -d postgres -c "CREATE DATABASE qa_iso_j1"
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_j1 npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_j1 DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_j1 \
 *     node --import tsx --experimental-test-module-mocks --test src/services/pg-admin-proofs.pg.test.ts
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

test('admin detail: proofs from real rows (upload rows + legacy attachments), no private reference, access-link resolves both', opts, async () => {
	const { prisma } = await import('../config/db');
	const proof = await import('./accreditation-proof.service');
	proof.proofStorage.exists = async ref => !ref.includes('gone');
	const { accreditationAiService } = await import('./accreditation-ai.service');
	const { createKycAccessLink } = await import('./kyc-document-access.service');
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'a', lastName: tag, email: `a-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const admin = await prisma.user.create({ data: { id: id(), accountType: 'ADMIN', firstName: 'ad', lastName: tag, email: `ad-${tag}@pg.test`, roles: ['ADMIN'], activeRole: 'ADMIN' } });
	const stranger = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 's', lastName: tag, email: `s-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const profile = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, isProfileSetupComplete: true } });
	const category = (await prisma.category.findUnique({ where: { slug: 'programming-development' } })) ?? (await prisma.category.create({ data: { id: id(), slug: 'programming-development', nameAr: 'x' } }));
	const specialty = await prisma.specialty.create({ data: { id: id(), slug: `sp-${tag}`, categoryId: category.id, nameAr: 'تخصص' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: profile.id, specialtyId: specialty.id, subSpecialties: [], status: 'UNDER_AI_REVIEW', isPassed: false, isActive: true } });
	const refOk = `private:image:png:waseetai/accreditation/${user.id}/proofs/ok-${tag}`;
	const refGone = `private:raw:pdf:waseetai/accreditation/${user.id}/proofs/gone-${tag}`;
	const refLegacy = `private:image:jpg:waseetai/specialties/${ps.id}/proofs/old-${tag}`;
	const sample = await prisma.accreditationSample.create({ data: { id: id(), providerProfileId: profile.id, providerSpecialtyId: ps.id, title: 't', description: 'd', technologiesUsed: [], status: 'MANUAL_REVIEW', attachments: [refOk, refGone, refLegacy, 'https://res.cloudinary.com/testcloud/image/upload/v1/x/old.png', 'data:image/png;base64,AAAA'] } });
	const mk = (fileName: string, privateRef: string, status: any, createdAt: Date) => prisma.accreditationProofUpload.create({ data: { id: id(), userId: user.id, providerSpecialtyId: ps.id, sampleId: sample.id, privateRef, fileName, mimeType: 'image/png', bytes: 100, status, createdAt } });
	const upOk = await mk('ok.png', refOk, 'COMPLETED', new Date('2026-10-17T10:00:00Z'));
	const upGone = await mk('gone.pdf', refGone, 'COMPLETED', new Date('2026-10-17T11:00:00Z'));
	await mk('failed.png', 'pending', 'FAILED', new Date('2026-10-17T12:00:00Z'));
	await mk('cancelled.png', refOk + '-c', 'CANCELLED', new Date('2026-10-17T13:00:00Z'));
	try {
		const d: any = await accreditationAiService.getSampleByIdAdmin(sample.id);
		const text = JSON.stringify(d);
		assert.ok(!text.includes('private:') && !text.includes('privateRef') && !text.includes('base64'));
		assert.deepEqual(d.proofs.map((p: any) => p.key), [`u:${upOk.id}`, `u:${upGone.id}`, 'a:2', 'a:3', 'a:4'], 'COMPLETED uploads in upload order, then the legacy attachments not covered by an upload');
		assert.deepEqual(d.proofs.map((p: any) => p.available), [true, false, true, null, null]);
		assert.deepEqual(d.attachments, ['https://res.cloudinary.com/testcloud/image/upload/v1/x/old.png']);
		assert.equal(d.proofUploads.length, 2);
		// the admin opens both shapes; a stranger is refused; a FAILED upload never opens
		const asAdmin = { id: admin.id, accountType: 'ADMIN' as any };
		const l1 = await createKycAccessLink(asAdmin, { document: 'accreditation_upload', id: upOk.id });
		assert.equal(l1.private, true); assert.ok(l1.expiresInSeconds && l1.expiresInSeconds <= 600);
		const l2 = await createKycAccessLink(asAdmin, { document: 'accreditation_sample_attachment', id: sample.id, index: 2 });
		assert.equal(l2.private, true);
		await assert.rejects(createKycAccessLink({ id: stranger.id, accountType: 'PROVIDER_INDIVIDUAL' as any }, { document: 'accreditation_sample_attachment', id: sample.id, index: 2 }), (e: any) => e.statusCode === 403);
		await assert.rejects(createKycAccessLink(asAdmin, { document: 'accreditation_sample_attachment', id: sample.id, index: 4 }), (e: any) => e.statusCode === 404, 'inline data is never opened');
	} finally {
		await prisma.accreditationProofUpload.deleteMany({ where: { sampleId: sample.id } });
		await prisma.accreditationSample.delete({ where: { id: sample.id } });
		await prisma.accountAuditLog.deleteMany({ where: { userId: user.id } }).catch(() => {});
	}
});
