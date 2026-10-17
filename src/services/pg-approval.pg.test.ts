import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL tests for Batch B T1: proof documents, the approval-request review loop (completion required / resubmission / history / internal notes),
 * the entry gate, and market publishing validation (approved specialty only, catalog skills only, model of the same provider + specialty).
 *
 * Runs ONLY against an isolated throw-away database: QA_ISOLATED_PG_URL must equal DATABASE_URL and point at 127.0.0.1/localhost:55432.
 *   docker exec qa-pg-isolated psql -U qa -d postgres -c "CREATE DATABASE qa_iso_t1"
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_t1 npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_t1 DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_t1 \
 *     node --import tsx --experimental-test-module-mocks --test src/services/pg-approval.pg.test.ts
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

process.env.JWT_SECRET ??= 'test-secret';
let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const id = () => randomUUID();
const stage = { title: 'مرحلة', description: 'وصف', percentage: 100, deliveryDays: 5, computedAmount: 100 };

async function seed(specs: Array<{ status: string; isPassed?: boolean; slug?: string }> = [{ status: 'APPROVED' }]) {
	const prisma = await db();
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'P', lastName: tag, email: `ap-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const profile = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, isProfileSetupComplete: true, setupTestStatus: 'COMPLETED' } });
	const out: any[] = [];
	for (const [i, s] of specs.entries()) {
		// the skills catalog is keyed by the REAL category slug: categories are shared rows, get-or-create
		const slug = s.slug ?? 'programming-development';
		const category = (await prisma.category.findUnique({ where: { slug } })) ?? (await prisma.category.create({ data: { id: id(), slug, nameAr: slug } }));
		const specialty = await prisma.specialty.create({ data: { id: id(), slug: `sp-${tag}-${i}`, categoryId: category.id, nameAr: `تخصص ${i}` } });
		const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: profile.id, specialtyId: specialty.id, subSpecialties: [], status: s.status, isPassed: s.isPassed ?? s.status === 'APPROVED', isActive: true } });
		out.push({ specialty, ps });
	}
	return { prisma, tag, user, profile, specs: out };
}

const proofFor = async (w: any, ps: any, status = 'COMPLETED', userId = w.user.id) =>
	w.prisma.accreditationProofUpload.create({ data: { id: id(), userId, providerSpecialtyId: ps.id, privateRef: `private:image:png:waseetai/accreditation/${userId}/proofs/${id().slice(0, 8)}`, fileName: 'p.png', mimeType: 'image/png', bytes: 100, status } });
const dto = (w: any, ps: any, extra: any = {}) => ({ userId: w.user.id, providerSpecialtyId: ps.id, title: 'نموذج عمل', description: 'وصف تقني كامل للنموذج', technologiesUsed: ['React'], attachments: [], ...extra });
const ai = async () => (await import('./accreditation-ai.service')).accreditationAiService;
const code = (e: any) => e?.statusCode;

test('pg: the isolated database is the throw-away one', opts, async () => {
	const prisma = await db();
	const [{ current_database }] = await prisma.$queryRaw`SELECT current_database()` as any[];
	assert.match(current_database, /^qa_iso/); // any throw-away qa_iso* database; the file only runs when the URL is a local :55432 server (see `enabled`)
});

test('proof: a submission without a valid document is a 400 naming the files field; links and body URLs are not documents', opts, async () => {
	const w = await seed([{ status: 'PENDING_PROOF', isPassed: true }]); const { ps } = w.specs[0]; const svc = await ai();
	await assert.rejects(() => svc.submitAccreditationSample(dto(w, ps, { projectUrl: 'https://example.com', attachments: ['https://evil.example/x.png'] })), (e: any) => code(e) === 400 && e.errors[0].field === 'files');
	assert.equal(await w.prisma.accreditationSample.count({ where: { providerSpecialtyId: ps.id } }), 0);
});

test('proof: UPLOADING / FAILED / CANCELLED uploads, another user\'s upload and another request\'s upload never count', opts, async () => {
	const w = await seed([{ status: 'PENDING_PROOF', isPassed: true }, { status: 'PENDING_PROOF', isPassed: true, slug: 'design-creative' }]);
	const other = await seed([{ status: 'PENDING_PROOF', isPassed: true }]); const svc = await ai();
	const [a, b] = w.specs;
	const bad = [await proofFor(w, a.ps, 'UPLOADING'), await proofFor(w, a.ps, 'FAILED'), await proofFor(w, a.ps, 'CANCELLED'), await proofFor(other, other.specs[0].ps), await proofFor(w, b.ps)];
	for (const row of bad) await assert.rejects(() => svc.submitAccreditationSample(dto(w, a.ps, { proofIds: [row.id] })), (e: any) => code(e) === 400 && e.errors[0].field === 'files', row.status);
	// the legacy body string path: only the private reference of the caller's own COMPLETED upload for THIS request
	await assert.rejects(() => svc.submitAccreditationSample(dto(w, a.ps, { attachments: [bad[3].privateRef] })), (e: any) => code(e) === 400);
	const good = await proofFor(w, a.ps);
	const r = await svc.submitAccreditationSample(dto(w, a.ps, { attachments: [good.privateRef] }));
	assert.equal(r.sample.status, 'MANUAL_REVIEW');
});

test('proof: deleting the document before submit restores the missing state; a submitted one is bound to the request', opts, async () => {
	const w = await seed([{ status: 'PENDING_PROOF', isPassed: true }]); const { ps } = w.specs[0]; const svc = await ai();
	const { removeUpload, listUploads } = await import('./accreditation-proof.service');
	const up = await proofFor(w, ps);
	assert.equal((await listUploads(w.prisma, w.user.id, ps.id)).length, 1);
	await removeUpload(w.prisma, w.user.id, up.id);
	assert.equal((await listUploads(w.prisma, w.user.id, ps.id)).length, 0);
	await assert.rejects(() => svc.submitAccreditationSample(dto(w, ps, { proofIds: [up.id] })), (e: any) => code(e) === 400 && e.errors[0].field === 'files');
	await assert.rejects(() => removeUpload(w.prisma, 'someone-else', up.id), (e: any) => code(e) === 404);
	const up2 = await proofFor(w, ps);
	const r = await svc.submitAccreditationSample(dto(w, ps, { proofIds: [up2.id] }));
	assert.equal((await w.prisma.accreditationProofUpload.findUnique({ where: { id: up2.id } })).sampleId, r.sample.id);
	assert.equal((await w.prisma.providerSpecialty.findUnique({ where: { id: ps.id } })).status, 'UNDER_AI_REVIEW');
	// a document of a request under review cannot be removed
	await assert.rejects(() => removeUpload(w.prisma, w.user.id, up2.id), (e: any) => code(e) === 409);
});

test('concurrency: two simultaneous submissions create ONE request (the other is a 409)', opts, async () => {
	const w = await seed([{ status: 'PENDING_PROOF', isPassed: true }]); const { ps } = w.specs[0]; const svc = await ai();
	const [u1, u2] = [await proofFor(w, ps), await proofFor(w, ps)];
	const res = await Promise.allSettled([svc.submitAccreditationSample(dto(w, ps, { proofIds: [u1.id] })), svc.submitAccreditationSample(dto(w, ps, { proofIds: [u2.id] }))]);
	assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal(res.filter(r => r.status === 'rejected' && code((r as any).reason) === 409).length, 1);
	assert.equal(await w.prisma.accreditationSample.count({ where: { providerSpecialtyId: ps.id } }), 1);
});

test('review loop: completion required -> provider sees the user note only -> resubmission re-uses the SAME request with history', opts, async () => {
	const w = await seed([{ status: 'PENDING_PROOF', isPassed: true }]); const { ps } = w.specs[0]; const svc = await ai();
	const { approvalRequestService } = await import('./approval-request.service');
	const { providerAccessStateService } = await import('./provider-access-state.service');
	const up = await proofFor(w, ps);
	const first = await svc.submitAccreditationSample(dto(w, ps, { proofIds: [up.id] }));
	const sid = first.sample.id;
	assert.equal((await providerAccessStateService.get(w.user.id)).state, 'PENDING_REVIEW');
	await svc.adminRequestCompletion(sid, { userNote: 'أضف وصفًا أوضح للنموذج', internalNote: 'المزوّد يبدو مشبوهًا - سري', fields: ['description'] }, { id: 'admin-1' } as any);

	const item = await approvalRequestService.get(w.user.id, sid);
	assert.equal(item.status, 'COMPLETION_REQUIRED');
	assert.equal(item.adminNote, 'أضف وصفًا أوضح للنموذج');
	assert.deepEqual(item.completionFields, ['description']);
	assert.ok(item.requestNo.startsWith('REQ-') && item.specialty.nameAr && item.model.title && item.allowedAttachments.maxFiles);
	assert.ok(!JSON.stringify(item).includes('سري'), 'the internal note never reaches the provider');
	assert.ok(!JSON.stringify(await svc.getProviderAccreditationSamples(w.user.id)).includes('سري'));
	assert.ok(!JSON.stringify(await svc.getAccreditationSampleById(w.user.id, sid)).includes('سري'));
	assert.ok(JSON.stringify(await svc.getSampleByIdAdmin(sid)).includes('سري'), 'the admin sees it');

	const gate = await providerAccessStateService.get(w.user.id);
	assert.deepEqual([gate.state, gate.gate, gate.canAccessDashboard, gate.completionSampleId], ['COMPLETION_REQUIRED', 'REVIEW', false, sid]);
	assert.equal((await approvalRequestService.getForCompletion(w.user.id, sid)).attachments.length, 1, 'previous data + documents come back');

	// the provider adds the missing data without re-uploading: the same request, revision 2, nothing duplicated
	const again = await svc.submitAccreditationSample(dto(w, ps, { description: 'وصف تقني أطول وأوضح بكثير', resubmitSampleId: sid }));
	assert.equal(again.sample.id, sid); assert.equal(again.sample.revision, 2); assert.equal(again.resubmitted, true);
	assert.equal(await w.prisma.accreditationSample.count({ where: { providerSpecialtyId: ps.id } }), 1);
	const after = await approvalRequestService.get(w.user.id, sid);
	assert.equal(after.status, 'UNDER_REVIEW');
	assert.deepEqual(after.history.map(h => h.kind), ['SUBMITTED', 'COMPLETION_REQUESTED', 'RESUBMITTED']);
	assert.equal((await providerAccessStateService.get(w.user.id)).state, 'PENDING_REVIEW');

	// a request that is not waiting cannot be "re-submitted" and a second concurrent submit is a 409
	const spare = await proofFor(w, ps);
	await assert.rejects(() => svc.submitAccreditationSample(dto(w, ps, { proofIds: [spare.id] })), (e: any) => code(e) === 409);
	// reject with a reason: shown to the provider, internal note kept private; then the SAME request is re-opened
	await svc.adminRejectSample(sid, 'النموذج لا يطابق التخصص', { id: 'admin-1' } as any, 'ملاحظة داخلية سرية');
	const rej = await approvalRequestService.get(w.user.id, sid);
	assert.equal(rej.status, 'REJECTED'); assert.equal(rej.rejectionReason, 'النموذج لا يطابق التخصص');
	assert.ok(!JSON.stringify(rej).includes('داخلية'));
	const third = await svc.submitAccreditationSample(dto(w, ps, { resubmitSampleId: sid }));
	assert.equal(third.sample.id, sid); assert.equal(third.sample.revision, 3);
	assert.equal(await w.prisma.accreditationSample.count({ where: { providerSpecialtyId: ps.id } }), 1);
});

test('ownership: another provider cannot read a request (same 404 as a missing id); a non-waiting request cannot be completed', opts, async () => {
	const w = await seed([{ status: 'PENDING_PROOF', isPassed: true }]); const stranger = await seed([{ status: 'PENDING_PROOF', isPassed: true }]); const svc = await ai();
	const { approvalRequestService } = await import('./approval-request.service');
	const own = await proofFor(w, w.specs[0].ps);
	const r = await svc.submitAccreditationSample(dto(w, w.specs[0].ps, { proofIds: [own.id] }));
	await assert.rejects(() => approvalRequestService.get(stranger.user.id, r.sample.id), (e: any) => code(e) === 404);
	await assert.rejects(() => approvalRequestService.get(w.user.id, id()), (e: any) => code(e) === 404);
	await assert.rejects(() => approvalRequestService.getForCompletion(w.user.id, r.sample.id), (e: any) => code(e) === 409);
	await svc.adminApproveSample(r.sample.id);
	await assert.rejects(() => svc.adminRequestCompletion(r.sample.id, { userNote: 'متأخر' }), (e: any) => code(e) === 409);
	assert.equal((await approvalRequestService.get(w.user.id, r.sample.id)).status, 'APPROVED');
});

test('entry gate: setup / test / sample missing = SETUP; approved account with an extra specialty under review stays OPEN', opts, async () => {
	const { providerAccessStateService } = await import('./provider-access-state.service');
	const incomplete = await seed([{ status: 'PENDING_PROOF' }]);
	await incomplete.prisma.providerProfile.update({ where: { id: incomplete.profile.id }, data: { isProfileSetupComplete: false } });
	const g1 = await providerAccessStateService.get(incomplete.user.id);
	assert.deepEqual([g1.state, g1.gate, g1.canAccessDashboard], ['SETUP_INCOMPLETE', 'SETUP', false]);
	const mixed = await seed([{ status: 'APPROVED' }, { status: 'UNDER_AI_REVIEW', isPassed: true, slug: 'design-creative' }]);
	const g2 = await providerAccessStateService.get(mixed.user.id);
	assert.deepEqual([g2.state, g2.gate, g2.canAccessDashboard], ['APPROVED', 'OPEN', true]);
});

test('market: publish only in an APPROVED specialty; a pending extra specialty never blocks the approved one and is not opened early', opts, async () => {
	const w = await seed([{ status: 'APPROVED' }, { status: 'UNDER_AI_REVIEW', isPassed: true, slug: 'design-creative' }]);
	const [ok, pending] = w.specs; const { MarketplaceService } = await import('./marketplace-service.service'); const s = new MarketplaceService();
	const mk = async (x: any, status: string) => w.prisma.accreditationSample.create({ data: { id: id(), providerProfileId: w.profile.id, providerSpecialtyId: x.ps.id, title: 'م', description: 'وصف', technologiesUsed: [], attachments: [], status } });
	const okModel = await mk(ok, 'AI_VERIFIED'); const pendModel = await mk(pending, 'MANUAL_REVIEW');
	const body = (over: any = {}) => ({ title: 'خدمة تطوير', description: 'وصف طويل للخدمة هنا', specialtyId: ok.specialty.id, accreditationSampleId: okModel.id, stages: [stage], ...over });

	const created = await s.createService(w.user.id, body({ skills: ['React'] }));
	assert.equal(created.specialtyId, ok.specialty.id);
	await assert.rejects(() => s.createService(w.user.id, body({ specialtyId: pending.specialty.id, accreditationSampleId: pendModel.id })), (e: any) => code(e) === 403 && e.errors[0].code === 'SPECIALTY_NOT_APPROVED' && e.errors[0].field === 'specialtyId');
	await assert.rejects(() => s.createService(w.user.id, body({ specialtyId: id() })), (e: any) => e.errors[0].code === 'SPECIALTY_NOT_OWNED');
	// skills only from the catalog of the specialty's category
	await assert.rejects(() => s.createService(w.user.id, body({ skills: ['Figma'] })), (e: any) => e.errors[0].field === 'skills');
	// model of another specialty / another provider / not approved
	await assert.rejects(() => s.createService(w.user.id, body({ accreditationSampleId: pendModel.id })), (e: any) => e.errors[0].code === 'MODEL_MISMATCH');
	const stranger = await seed([{ status: 'APPROVED' }]);
	const foreign = await stranger.prisma.accreditationSample.create({ data: { id: id(), providerProfileId: stranger.profile.id, providerSpecialtyId: stranger.specs[0].ps.id, title: 'x', description: 'y', technologiesUsed: [], attachments: [], status: 'AI_VERIFIED' } });
	await assert.rejects(() => s.createService(w.user.id, body({ accreditationSampleId: foreign.id })), (e: any) => e.errors[0].code === 'MODEL_MISMATCH');
	const unapproved = await mk(ok, 'MANUAL_REVIEW');
	await assert.rejects(() => s.createService(w.user.id, body({ accreditationSampleId: unapproved.id })), (e: any) => e.errors[0].code === 'MODEL_NOT_APPROVED');
	await assert.rejects(() => s.createService(w.user.id, body({ accreditationSampleId: undefined })), (e: any) => e.errors[0].field === 'accreditationSampleId');
	assert.equal(await w.prisma.serviceCatalog.count({ where: { providerId: w.user.id } }), 1, 'nothing else was created');

	// editing re-validates: moving to the pending specialty is refused; the service stays as it was
	await assert.rejects(() => s.updateService(w.user.id, created.id, body({ specialtyId: pending.specialty.id, accreditationSampleId: pendModel.id })), (e: any) => e.errors[0].code === 'SPECIALTY_NOT_APPROVED');
	await assert.rejects(() => s.updateService(w.user.id, created.id, body({ skills: ['Figma'] })), (e: any) => e.errors[0].field === 'skills');
	// when the specialty is no longer approved, an archived service cannot be re-published and a manual publish-by-id path is refused
	await w.prisma.serviceCatalog.update({ where: { id: created.id }, data: { status: 'ARCHIVED' } });
	await w.prisma.providerSpecialty.update({ where: { id: ok.ps.id }, data: { status: 'REJECTED' } });
	await assert.rejects(() => s.setServiceVisibility(w.user.id, created.id, true), (e: any) => e.errors[0].code === 'SPECIALTY_NOT_APPROVED');
	await w.prisma.providerSpecialty.update({ where: { id: ok.ps.id }, data: { status: 'APPROVED' } });
	assert.equal((await s.setServiceVisibility(w.user.id, created.id, true)).status, 'PUBLISHED');
});

test('market: changing the specialty of a service re-validates the skills already on it', opts, async () => {
	const w = await seed([{ status: 'APPROVED' }, { status: 'APPROVED', slug: 'design-creative' }]);
	const [a, b] = w.specs; const { MarketplaceService } = await import('./marketplace-service.service'); const s = new MarketplaceService();
	const mk = async (x: any) => w.prisma.accreditationSample.create({ data: { id: id(), providerProfileId: w.profile.id, providerSpecialtyId: x.ps.id, title: 'م', description: 'وصف', technologiesUsed: [], attachments: [], status: 'AI_VERIFIED' } });
	const [ma, mb] = [await mk(a), await mk(b)];
	const base = { title: 'خدمة تطوير', description: 'وصف طويل للخدمة هنا', stages: [stage] };
	const svc = await s.createService(w.user.id, { ...base, specialtyId: a.specialty.id, accreditationSampleId: ma.id, skills: ['React'] });
	// skills omitted but the specialty changes: React is not a design skill
	await assert.rejects(() => s.updateService(w.user.id, svc.id, { ...base, specialtyId: b.specialty.id, accreditationSampleId: mb.id }), (e: any) => e.errors[0].field === 'skills');
	// the old model is not kept for the new specialty
	await assert.rejects(() => s.updateService(w.user.id, svc.id, { ...base, specialtyId: b.specialty.id, skills: ['Figma'] }), (e: any) => e.errors[0].field === 'accreditationSampleId');
	const ok = await s.updateService(w.user.id, svc.id, { ...base, specialtyId: b.specialty.id, accreditationSampleId: mb.id, skills: ['Figma'] });
	assert.deepEqual(ok.skills, ['Figma']);
});

test('migration rollback guard refuses while proof uploads / history / notes exist (idempotency of migration.sql verified on a scratch DB, see the preview doc)', opts, async () => {
	const { readFileSync } = await import('node:fs');
	const prisma = await db();
	const rb = readFileSync(new URL('../../prisma/migrations/20261018010000_approval_request_loop/rollback.sql', import.meta.url), 'utf8');
	const guard = rb.slice(rb.indexOf('DO $guard$'), rb.indexOf('$guard$;', rb.indexOf('END')) + '$guard$;'.length);
	const w = await seed([{ status: 'PENDING_PROOF', isPassed: true }]);
	await proofFor(w, w.specs[0].ps);
	await assert.rejects(() => prisma.$executeRawUnsafe(guard), /ROLLBACK REFUSED/);
	assert.ok((await prisma.$queryRaw`SELECT to_regclass('accreditation_proof_uploads')::text AS t` as any[])[0].t, 'the table is still there');
});
