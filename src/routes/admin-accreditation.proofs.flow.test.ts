import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { ownerModels } from '../testing/admin-owner.testutil';

// J1 / D-B1: the admin accreditation detail must hand the reviewer a clean, documented proof contract that covers BOTH storage shapes, and the reviewer
// must really be able to open each proof (short-lived signed link through POST /api/kyc-documents/access-link). Real Express, real authenticate /
// authorize / scrub middleware, real services; only the database, the session store, the audit log and the storage probe are replaced.
process.env.JWT_SECRET = 'j1-proofs-secret';
process.env.OPENAI_API_KEY = 'x';
process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'fake-secret-for-signing-only';

const ADMIN = '99999999-9999-4999-8999-999999999999';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SAMPLE = 'aaaaaaaa-0000-4000-8000-000000000001';
const UP_OK = 'bbbbbbbb-0000-4000-8000-000000000001';
const UP_GONE = 'bbbbbbbb-0000-4000-8000-000000000002';
const UP_FAILED = 'bbbbbbbb-0000-4000-8000-000000000003';
const REF_OK = `private:image:png:waseetai/accreditation/${OWNER}/proofs/ok-1`;
const REF_GONE = `private:raw:pdf:waseetai/accreditation/${OWNER}/proofs/gone-2`;
const REF_LEGACY = `private:image:jpg:waseetai/specialties/spec-1/proofs/old-3`;
const PUBLIC_URL = 'https://res.cloudinary.com/testcloud/image/upload/v1/waseetai/old/%D9%85%D9%84%D9%81%20%D9%82%D8%AF%D9%8A%D9%85.png?x=1';

const users: Record<string, any> = {
	[ADMIN]: { id: ADMIN, email: 'a@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	[OWNER]: { id: OWNER, email: 'o@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['PROVIDER'] },
	[OTHER]: { id: OTHER, email: 'p@x.com', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', activeRole: 'PROVIDER', roles: ['PROVIDER'] },
};
const state: any = { attachments: [] as any[], uploads: [] as any[] };
const audit: any[] = [];
const sampleRow = () => ({
	id: SAMPLE, title: 'نموذج', description: 'd', status: 'MANUAL_REVIEW', attachments: state.attachments, createdAt: new Date(), events: [],
	proofUploads: state.uploads.filter((u: any) => u.status === 'COMPLETED'),
	providerProfile: { id: 'pp', userId: OWNER, user: { id: OWNER, firstName: 'a', lastName: 'b', email: 'o@x.com' } },
	providerSpecialty: { id: 'ps', status: 'UNDER_AI_REVIEW', specialty: { id: 's', nameAr: 'x' } },
});
const prisma: any = {
	...ownerModels(),
	user: { findUnique: async ({ where }: any) => users[where.id] ?? null },
	accreditationSample: { findUnique: async ({ where, select }: any) => (where.id === SAMPLE ? (select ? { attachments: state.attachments, providerProfile: { userId: OWNER } } : sampleRow()) : null) },
	accreditationProofUpload: { findUnique: async ({ where }: any) => state.uploads.find((u: any) => u.id === where.id) ?? null },
	assessmentAttempt: { findFirst: async () => null },
};

let serverPromise: Promise<{ url: string; close: () => void }> | undefined;
const server = () => (serverPromise ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }) } } });
	mock.module('../services/account-logs.service', { namedExports: { accountAuditLogService: { record: async (e: any) => { audit.push(e); } } } });
	const proof = await import('../services/accreditation-proof.service');
	proof.proofStorage.exists = async ref => ref !== REF_GONE; // the stat check: REF_GONE is missing from the storage
	const express = (await import('express')).default;
	const adminRouter = (await import('./admin-accreditation.routes')).default;
	const kycRouter = (await import('./kyc-documents.routes')).default;
	const { scrubPrivateRefs } = await import('../middlewares/scrub-private-refs.middleware');
	const app = express();
	app.use(express.json());
	app.use(scrubPrivateRefs);
	app.use('/api/admin/accreditation', adminRouter);
	app.use('/api/kyc-documents', kycRouter);
	app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
	const srv = http.createServer(app);
	await new Promise<void>(r => srv.listen(0, r));
	return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
})());
const tokenOf = (as: string) => jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' });
async function call(as: string | null, method: string, path: string, body?: any) {
	const { url } = await server();
	const res = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${tokenOf(as)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}
const up = (id: string, ref: string, status = 'COMPLETED', fileName = 'p.png') => ({ id, userId: OWNER, privateRef: ref, fileName, mimeType: 'image/png', bytes: 1234, status, createdAt: new Date('2026-10-17T10:00:00Z') });
const reset = () => { audit.length = 0; state.uploads = [up(UP_OK, REF_OK, 'COMPLETED', 'design.png'), up(UP_GONE, REF_GONE, 'COMPLETED', 'spec.pdf'), up(UP_FAILED, 'pending', 'FAILED')]; state.attachments = [REF_OK, REF_GONE]; };

test('CAUSE of attachments:[null]: the scrub middleware replaces every private reference in an array with null', async () => {
	const { __scrubForTest } = await import('../middlewares/scrub-private-refs.middleware');
	assert.deepEqual((__scrubForTest({ attachments: [REF_OK] }) as any).attachments, [null]);
});

test('detail: proofs list covers uploads and every legacy shape, no null entries, no private reference anywhere', async () => {
	reset();
	state.attachments = [REF_OK, REF_GONE, REF_LEGACY, PUBLIC_URL, 'data:image/jpeg;base64,AAAA', 'bare-name.pdf', '', null];
	const r = await call(ADMIN, 'GET', `/api/admin/accreditation/samples/${SAMPLE}`);
	assert.equal(r.status, 200);
	const d = r.body.data;
	const text = JSON.stringify(r.body);
	assert.ok(!text.includes('private:'), 'no raw private reference');
	assert.ok(!text.includes('privateRef'), 'no privateRef field');
	assert.ok(!text.includes('base64'), 'no inline data in the response');
	assert.ok(Array.isArray(d.attachments) && d.attachments.every((a: unknown) => typeof a === 'string'), 'attachments never holds null');
	assert.deepEqual(d.attachments, [PUBLIC_URL], 'attachments = public http(s) links only');
	assert.equal(d.proofUploads.length, 2, 'only COMPLETED uploads');
	assert.ok(d.proofUploads.every((u: any) => !('privateRef' in u)));
	const by = Object.fromEntries(d.proofs.map((p: any) => [p.key, p]));
	assert.equal(d.proofs.length, 6, 'two uploads + legacy private + legacy url + inline data + bare name; the upload-backed attachments are not duplicated');
	assert.deepEqual(by[`u:${UP_OK}`].access, { document: 'accreditation_upload', id: UP_OK });
	assert.equal(by[`u:${UP_OK}`].source, 'UPLOAD');
	assert.equal(by[`u:${UP_OK}`].fileName, 'design.png');
	assert.equal(by[`u:${UP_OK}`].available, true);
	assert.equal(by[`u:${UP_GONE}`].available, false, 'a file missing from the storage is reported as unavailable, not as no proof');
	assert.equal(by['a:2'].source, 'LEGACY_PRIVATE');
	assert.deepEqual(by['a:2'].access, { document: 'accreditation_sample_attachment', id: SAMPLE, index: 2 });
	assert.equal(by['a:2'].fileName, 'old-3.jpg');
	assert.equal(by['a:3'].source, 'LEGACY_URL');
	assert.equal(by['a:3'].url, PUBLIC_URL);
	assert.equal(by['a:3'].fileName, 'ملف قديم.png');
	assert.equal(by['a:4'].source, 'LEGACY_INLINE');
	assert.equal(by['a:4'].url, null);
	assert.equal(by['a:4'].access, null);
	assert.equal(by['a:5'].fileName, 'bare-name.pdf');
	assert.ok(d.proofs.every((p: any) => p && typeof p.fileName === 'string' && p.fileName));
});

test('detail: a sample with no proofs at all gives empty arrays, never null', async () => {
	reset();
	state.uploads = []; state.attachments = [];
	const d = (await call(ADMIN, 'GET', `/api/admin/accreditation/samples/${SAMPLE}`)).body.data;
	assert.deepEqual(d.proofs, []);
	assert.deepEqual(d.attachments, []);
});

test('detail: a storage probe that throws gives available:null (unknown), not a failure of the whole page', async () => {
	reset();
	const proof = await import('../services/accreditation-proof.service');
	const keep = proof.proofStorage.exists;
	proof.proofStorage.exists = async () => { throw new Error('storage down'); };
	try {
		const r = await call(ADMIN, 'GET', `/api/admin/accreditation/samples/${SAMPLE}`);
		assert.equal(r.status, 200);
		assert.ok(r.body.data.proofs.every((p: any) => p.available === null));
	} finally { proof.proofStorage.exists = keep; }
});

test('authorisation: unauthenticated 401, a provider (owner or not) 403, ADMIN allowed', async () => {
	reset();
	assert.equal((await call(null, 'GET', `/api/admin/accreditation/samples/${SAMPLE}`)).status, 401);
	assert.equal((await call(OWNER, 'GET', `/api/admin/accreditation/samples/${SAMPLE}`)).status, 403);
	assert.equal((await call(OTHER, 'GET', `/api/admin/accreditation/samples/${SAMPLE}`)).status, 403);
	assert.equal((await call(ADMIN, 'GET', `/api/admin/accreditation/samples/${SAMPLE}`)).status, 200);
});

test('open: the admin gets a short-lived signed link for an upload and for a legacy private attachment; it is audited, never a stored reference', async () => {
	reset();
	const a = await call(ADMIN, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_upload', id: UP_OK });
	assert.equal(a.status, 200);
	assert.equal(a.body.data.private, true);
	assert.equal(a.body.data.expiresInSeconds, 120);
	const u = new URL(a.body.data.url);
	assert.equal(u.searchParams.get('type'), 'authenticated');
	assert.ok(!JSON.stringify(a.body).includes('private:'));
	assert.equal(audit.length, 1);
	assert.equal(audit[0].userId, OWNER);
	assert.equal(audit[0].details.document, 'accreditation_upload');
	state.attachments = [REF_OK, REF_GONE, REF_LEGACY];
	const b = await call(ADMIN, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_sample_attachment', id: SAMPLE, index: 2 });
	assert.equal(b.status, 200);
	assert.equal(b.body.data.private, true);
});

test('open: non-admins are refused (403) unless they own the file; a stranger cannot, passing userId is admin-only', async () => {
	reset();
	assert.equal((await call(null, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_upload', id: UP_OK })).status, 401);
	assert.equal((await call(OTHER, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_upload', id: UP_OK })).status, 403);
	assert.equal((await call(OTHER, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_sample_attachment', id: SAMPLE, index: 0 })).status, 403);
	assert.equal((await call(OTHER, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_upload', id: UP_OK, userId: OWNER })).status, 403);
	assert.equal((await call(OWNER, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_upload', id: UP_OK })).status, 200, 'the owner can open their own proof');
});

test('open: a FAILED upload, an unknown id, a missing/foreign index or a non-private value is a 404/400, never a link', async () => {
	reset();
	assert.equal((await call(ADMIN, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_upload', id: UP_FAILED })).status, 404);
	assert.equal((await call(ADMIN, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_upload', id: 'bbbbbbbb-0000-4000-8000-0000000000ff' })).status, 404);
	assert.equal((await call(ADMIN, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_sample_attachment', id: SAMPLE, index: 9 })).status, 404);
	assert.equal((await call(ADMIN, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_sample_attachment', id: SAMPLE })).status, 400);
	state.attachments = ['https://evil.example.com/x.png', 'data:text/html;base64,AAAA'];
	assert.equal((await call(ADMIN, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_sample_attachment', id: SAMPLE, index: 0 })).status, 404, 'no open redirect to a foreign URL');
	assert.equal((await call(ADMIN, 'POST', '/api/kyc-documents/access-link', { document: 'accreditation_sample_attachment', id: SAMPLE, index: 1 })).status, 404);
});

test.after(async () => { (await server()).close(); });
