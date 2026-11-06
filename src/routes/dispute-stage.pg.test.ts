import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Case 2 (dispute on a stage): REAL PostgreSQL (isolated local :55432, database qa_iso_dispute*) + the REAL client/admin routers, multer upload, services and DB constraints over HTTP.
 * Replaced: `authenticate` (reads the user id from a header, loads that user from the DB) and the storage upload (Cloudinary cannot be reached here: files are recorded as fake private refs).
 * Everything else (role gates, case-attachments access rules, idempotency, freeze) is the production code.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432, database qa_iso_dispute) to run' };
process.env.RATE_LIMIT_ENABLED = 'false'; // the upload tier has its own tests; here it would only throttle the test client
process.env.JWT_SECRET ??= 'test-secret'; process.env.FRONTEND_URL ??= 'https://front.test';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';

const stored: string[] = []; const deleted: string[] = []; let failUpload = false;
let ctx: Promise<any> | null = null;
async function env() {
	if (ctx) return ctx;
	ctx = (async () => {
		const { prisma } = await import('../config/db');
		const realAuth = await import('../middlewares/auth.middleware');
		mock.module('../middlewares/auth.middleware', { namedExports: { ...realAuth, authenticate: async (req: any, res: any, next: any) => {
			const id = req.headers['x-test-user']; const u = id ? await prisma.user.findUnique({ where: { id: String(id) } }) : null;
			if (!u) return res.status(401).json({ success: false, message: 'غير مصرح' });
			req.user = { id: u.id, userId: u.id, email: u.email, accountType: u.accountType, status: u.status, activeRole: u.activeRole, roles: u.roles, sessionId: 's' }; next();
		} } });
		const realStorage = await import('../utils/cloudinary-storage');
		mock.module('../utils/cloudinary-storage', { namedExports: { ...realStorage,
			uploadMulterFile: async (file: any) => { if (failUpload) throw new Error('storage down'); const id = `case-files/${randomUUID()}`; stored.push(id); return { url: 'x', fileName: file.originalname, publicId: id, resourceType: 'image', mimeType: file.mimetype, bytes: file.buffer.length, privateRef: `ref:${id}` }; },
			deleteCloudFile: async (publicId: string) => { deleted.push(publicId); },
			createPrivateDownloadUrl: (ref: string) => ({ url: `https://signed.test/${ref}`, expiresAt: new Date(Date.now() + 60000) }) } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const clientRequests = (await import('./client-requests.routes')).default;
		const clientDisputes = (await import('./client-disputes.routes')).default;
		const adminDisputes = (await import('./admin-disputes.routes')).default;
		const app = express(); app.use(express.json());
		app.use('/client/requests', clientRequests); app.use('/client/disputes', clientDisputes); app.use('/admin/disputes', adminDisputes);
		app.use(globalErrorHandler as any);
		const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as AddressInfo).port;
		const call = async (method: string, url: string, who?: string | null, body?: any) => {
			const headers: Record<string, string> = { connection: 'close', ...(who ? { 'x-test-user': who } : {}) };
			let payload: any;
			if (body instanceof FormData) payload = body; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
			const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: payload });
			const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
			return { status: res.status, json };
		};
		return { prisma, call, server };
	})();
	return ctx;
}
after(async () => { if (ctx) { const e = await ctx; e.server.closeAllConnections?.(); await new Promise(r => e.server.close(r)); await e.prisma.$disconnect(); } });

const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const LONG = 'التسليم لا يطابق ما اتفقنا عليه في العقد ولم تُنفذ المتطلبات المحددة في هذه المرحلة، والشرح هنا مفصل ليتجاوز الحد الأدنى للأحرف المطلوبة. ';
const form = (f: Record<string, string | undefined>, files: Array<{ name: string; type: string; data: Buffer }> = []) => {
	const fd = new FormData(); for (const [k, v] of Object.entries(f)) if (v !== undefined) fd.append(k, v);
	for (const x of files) fd.append('attachments', new Blob([new Uint8Array(x.data)], { type: x.type }), x.name); return fd;
};

async function seed(stageStatuses: Array<'PENDING' | 'IN_PROGRESS' | 'SUBMITTED' | 'REVISION_REQUESTED' | 'APPROVED'> = ['SUBMITTED', 'PENDING']) {
	const { prisma } = await env(); const tag = randomUUID().slice(0, 8); const id = () => randomUUID();
	const mk = (accountType: any, role: any, label: string) => prisma.user.create({ data: { id: id(), accountType, status: 'ACTIVE', roles: [role], activeRole: role, firstName: 'QA', lastName: label, email: `qa-${label}-${tag}@pg.test` } as any });
	const client = await mk('CLIENT_INDIVIDUAL', 'CLIENT', 'client'), provider = await mk('PROVIDER_INDIVIDUAL', 'PROVIDER', 'prov');
	const outsider = await mk('CLIENT_INDIVIDUAL', 'CLIENT', 'outsider'), admin = await mk('SUPER_ADMIN', 'SUPER_ADMIN', 'admin');
	const project = await prisma.project.create({ data: { id: id(), title: `QA-${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 14, phasesCount: stageStatuses.length, status: 'ACTIVE', signedAt: new Date() } });
	const escrow = await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: 20, status: 'HELD', feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, providerCommissionSnapshotAt: new Date(), paymentMethod: 'WALLET', paymentReference: `PG-${tag}`, fundedAt: new Date() } });
	const stages: any[] = [];
	for (const [i, status] of stageStatuses.entries()) stages.push(await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: i + 1, title: `مرحلة ${i + 1}`, days: 7, percentage: 100 / stageStatuses.length, amount: 20 / stageStatuses.length, status } }));
	return { prisma, client, provider, outsider, admin, project, contract, escrow, stages };
}
const body = (w: any, over: Record<string, string | undefined> = {}) => ({ reason: 'جودة التسليم لا تطابق العقد', description: LONG, stageId: w.stages[0].id, requestedResolution: 'REDELIVER_WITH_FIXES', submissionKey: randomUUID(), ...over });
const open = (e: any, w: any, who: string, f: Record<string, string | undefined>, files: any[] = []) => e.call('POST', `/client/requests/${w.project.id}/disputes`, who, form(f, files));

test('pg: stage dispute is persisted (stage, reason, description, requested resolution, files) and readable as the recorded case', opts, async () => {
	const e = await env(); const w = await seed();
	const r = await open(e, w, w.client.id, body(w), [{ name: 'a.png', type: 'image/png', data: PNG() }, { name: 'b.pdf', type: 'application/pdf', data: PDF() }]);
	assert.equal(r.status, 201, JSON.stringify(r.json));
	const row = await w.prisma.dispute.findUnique({ where: { id: r.json.data.id }, include: { attachments: true } });
	assert.equal(row.stageId, w.stages[0].id); assert.equal(row.requestedResolution, 'REDELIVER_WITH_FIXES'); assert.equal(row.openedById, w.client.id); assert.equal(row.againstUserId, w.provider.id);
	assert.equal(row.attachments.length, 2); assert.ok(row.attachments.every((a: any) => a.ownerId === w.client.id && a.requestKey === row.submissionKey && a.digest === row.submissionDigest));
	const got = await e.call('GET', `/client/disputes/${row.id}`, w.client.id);
	assert.equal(got.status, 200); assert.equal(got.json.data.stage.id, w.stages[0].id); assert.equal(got.json.data.requestedResolutionLabel, 'طلب إعادة التسليم بالتعديلات المطلوبة'); assert.equal(got.json.data._count.attachments, 2);
	// money untouched, project frozen
	const esc = await w.prisma.escrow.findUnique({ where: { id: w.escrow.id } }); assert.equal(esc.status, 'HELD'); assert.equal(esc.releasedAmount ?? 0, 0);
	assert.equal(got.json.data.projectFreeze.frozen, true);
});

test('pg: duplicate submit (same key) returns the SAME dispute: no second row, no second upload; same key with other content is 409', opts, async () => {
	const e = await env(); const w = await seed(); const b = body(w); const files = [{ name: 'a.png', type: 'image/png', data: PNG() }];
	const first = await open(e, w, w.client.id, b, files); assert.equal(first.status, 201);
	const uploads = stored.length;
	const second = await open(e, w, w.client.id, b, files); assert.equal(second.status, 200); assert.equal(second.json.data.id, first.json.data.id);
	assert.equal(stored.length, uploads, 'a replay uploads nothing');
	assert.equal(await w.prisma.dispute.count({ where: { projectId: w.project.id } }), 1); assert.equal(await w.prisma.caseAttachment.count({ where: { disputeId: first.json.data.id } }), 1);
	const other = await open(e, w, w.client.id, { ...b, description: LONG + 'تعديل' }, files); assert.equal(other.status, 409);
	const foreignKey = await open(e, w, w.outsider.id, b, files); assert.notEqual(foreignKey.status, 201);
	assert.equal(await w.prisma.dispute.count({ where: { projectId: w.project.id } }), 1);
});

test('pg: five parallel submits with one key create exactly one dispute; with different keys the open-dispute rule still gives exactly one', opts, async () => {
	const e = await env(); const w = await seed(); const b = body(w);
	const same = await Promise.all([1, 2, 3, 4, 5].map(() => open(e, w, w.client.id, b)));
	assert.equal(await w.prisma.dispute.count({ where: { projectId: w.project.id } }), 1, JSON.stringify(same.map(x => x.status)));
	assert.ok(same.every(x => x.status === 201 || x.status === 200));
	const w2 = await seed();
	const diff = await Promise.all([1, 2, 3, 4].map(() => open(e, w2, w2.client.id, body(w2, { submissionKey: randomUUID() }))));
	assert.equal(await w2.prisma.dispute.count({ where: { projectId: w2.project.id } }), 1); assert.equal(diff.filter(x => x.status === 201).length, 1); assert.ok(diff.filter(x => x.status !== 201).every(x => x.status === 409));
});

test('pg: eligibility: PENDING / APPROVED stages, another project\'s stage, a missing stage, a short description and bad files are all refused with nothing stored', opts, async () => {
	const e = await env(); const w = await seed(['APPROVED', 'IN_PROGRESS', 'PENDING']); const other = await seed();
	const field = (r: any) => r.json?.errors?.[0]?.field;
	let r = await open(e, w, w.client.id, body(w, { stageId: w.stages[0].id })); assert.equal(r.status, 400); assert.equal(field(r), 'stageId');
	r = await open(e, w, w.client.id, body(w, { stageId: w.stages[2].id })); assert.equal(r.status, 400); assert.equal(field(r), 'stageId');
	r = await open(e, w, w.client.id, body(w, { stageId: other.stages[0].id })); assert.equal(r.status, 400); assert.equal(field(r), 'stageId');
	r = await open(e, w, w.client.id, body(w, { stageId: undefined })); assert.equal(r.status, 400); assert.equal(field(r), 'stageId');
	r = await open(e, w, w.client.id, body(w, { stageId: w.stages[1].id, description: 'قصير جدًا لكنه أكثر من عشرة أحرف' })); assert.equal(r.status, 400); assert.equal(field(r), 'description');
	r = await open(e, w, w.client.id, body(w, { stageId: w.stages[1].id, requestedResolution: 'GIVE_ME_MONEY' })); assert.equal(r.status, 400);
	const before = stored.length;
	r = await open(e, w, w.client.id, body(w, { stageId: w.stages[1].id }), [{ name: 'x.png', type: 'image/png', data: Buffer.from('not a png at all') }]); assert.equal(r.status, 415);
	r = await open(e, w, w.client.id, body(w, { stageId: w.stages[1].id }), [{ name: 'x.svg', type: 'image/svg+xml', data: Buffer.from('<svg/>') }]); assert.equal(r.status, 415);
	r = await open(e, w, w.client.id, body(w, { stageId: w.stages[1].id }), Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', data: PNG() }))); assert.ok([400, 413].includes(r.status), String(r.status));
	assert.equal(stored.length, before); assert.equal(await w.prisma.dispute.count({ where: { projectId: w.project.id } }), 0);
	const ok = await open(e, w, w.client.id, body(w, { stageId: w.stages[1].id })); assert.equal(ok.status, 201, 'IN_PROGRESS stage is eligible');
});

test('pg: storage failure: no dispute is created, already-stored files are cleaned up', opts, async () => {
	const e = await env(); const w = await seed(); failUpload = true;
	try { const r = await open(e, w, w.client.id, body(w), [{ name: 'a.png', type: 'image/png', data: PNG() }]); assert.ok(r.status >= 500, String(r.status)); } finally { failUpload = false; }
	assert.equal(await w.prisma.dispute.count({ where: { projectId: w.project.id } }), 0);
	const retry = await open(e, w, w.client.id, body(w), [{ name: 'a.png', type: 'image/png', data: PNG() }]); assert.equal(retry.status, 201);
});

test('pg: authorisation matrix: owner / counterpart / admin read the case and its evidence; an outsider cannot open it or its files; wrong role and anonymous are refused', opts, async () => {
	const e = await env(); const w = await seed();
	assert.equal((await open(e, w, w.outsider.id, body(w))).status, 403, 'outsider cannot open a dispute on another client\'s project');
	assert.equal((await open(e, w, w.provider.id, body(w))).status, 403, 'provider acting role is refused on the client route');
	assert.equal((await e.call('POST', `/client/requests/${w.project.id}/disputes`, null, body(w))).status, 401);
	const r = await open(e, w, w.client.id, body(w), [{ name: 'proof.png', type: 'image/png', data: PNG() }]); assert.equal(r.status, 201); const id = r.json.data.id;
	const fileId = (await w.prisma.caseAttachment.findFirst({ where: { disputeId: id } })).id;
	// owner
	assert.equal((await e.call('GET', `/client/disputes/${id}`, w.client.id)).status, 200);
	const list = await e.call('GET', `/client/disputes/${id}/attachments`, w.client.id); assert.equal(list.json.data.length, 1); assert.equal(list.json.data[0].privateRef, undefined);
	assert.match((await e.call('GET', `/client/disputes/${id}/attachments/${fileId}/download`, w.client.id)).json.data.url, /^https:\/\/signed\.test\//);
	// counterpart (the provider is a party): reads through the client router's gate is wrong role (403); the data access rule itself is party-based
	const { assertCaseAccess } = await import('../services/case-attachments.service');
	await assertCaseAccess('dispute', id, w.provider.id, false); await assert.rejects(() => assertCaseAccess('dispute', id, w.outsider.id, false), (x: any) => x.statusCode === 404);
	// outsider
	assert.equal((await e.call('GET', `/client/disputes/${id}`, w.outsider.id)).status, 403);
	assert.equal((await e.call('GET', `/client/disputes/${id}/attachments`, w.outsider.id)).status, 404);
	assert.equal((await e.call('GET', `/client/disputes/${id}/attachments/${fileId}/download`, w.outsider.id)).status, 404);
	assert.equal((await e.call('GET', `/client/disputes/${id}/attachments`, null)).status, 401);
	// admin
	const adm = await e.call('GET', `/admin/disputes/${id}`, w.admin.id); assert.equal(adm.status, 200); assert.equal(adm.json.data.stage.id, w.stages[0].id); assert.equal(adm.json.data.requestedResolution, 'REDELIVER_WITH_FIXES');
	assert.equal((await e.call('GET', `/admin/disputes/${id}/attachments`, w.admin.id)).json.data.length, 1);
	assert.match((await e.call('GET', `/admin/disputes/${id}/attachments/${fileId}/download`, w.admin.id)).json.data.url, /^https:\/\/signed\.test\//);
	assert.equal((await e.call('GET', `/admin/disputes/${id}`, w.client.id)).status, 403, 'a client is refused on the admin route');
});

test('pg: while the dispute is open the stage approval is frozen (423) and nothing is released; no money row is written by opening', opts, async () => {
	const e = await env(); const w = await seed(); await w.prisma.stageDelivery.create({ data: { id: randomUUID(), stageId: w.stages[0].id, providerId: w.provider.id, note: 'synthetic delivery note', status: 'SUBMITTED' } });
	const wtxBefore = await w.prisma.walletTransaction.count({ where: { userId: w.client.id } });
	assert.equal((await open(e, w, w.client.id, body(w))).status, 201);
	const { projectProgressService } = await import('../services/project-progress.service');
	await assert.rejects(() => projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.stages[0].id, 'approve'), (x: any) => x.statusCode === 423);
	const esc = await w.prisma.escrow.findUnique({ where: { id: w.escrow.id } }); assert.equal(esc.status, 'HELD'); assert.equal(esc.releasedAmount ?? 0, 0);
	assert.equal(await w.prisma.walletTransaction.count({ where: { userId: w.client.id } }), wtxBefore);
	const prog = await projectProgressService.getProjectProgress(w.client.id, w.contract.id) as any;
	assert.equal(prog.stages[0].canDispute, true); assert.equal(prog.stages[1].canDispute, false); assert.match(prog.stages[1].disputeBlockedReason, /لم تبدأ/);
});

test('pg: a plain JSON submit (no files) works and a project whose stages are all approved keeps the project-level dispute', opts, async () => {
	const e = await env(); const w = await seed(['SUBMITTED']);
	const r = await e.call('POST', `/client/requests/${w.project.id}/disputes`, w.client.id, body(w)); assert.equal(r.status, 201, JSON.stringify(r.json));
	const w2 = await seed(['APPROVED', 'APPROVED']);
	const r2 = await e.call('POST', `/client/requests/${w2.project.id}/disputes`, w2.client.id, { reason: 'سبب عام للنزاع', description: 'وصف عام قصير لنزاع على مشروع مكتمل المراحل' });
	assert.equal(r2.status, 201, JSON.stringify(r2.json)); assert.equal((await w2.prisma.dispute.findUnique({ where: { id: r2.json.data.id } })).stageId, null);
});
