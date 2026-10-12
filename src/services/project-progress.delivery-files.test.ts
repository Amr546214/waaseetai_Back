import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Stage deliveries must carry a REAL artifact: an uploaded file stored for this stage, or an https link. Never file names alone.
// uploadDeliveryFiles() stores nothing until the contract/stage checks pass.

process.env.CLOUDINARY_CLOUD_NAME = 'waseet-test';
const P = 'provider-1';
const S = 'stage-1';
const folder = `waseetai/deliveries/${P}/${S}`;
const ownUrl = (name = 'a.png') => `https://res.cloudinary.com/waseet-test/image/upload/v1/${folder}/${name}`;

async function load(t: TestContext) {
	// mutable so ONE module mock (allowed once per test) can serve several scenarios
	const state = { contractStatus: 'ACTIVE', stageStatus: 'IN_PROGRESS', stageFound: true, transitionCount: 1 };
	const contract = { id: 'contract-1', projectId: 'project-1', providerId: P, clientId: 'client-1', get status() { return state.contractStatus; } };
	const stage = { id: S, contractId: 'contract-1', title: 'المرحلة 1', get status() { return state.stageStatus; } };
	const calls: Record<string, number> = { contractFind: 0, tx: 0 };
	const created: any[] = [];
	const uploadSpy = t.mock.fn(async (file: any, uploadFolder: string, maxBytes?: number) => ({ url: `https://res.cloudinary.com/waseet-test/image/upload/v1/${uploadFolder}/${file.originalname}`, fileName: file.originalname, mimeType: file.mimetype, bytes: file.size, publicId: 'x', resourceType: 'image' }));
	const tx = {
		projectStage: { updateMany: async () => ({ count: state.transitionCount }) },
		stageDelivery: { create: async (args: any) => { const row = { id: 'delivery-1', ...args.data }; created.push(row); return row; } },
		project: { update: async () => ({}) },
		notification: { create: async () => ({}) }
	};
	const prismaMock = {
		contract: { findFirst: async (args: any) => { calls.contractFind++; return args.where.providerId === contract.providerId ? { id: contract.id, projectId: contract.projectId, providerId: contract.providerId, clientId: contract.clientId, status: contract.status } : null; } },
		projectStage: { findMany: async () => [{ id: stage.id }], findFirst: async () => (state.stageFound ? { id: stage.id, contractId: stage.contractId, title: stage.title, status: stage.status } : null) },
		$transaction: async (fn: any) => { calls.tx++; return fn(tx); }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { emitStored: async () => {} } } });
	t.mock.module('./email.service', { namedExports: { emailService: {} } });
	t.mock.module('../utils/cloudinary-storage', { namedExports: { uploadMulterFile: uploadSpy } });
	const { projectProgressService } = await import(`./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { svc: projectProgressService, calls, created, uploadSpy, state };
}

const NOTE = 'تسليم المرحلة الأولى كاملة';
const refused = async (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => e.statusCode === status && (!re || re.test(e.message)));

test('submitDelivery refuses a delivery with no files and no links — before touching the database', async (t) => {
	const { svc, calls } = await load(t);
	await refused(svc.submitDelivery(P, 'contract-1', S, NOTE, []), 400, /ملفاً واحداً/);
	await refused(svc.submitDelivery(P, 'contract-1', S, NOTE, undefined as any), 400);
	assert.equal(calls.contractFind, 0);
	assert.equal(calls.tx, 0);
});

test('submitDelivery refuses file names only (the old behaviour) and non-https links', async (t) => {
	const { svc, calls, created } = await load(t);
	await refused(svc.submitDelivery(P, 'contract-1', S, NOTE, ['logo.png', 'brand.zip']), 400, /ملفاً مرفوعاً فعلياً/);
	await refused(svc.submitDelivery(P, 'contract-1', S, NOTE, [{ name: 'logo.png', size: 10 }]), 400);
	await refused(svc.submitDelivery(P, 'contract-1', S, NOTE, ['http://example.com/a.zip']), 400, /https/);
	assert.equal(calls.tx, 0);
	assert.equal(created.length, 0);
});

test('submitDelivery refuses an uploaded-file URL that belongs to another stage or provider', async (t) => {
	const { svc, calls } = await load(t);
	await refused(svc.submitDelivery(P, 'contract-1', S, NOTE, [{ url: `https://res.cloudinary.com/waseet-test/image/upload/v1/waseetai/deliveries/${P}/stage-OTHER/a.png` }]), 400, /غير تابع لهذه المرحلة/);
	await refused(svc.submitDelivery(P, 'contract-1', S, NOTE, [{ url: `https://res.cloudinary.com/waseet-test/image/upload/v1/waseetai/deliveries/provider-2/${S}/a.png` }]), 400, /غير تابع لهذه المرحلة/);
	assert.equal(calls.tx, 0);
});

test('submitDelivery accepts an https delivery link and stores it as the only artifact', async (t) => {
	const { svc, created } = await load(t);
	await svc.submitDelivery(P, 'contract-1', S, NOTE, ['https://www.figma.com/file/abc/design']);
	assert.equal(created.length, 1);
	assert.deepEqual(created[0].files, ['https://www.figma.com/file/abc/design']);
});

test('submitDelivery accepts an uploaded file of this stage and keeps its name/type/size', async (t) => {
	const { svc, created } = await load(t);
	await svc.submitDelivery(P, 'contract-1', S, NOTE, [{ name: 'logo.png', url: ownUrl('logo.png'), type: 'image/png', size: 2048 }]);
	assert.equal(created.length, 1);
	assert.deepEqual(JSON.parse(created[0].files[0]), { name: 'logo.png', url: ownUrl('logo.png'), type: 'image/png', size: 2048 });
});

test('submitDelivery still requires the note, an ACTIVE contract of this provider and an open stage', async (t) => {
	const a = await load(t);
	await refused(a.svc.submitDelivery(P, 'contract-1', S, 'قصير', ['https://example.com/a']), 400, /10 أحرف/);
	await refused(a.svc.submitDelivery('someone-else', 'contract-1', S, NOTE, ['https://example.com/a']), 403);
	assert.equal(a.calls.tx, 0);
});

test('uploadDeliveryFiles stores nothing without files, with too many files, or when the contract/stage does not allow a delivery', async (t) => {
	const { svc, uploadSpy, state } = await load(t);
	const f = (name: string) => ({ originalname: name, mimetype: 'image/png', size: 100, buffer: Buffer.alloc(8) });
	await refused(svc.uploadDeliveryFiles(P, 'contract-1', S, []), 400, /ملفاً واحداً/);
	await refused(svc.uploadDeliveryFiles(P, 'contract-1', S, Array.from({ length: 6 }, (_v, i) => f(`${i}.png`)) as any), 400, /5/);
	await refused(svc.uploadDeliveryFiles('someone-else', 'contract-1', S, [f('a.png')] as any), 403);
	state.stageFound = false;
	await refused(svc.uploadDeliveryFiles(P, 'contract-1', 'missing', [f('a.png')] as any), 409);
	state.stageFound = true; state.stageStatus = 'SUBMITTED';
	await refused(svc.uploadDeliveryFiles(P, 'contract-1', S, [f('a.png')] as any), 409);
	state.stageStatus = 'IN_PROGRESS'; state.contractStatus = 'COMPLETED';
	await refused(svc.uploadDeliveryFiles(P, 'contract-1', S, [f('a.png')] as any), 403);
	assert.equal(uploadSpy.mock.callCount(), 0, 'nothing was stored in any refused case');
});

test('uploadDeliveryFiles stores each file in the provider\'s folder for this stage (25MB cap) and returns the descriptors the delivery accepts', async (t) => {
	const { svc, uploadSpy, created } = await load(t);
	const files = [
		{ originalname: Buffer.from('شعار.png', 'utf8').toString('latin1'), mimetype: 'image/png', size: 1000, buffer: Buffer.alloc(8) },
		{ originalname: 'brief.pdf', mimetype: 'application/pdf', size: 2000, buffer: Buffer.alloc(8) }
	];
	const out = await svc.uploadDeliveryFiles(P, 'contract-1', S, files as any);
	assert.equal(uploadSpy.mock.callCount(), 2);
	for (const call of uploadSpy.mock.calls) {
		assert.equal(call.arguments[1], folder);
		assert.equal(call.arguments[2], 25 * 1024 * 1024);
	}
	assert.equal(out[0].name, 'شعار.png'); // multer's latin1 name is repaired
	assert.deepEqual(out.map((x: any) => x.type), ['image/png', 'application/pdf']);
	// what the upload returns is exactly what submitDelivery accepts
	await svc.submitDelivery(P, 'contract-1', S, NOTE, out);
	assert.equal(created.length, 1);
	assert.equal(created[0].files.length, 2);
});
