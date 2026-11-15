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

// ── resubmission: the previous revision's AI result is cleared in the same transaction ──
async function rejectedWithScore(w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown> = {}) {
	const old = await w.prisma.accreditationSample.create({ data: { id: id(), providerProfileId: (await w.prisma.providerProfile.findUniqueOrThrow({ where: { userId: w.user.id } })).id, providerSpecialtyId: w.ps.id, title: 'قديم', description: 'نموذج سابق', technologiesUsed: [], status: 'REJECTED', decidedAt: new Date(), aiScore: 91, aiQualityRating: 'Excellent', aiFeedbackAr: 'تقييم النسخة الأولى', aiStrengths: ['قوة'], aiRecommendations: ['توصية'], aiAuditedAt: new Date('2026-11-01T10:00:00Z'), revision: 1, ...extra } as any });
	await w.prisma.accreditationProofUpload.updateMany({ where: { id: { in: [w.png.id, w.zip.id] } }, data: { sampleId: old.id } });
	return old;
}

test('real DB: resubmitting a 91-point sample CLEARS every AI field in the transaction; if the new review fails the sample has NO score', opts, async () => {
	const w = await world(); const old = await rejectedWithScore(w);
	const { svc } = await service(async () => { throw new Error('upstream down'); }, w);
	const res: any = await svc.submitAccreditationSample({ ...w.dto, resubmitSampleId: old.id });
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: old.id } });
	assert.equal(res.sample.id, old.id, 'the SAME request is re-opened');
	assert.equal(row.revision, 2);
	assert.equal(row.status, 'MANUAL_REVIEW');
	assert.deepEqual([row.aiScore, row.aiQualityRating, row.aiFeedbackAr, row.aiAuditedAt], [null, null, null, null]);
	assert.deepEqual([row.aiStrengths, row.aiRecommendations], [[], []]);
});

test('real DB: resubmission whose review read NO evidence: the old 91 is gone and only the new feedback (no score) is stored', opts, async () => {
	const w = await world(); const old = await rejectedWithScore(w);
	const { svc } = await service(async () => ({ inspected: false, evaluation: { aiScore: 88, aiQualityRating: 'Good', feedbackAr: 'لم تُقرأ أدلة' } }), w);
	await svc.submitAccreditationSample({ ...w.dto, resubmitSampleId: old.id });
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: old.id } });
	assert.equal(row.aiScore, null);
	assert.equal(row.aiQualityRating, null);
	assert.equal(row.aiFeedbackAr, 'لم تُقرأ أدلة');
});

test('real DB: resubmission with evidence replaces the old 91 with the NEW score', opts, async () => {
	const w = await world(); const old = await rejectedWithScore(w);
	const { svc } = await service(async () => ({ inspected: true, evaluation: { aiScore: 64, aiQualityRating: 'Acceptable', feedbackAr: 'تقييم النسخة الثانية' } }), w);
	await svc.submitAccreditationSample({ ...w.dto, resubmitSampleId: old.id });
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: old.id } });
	assert.equal(row.aiScore, 64);
	assert.equal(row.aiFeedbackAr, 'تقييم النسخة الثانية');
});

test('real DB: a reviewer decision that lands while the NEW review runs still wins, and the old 91 does not come back', opts, async () => {
	const w = await world(); const old = await rejectedWithScore(w);
	const { svc } = await service(async (_body, ctx) => {
		await ctx.prisma.accreditationSample.update({ where: { id: ctx.sampleId }, data: { status: 'REJECTED', decidedAt: new Date() } });
		return { inspected: true, evaluation: { aiScore: 70, aiQualityRating: 'Good', feedbackAr: 'متأخر' } };
	}, w);
	await svc.submitAccreditationSample({ ...w.dto, resubmitSampleId: old.id });
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: old.id } });
	assert.equal(row.status, 'REJECTED', 'the reviewer\'s decision stands');
	assert.deepEqual([row.aiScore, row.aiFeedbackAr, row.aiAuditedAt], [null, null, null]);
});

test('real DB: a NEWER revision (a second resubmission) that lands while the review of the previous one runs wins over the late answer', opts, async () => {
	const w = await world(); const old = await rejectedWithScore(w);
	const { svc } = await service(async (_body, ctx) => {
		await ctx.prisma.accreditationSample.update({ where: { id: ctx.sampleId }, data: { revision: { increment: 1 }, aiScore: null } });
		return { inspected: true, evaluation: { aiScore: 70, aiQualityRating: 'Good', feedbackAr: 'متأخر' } };
	}, w);
	await svc.submitAccreditationSample({ ...w.dto, resubmitSampleId: old.id });
	const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: old.id } });
	assert.equal(row.revision, 3);
	assert.equal(row.aiScore, null);
});
