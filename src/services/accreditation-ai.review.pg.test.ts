import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test of the advisory AI review of an accreditation sample (isolated local PostgreSQL only, see pg-admin-proofs.pg.test.ts):
 * the proofs are real upload rows, the AI service is the module's injectable client, and the "reviewer decides / provider resubmits while the AI is working"
 * races are produced FOR REAL inside the AI call. A late answer must never overwrite the newer state.
 *   QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/<db> DATABASE_URL=<same> node --import tsx --experimental-test-module-mocks --test src/services/accreditation-ai.review.pg.test.ts
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
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'a', lastName: tag, email: `ai-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const profile = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, isProfileSetupComplete: true } });
	const category = (await prisma.category.findUnique({ where: { slug: 'programming-development' } })) ?? (await prisma.category.create({ data: { id: id(), slug: 'programming-development', nameAr: 'x' } }));
	const specialty = await prisma.specialty.create({ data: { id: id(), slug: `sp-${tag}`, categoryId: category.id, nameAr: 'تطوير الويب' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: profile.id, specialtyId: specialty.id, subSpecialties: [], status: 'PENDING_PROOF', isPassed: true, isActive: true } as any });
	const mk = (fileName: string, mimeType: string, bytes: number) => prisma.accreditationProofUpload.create({ data: { id: id(), userId: user.id, providerSpecialtyId: ps.id, privateRef: `private:${mimeType.startsWith('image') ? 'image:png' : 'raw:pdf'}:waseetai/accreditation/${user.id}/proofs/${fileName}-${tag}`, fileName, mimeType, bytes, status: 'COMPLETED' } as any });
	const png = await mk('screen.png', 'image/png', 2000);
	const zip = await mk('source.zip', 'application/zip', 9000);
	const dto = { userId: user.id, providerSpecialtyId: ps.id, title: 'نظام مخزون', description: 'وصف تقني حقيقي وكامل للمشروع', technologiesUsed: ['React'], attachments: [] as string[], proofIds: [png.id, zip.id] };
	return { prisma, user, ps, dto, png, zip, tag };
}

async function service(aiAnswer: (body: any, ctx: { prisma: any; sampleId: string }) => Promise<any>, ctx: { prisma: any }) {
	const proof = await import('./accreditation-proof.service');
	proof.proofStorage.exists = async () => true;
	const mod = await import('./accreditation-ai.service');
	const requests: any[] = [];
	mod.accreditationAiDeps.client = { isConfigured: () => true, reviewAccreditation: async (body: any) => { requests.push(body); return aiAnswer(body, { prisma: ctx.prisma, sampleId: body.sampleId }); } };
	mod.accreditationAiDeps.readProof = async (_ref: string, mime: string) => `data:${mime};base64,QUJD`;
	return { svc: mod.accreditationAiService, requests };
}

const evidenceAnswer = { inspected: true, status: 'MANUAL_REVIEW', evaluation: { aiScore: 77, aiQualityRating: 'Good', feedbackAr: 'ملخص مبني على الملفات' } };

test('real DB: the user\'s own proof content and the specialty reach the AI request; the zip is reported unreadable; the answer is stored on the same revision', opts, async () => {
	const w = await world();
	const { svc, requests } = await service(async () => evidenceAnswer, w);
	const res: any = await svc.submitAccreditationSample(w.dto);
	assert.deepEqual(requests[0].attachments, ['data:image/png;base64,QUJD']);
	assert.deepEqual(requests[0].unreadAttachments, ['source.zip']);
	assert.equal(requests[0].specialtyName, 'تطوير الويب');
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: res.sample.id } });
	assert.equal(row.status, 'MANUAL_REVIEW');
	assert.equal(row.aiScore, 77);
	assert.equal(row.aiQualityRating, 'Good');
	assert.ok(row.aiAuditedAt);
});

test('real DB: a reviewer decision that lands WHILE the AI works wins; the late AI answer writes nothing', opts, async () => {
	const w = await world();
	const { svc } = await service(async (_body, ctx) => {
		await ctx.prisma.accreditationSample.update({ where: { id: ctx.sampleId }, data: { status: 'REJECTED', decidedAt: new Date() } });
		return evidenceAnswer;
	}, w);
	const res: any = await svc.submitAccreditationSample(w.dto);
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: res.sample.id } });
	assert.equal(row.status, 'REJECTED', 'the reviewer\'s decision stands');
	assert.equal(row.aiScore, null);
	assert.equal(row.aiFeedbackAr, null);
	assert.equal(row.aiAuditedAt, null);
	assert.equal(res.aiEvaluation.available, false);
	assert.equal(res.aiEvaluation.superseded, true);
});

test('real DB: a resubmission (new revision) that lands WHILE the AI works wins; the late answer about the OLD revision writes nothing', opts, async () => {
	const w = await world();
	const { svc } = await service(async (_body, ctx) => {
		await ctx.prisma.accreditationSample.update({ where: { id: ctx.sampleId }, data: { revision: { increment: 1 }, description: 'نسخة أحدث بعد إعادة الإرسال' } });
		return evidenceAnswer;
	}, w);
	const res: any = await svc.submitAccreditationSample(w.dto);
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: res.sample.id } });
	assert.equal(row.revision, 2);
	assert.equal(row.description, 'نسخة أحدث بعد إعادة الإرسال');
	assert.equal(row.aiScore, null);
	assert.equal(res.aiEvaluation.superseded, true);
});

test('real DB: an answer that read no evidence stores its feedback but never a score or rating', opts, async () => {
	const w = await world();
	const { svc } = await service(async () => ({ inspected: false, evaluation: { aiScore: 90, aiQualityRating: 'Excellent', feedbackAr: 'لم تُقرأ أدلة؛ وصف مرتب' } }), w);
	const res: any = await svc.submitAccreditationSample(w.dto);
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: res.sample.id } });
	assert.equal(row.aiScore, null);
	assert.equal(row.aiQualityRating, null);
	assert.equal(row.aiFeedbackAr, 'لم تُقرأ أدلة؛ وصف مرتب');
});

test('real DB: an AI failure leaves the stored MANUAL_REVIEW sample untouched (no AI columns)', opts, async () => {
	const w = await world();
	const { svc } = await service(async () => { throw new Error('upstream down'); }, w);
	const res: any = await svc.submitAccreditationSample(w.dto);
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: res.sample.id } });
	assert.equal(row.status, 'MANUAL_REVIEW');
	assert.equal(row.aiScore, null);
	assert.equal(row.aiAuditedAt, null);
	assert.equal(res.aiEvaluation.available, false);
});
