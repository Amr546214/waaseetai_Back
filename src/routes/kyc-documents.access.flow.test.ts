import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// POST /api/kyc-documents/access-link end to end: real Express, real authenticate/requireActiveUser, real service, real Cloudinary URL signer
// (pure computation, fake credentials); only the database, the session store and the audit log are replaced.
process.env.JWT_SECRET = 'kyc-flow-secret';
process.env.OPENAI_API_KEY = 'x';
process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'fake-secret-for-signing-only';

const REF = (folderUser: string) => `private:image:png:waseetai/clients/${folderUser}/identity/front-id-1700000000000`;
const LEGACY = 'https://res.cloudinary.com/testcloud/image/upload/v1/waseetai/clients/11111111-1111-4111-8111-111111111111/identity/old-front.png';

const users: Record<string, any> = {
	'11111111-1111-4111-8111-111111111111': { id: '11111111-1111-4111-8111-111111111111', email: 'o@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	'22222222-2222-4222-8222-222222222222': { id: '22222222-2222-4222-8222-222222222222', email: 'p@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	'99999999-9999-4999-8999-999999999999': { id: '99999999-9999-4999-8999-999999999999', email: 'a@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
};
const db = {
	client: { '11111111-1111-4111-8111-111111111111': { frontIdUrl: REF('11111111-1111-4111-8111-111111111111'), backIdUrl: LEGACY, supportingDocsUrl: null }, '22222222-2222-4222-8222-222222222222': { frontIdUrl: REF('22222222-2222-4222-8222-222222222222'), backIdUrl: null, supportingDocsUrl: null } } as Record<string, any>,
	proof: { 'a1b2c3d4-0000-4000-8000-000000000001': { fileUrl: 'private:image:pdf:waseetai/specialties/spec-1/proofs/proof-1', ownerUserId: '22222222-2222-4222-8222-222222222222' } } as Record<string, any>,
};
const audit: any[] = [];

const prisma: any = {
	user: { findUnique: async ({ where, select }: any) => (select?.idDocumentUrl ? { idDocumentUrl: null } : users[where.id] ?? null) },
	clientProfile: { findUnique: async ({ where }: any) => db.client[where.userId] ?? null },
	providerProfile: { findUnique: async () => null },
	clientOnboarding: { findUnique: async () => null },
	proofAttachment: { findUnique: async ({ where }: any) => { const r = db.proof[where.id]; return r ? { fileUrl: r.fileUrl, workSample: { providerSpecialty: { providerProfile: { userId: r.ownerUserId } } } } : null; } },
	accreditationProofFile: { findUnique: async () => null },
};

let serverPromise: Promise<{ url: string; close: () => void }> | undefined;
function server() {
	serverPromise ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }) } } });
		mock.module('../services/account-logs.service', { namedExports: { accountAuditLogService: { record: async (e: any) => { audit.push(e); } } } });
		const express = (await import('express')).default;
		const router = (await import('./kyc-documents.routes')).default;
		const { scrubPrivateRefs } = await import('../middlewares/scrub-private-refs.middleware');
		const app = express();
		app.use(express.json());
		app.use(scrubPrivateRefs);
		app.use('/api/kyc-documents', router);
		app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
		const srv = http.createServer(app);
		await new Promise<void>(r => srv.listen(0, r));
		return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
	})();
	return serverPromise;
}
async function call(as: string | null, body: any) {
	const { url } = await server();
	const token = as ? jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' }) : null;
	const res = await fetch(`${url}/api/kyc-documents/access-link`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
	return { status: res.status, body: await res.json().catch(() => ({})), cacheControl: res.headers.get('cache-control') };
}
const reset = () => { audit.length = 0; users['11111111-1111-4111-8111-111111111111'].status = 'ACTIVE'; };

test('the owner opens their own private document: short-lived signed link, never the stored reference', async () => {
	reset();
	const r = await call('11111111-1111-4111-8111-111111111111', { document: 'client_front_id' });
	assert.equal(r.status, 200);
	assert.equal(r.body.data.private, true);
	assert.equal(r.body.data.legacy, false);
	assert.equal(r.body.data.expiresInSeconds, 120);
	const u = new URL(r.body.data.url);
	assert.equal(u.hostname, 'api.cloudinary.com');
	assert.equal(u.searchParams.get('type'), 'authenticated');
	const expires = Number(u.searchParams.get('expires_at'));
	assert.ok(Math.abs(expires - (Math.floor(Date.now() / 1000) + 120)) <= 5, 'expires ~2 minutes from now');
	assert.ok(!JSON.stringify(r.body).includes('private:'), 'no raw private reference in the response');
	assert.equal(r.cacheControl, 'no-store');
	assert.equal(audit.length, 0, 'the owner opening their own document is not an admin access');
});

test('a document uploaded before the change (legacy public URL) still opens for its owner, flagged legacy', async () => {
	reset();
	const r = await call('11111111-1111-4111-8111-111111111111', { document: 'client_back_id' });
	assert.equal(r.status, 200);
	assert.equal(r.body.data.legacy, true);
	assert.equal(r.body.data.private, false);
	assert.equal(r.body.data.url, LEGACY);
});

test('the owner cannot request someone else’s document: a non-admin may not pass userId at all (403)', async () => {
	reset();
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'client_front_id', userId: '22222222-2222-4222-8222-222222222222' })).status, 403);
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'client_front_id', userId: '11111111-1111-4111-8111-111111111111' })).status, 403, 'not even their own id: the parameter is admin-only');
});

test('a document addressed by id belongs to its owner only (403 for another user, 404 when it does not exist)', async () => {
	reset();
	const id = 'a1b2c3d4-0000-4000-8000-000000000001';
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'specialty_proof', id })).status, 403);
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'specialty_proof', id: 'a1b2c3d4-0000-4000-8000-0000000000ff' })).status, 404);
	assert.equal((await call('22222222-2222-4222-8222-222222222222', { document: 'specialty_proof', id })).status, 200, 'the actual owner can');
});

test('an admin can open any user’s document, and the access is written to the target’s audit log', async () => {
	reset();
	const r = await call('99999999-9999-4999-8999-999999999999', { document: 'client_front_id', userId: '11111111-1111-4111-8111-111111111111' });
	assert.equal(r.status, 200);
	assert.equal(audit.length, 1);
	assert.equal(audit[0].userId, '11111111-1111-4111-8111-111111111111', 'logged on the owner whose document was opened');
	assert.equal(audit[0].eventType, 'KYC_DOCUMENT_VIEWED_BY_ADMIN');
	assert.equal(audit[0].source, 'ADMIN');
	assert.equal(audit[0].details.viewerUserId, '99999999-9999-4999-8999-999999999999');
	assert.equal(audit[0].details.document, 'client_front_id');
	assert.ok(!JSON.stringify(audit[0]).includes('private:'), 'the audit entry does not store the reference');
});

test('an admin must say whose document (userId), except for id-addressed documents', async () => {
	reset();
	assert.equal((await call('99999999-9999-4999-8999-999999999999', { document: 'client_front_id' })).status, 400);
	assert.equal((await call('99999999-9999-4999-8999-999999999999', { document: 'specialty_proof', id: 'a1b2c3d4-0000-4000-8000-000000000001' })).status, 200);
	assert.equal(audit.length, 1);
});

test('a SUSPENDED or not-yet-activated account is refused even with a valid token; no token is 401', async () => {
	reset();
	users['11111111-1111-4111-8111-111111111111'].status = 'SUSPENDED';
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'client_front_id' })).status, 403);
	users['11111111-1111-4111-8111-111111111111'].status = 'PENDING_VERIFICATION';
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'client_front_id' })).status, 403);
	assert.equal((await call(null, { document: 'client_front_id' })).status, 401);
});

test('a missing document is 404; an unknown key or extra field is 400', async () => {
	reset();
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'client_supporting_docs' })).status, 404);
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'not_a_document' })).status, 400);
	assert.equal((await call('11111111-1111-4111-8111-111111111111', { document: 'client_front_id', extra: 1 })).status, 400);
});

test.after(async () => { (await server()).close(); });
