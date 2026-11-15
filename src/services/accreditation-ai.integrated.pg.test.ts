import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/**
 * INTEGRATED path, nothing between the website and the stored row is stubbed except the model and the storage read:
 *   real WaseetAiClient (signed token exchange)  ->  the real waseet-ai-service app listening on a local port (its own routes, auth, inspector, rubric)
 *   ->  real accreditationAiService  ->  real PostgreSQL row.
 * Needs the isolated PostgreSQL AND a checkout of the AI service:
 *   WASEET_AI_SERVICE_REPO=/path/to/waseet-ai-service QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/<db> DATABASE_URL=<same> \
 *     npx tsx --test --experimental-test-module-mocks src/services/accreditation-ai.integrated.pg.test.ts
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const REPO = process.env.WASEET_AI_SERVICE_REPO;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL) && !!REPO;
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated PostgreSQL on :55432) and WASEET_AI_SERVICE_REPO (checkout of waseet-ai-service)' };

process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud';
process.env.CLOUDINARY_API_KEY ??= '123456789012345';
process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';
const id = () => randomUUID();
const realFetch = globalThis.fetch; // the AI service's test fixtures replace fetch with a network guard; the BE client keeps this one

const crc32 = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body)); return Buffer.concat([l, body, c]); };
function validPng(): Buffer {
	const h = Buffer.alloc(13); h.writeUInt32BE(8, 0); h.writeUInt32BE(8, 4); h[8] = 8; h[9] = 2;
	const raw = Buffer.alloc((8 * 3 + 1) * 8); for (let y = 0; y < 8; y++) for (let x = 0; x < 24; x++) raw[y * 25 + 1 + x] = (x * 7 + y * 13) & 255;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', h), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const corruptPng = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 120 }, (_, i) => (i * 37 + 11) & 255))]);

async function boot(proofBytes: Buffer, readable: boolean) {
	const fixtures: any = await import(pathToFileURL(`${REPO}/tests/helpers/ai-fixtures.ts`).href);
	fixtures.paidFixture();
	const app = fixtures.buildApp();
	await app.ready();
	const baseUrl: string = await app.listen({ port: 0, host: '127.0.0.1' });
	fixtures.GeminiGateway.setMockHandler(async (req: any) => {
		const prompt = JSON.parse(req.prompt);
		if (req.featureId === 'AI-07-ACCREDITATION-DECLARED-REVIEW') return JSON.stringify({ feedbackAr: 'وصف واضح ومكتمل', strengths: ['وصف مرتب'], recommendations: ['أرفق ملفات'] });
		return JSON.stringify({
			criteria: ['specialtyRelevance', 'technicalSubstance', 'deliverableCompleteness', 'claimConsistency', 'presentationClarity'].map(c => ({ id: c, score: 80, observation: 'ملاحظة من الصورة' })),
			visualReadings: (prompt.visualAttachments ?? []).map((a: any) => ({ index: a.index, readable, observation: readable ? 'واجهة تطبيق' : 'غير واضحة' })),
			feedbackAr: 'قراءة من الصورة', findings: [], recommendations: ['أضف توثيقًا'],
		});
	});
	const { WaseetAiClient } = await import('./ai/waseet-ai/waseet-ai.client');
	const client = new WaseetAiClient(realFetch as any, () => ({ baseUrl, bearerToken: undefined, restTimeoutMs: 30_000, streamTimeoutMs: 30_000, authMode: 'signed', clientId: 'test-client', clientSecret: 'test-client-secret-32-characters-long', environment: 'dev' }));
	const proof = await import('./accreditation-proof.service');
	proof.proofStorage.exists = async () => true;
	const mod = await import('./accreditation-ai.service');
	mod.accreditationAiDeps.client = client as any;
	mod.accreditationAiDeps.readProof = async (_ref: string, mime: string) => `data:${mime};base64,${proofBytes.toString('base64')}`;
	return { app, mod, fixtures };
}

async function world() {
	const { prisma } = await import('../config/db');
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'a', lastName: tag, email: `int-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const profile = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, isProfileSetupComplete: true } });
	const category = (await prisma.category.findUnique({ where: { slug: 'programming-development' } })) ?? (await prisma.category.create({ data: { id: id(), slug: 'programming-development', nameAr: 'x' } }));
	const specialty = await prisma.specialty.create({ data: { id: id(), slug: `sp-${tag}`, categoryId: category.id, nameAr: 'تطوير تطبيقات' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: profile.id, specialtyId: specialty.id, subSpecialties: [], status: 'PENDING_PROOF', isPassed: true, isActive: true } as any });
	const png = await prisma.accreditationProofUpload.create({ data: { id: id(), userId: user.id, providerSpecialtyId: ps.id, privateRef: `private:image:png:waseetai/accreditation/${user.id}/proofs/shot-${tag}`, fileName: 'shot.png', mimeType: 'image/png', bytes: 1500, status: 'COMPLETED' } as any });
	return { prisma, dto: { userId: user.id, providerSpecialtyId: ps.id, title: 'تطبيق', description: 'وصف تطبيق كامل وواضح', technologiesUsed: ['Flutter'], attachments: [] as string[], proofIds: [png.id] } };
}

test('integrated: a valid PNG the model read -> the AI service answers inspected=true with the score -> the website stores it on the MANUAL_REVIEW row', opts, async () => {
	const { app, mod, fixtures } = await boot(validPng(), true);
	try {
		const w = await world();
		const res: any = await mod.accreditationAiService.submitAccreditationSample(w.dto);
		assert.equal(res.aiEvaluation.available, true);
		assert.equal(res.aiEvaluation.inspected, true);
		const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: res.sample.id } });
		assert.equal(row.status, 'MANUAL_REVIEW');
		assert.equal(row.aiScore, 80, 'the weighted score computed by the service reached the stored row');
		assert.equal(row.aiQualityRating, 'Good');
		assert.ok(row.aiAuditedAt);
	} finally { fixtures.GeminiGateway.setMockHandler(null); await app.close(); }
});

test('integrated: a CORRUPT image (> 32 bytes) -> the service reports it unreadable (inspected=false, no score) -> the stored row has no score', opts, async () => {
	const { app, mod, fixtures } = await boot(corruptPng(), true);
	try {
		const w = await world();
		const res: any = await mod.accreditationAiService.submitAccreditationSample(w.dto);
		const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: res.sample.id } });
		assert.equal(row.status, 'MANUAL_REVIEW');
		assert.equal(row.aiScore, null);
		assert.equal(row.aiQualityRating, null);
		assert.match(String(row.aiFeedbackAr ?? ''), /تعذّر قراءة الأدلة/);
	} finally { fixtures.GeminiGateway.setMockHandler(null); await app.close(); }
});

test('integrated: a valid image the model could NOT read -> no score is stored', opts, async () => {
	const { app, mod, fixtures } = await boot(validPng(), false);
	try {
		const w = await world();
		const res: any = await mod.accreditationAiService.submitAccreditationSample(w.dto);
		const row = await w.prisma.accreditationSample.findUniqueOrThrow({ where: { id: res.sample.id } });
		assert.equal(row.aiScore, null);
		assert.equal(row.aiQualityRating, null);
	} finally { fixtures.GeminiGateway.setMockHandler(null); await app.close(); }
});
