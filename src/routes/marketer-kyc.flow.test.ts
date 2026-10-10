import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// #51 end to end: real Express, real authenticate / requireActiveUser / authorize, real multer + service; only the database, the session store,
// Cloudinary and the notification / audit side effects are replaced.
process.env.JWT_SECRET = 'marketer-kyc-secret';
process.env.OPENAI_API_KEY = 'x';
process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'fake-secret-for-signing-only';

const M1 = '11111111-1111-4111-8111-111111111111', M2 = '22222222-2222-4222-8222-222222222222', ADMIN = '99999999-9999-4999-8999-999999999999', CLIENT = '33333333-3333-4333-8333-333333333333', ADMIN_MARKETER = '88888888-8888-4888-8888-888888888888';
const users: Record<string, any> = {
	[M1]: { id: M1, email: 'm1@x.com', accountType: 'MARKETING_BROKER', status: 'ACTIVE', activeRole: 'AFFILIATE', roles: ['AFFILIATE'], firstName: 'م', lastName: 'واحد' },
	[M2]: { id: M2, email: 'm2@x.com', accountType: 'MARKETING_BROKER', status: 'ACTIVE', activeRole: 'AFFILIATE', roles: ['AFFILIATE'], firstName: 'م', lastName: 'اثنان' },
	[ADMIN]: { id: ADMIN, email: 'a@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	[CLIENT]: { id: CLIENT, email: 'c@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	[ADMIN_MARKETER]: { id: ADMIN_MARKETER, email: 'am@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN', 'AFFILIATE'] },
};
type Aff = { id: string; userId: string; identityVerified: boolean; kycDocumentUrl: string | null; referralSlug: string; updatedAt: Date };
const aff: Record<string, Aff> = {};
const resetAff = () => { for (const k of Object.keys(aff)) delete aff[k]; for (const [id, userId] of [['a1', M1], ['a2', M2], ['a3', ADMIN_MARKETER]]) aff[id] = { id, userId, identityVerified: false, kycDocumentUrl: null, referralSlug: `s-${id}`, updatedAt: new Date() }; audit.length = 0; notes.length = 0; };
const audit: any[] = [], notes: any[] = [];
const byUser = (userId: string) => Object.values(aff).find(a => a.userId === userId) ?? null;
const match = (a: Aff, w: any) => (w.id === undefined || w.id === a.id) && (w.userId === undefined || w.userId === a.userId) && (w.identityVerified === undefined || w.identityVerified === a.identityVerified)
	&& (w.kycDocumentUrl === undefined || (w.kycDocumentUrl && typeof w.kycDocumentUrl === 'object' && 'not' in w.kycDocumentUrl ? a.kycDocumentUrl !== w.kycDocumentUrl.not : a.kycDocumentUrl === w.kycDocumentUrl));
const prisma: any = {
	user: { findUnique: async ({ where }: any) => users[where.id] ?? null },
	affiliateProfile: {
		findUnique: async ({ where }: any) => { const a = where.id ? aff[where.id] : byUser(where.userId); return a ? { ...a, user: users[a.userId] } : null; },
		findMany: async ({ where }: any) => Object.values(aff).filter(a => match(a, where)).map(a => ({ ...a, user: users[a.userId] })),
		count: async ({ where }: any) => Object.values(aff).filter(a => match(a, where)).length,
		updateMany: async ({ where, data }: any) => { const hits = Object.values(aff).filter(a => match(a, where)); hits.forEach(a => Object.assign(a, data, { updatedAt: new Date() })); return { count: hits.length }; }
	}
};

let serverPromise: Promise<{ url: string; close: () => void }> | undefined;
function server() {
	serverPromise ??= (async () => {
		const real = await import('../utils/cloudinary-storage');
		mock.module('../utils/cloudinary-storage', { namedExports: { ...real, uploadMulterFile: async (file: any, folder: string, _m: any, priv: boolean) => ({ url: 'x', fileName: file.originalname, privateRef: priv ? `private:image:png:${folder}/identity-1` : undefined }) } });
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }) } } });
		mock.module('../services/account-logs.service', { namedExports: { accountAuditLogService: { record: async (e: any) => { audit.push(e); } } } });
		mock.module('../services/notification.service', { namedExports: { notificationService: { createAndEmit: async (n: any) => { notes.push(n); } } } });
		const express = (await import('express')).default;
		const { scrubPrivateRefs } = await import('../middlewares/scrub-private-refs.middleware');
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express();
		app.use(express.json());
		app.use(scrubPrivateRefs);
		app.use('/marketer/profile', (await import('./marketer-profile.routes')).default);
		app.use('/admin/brokers', (await import('./admin-brokers.routes')).default);
		app.use('/kyc-documents', (await import('./kyc-documents.routes')).default);
		app.use(globalErrorHandler);
		const srv = http.createServer(app);
		await new Promise<void>(r => srv.listen(0, r));
		return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
	})();
	return serverPromise;
}
async function call(as: string | null, method: string, path: string, opts: { json?: any; form?: FormData } = {}) {
	const { url } = await server();
	const headers: Record<string, string> = {};
	if (as) headers.authorization = `Bearer ${jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
	if (opts.json) headers['content-type'] = 'application/json';
	const res = await fetch(`${url}${path}`, { method, headers, body: opts.form ?? (opts.json ? JSON.stringify(opts.json) : undefined) });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}
const file = (type = 'image/png', size = 8, extra: Record<string, string> = {}) => { const f = new FormData(); f.append('file', new Blob(['x'.repeat(size)], { type }), 'id.png'); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; };
const upload = (as: string | null, form: FormData = file()) => call(as, 'POST', '/marketer/profile/kyc-document', { form });

test('a marketer uploads the document: stored private, status PENDING, identityVerified stays false, no reference in the response', async () => {
	resetAff();
	const r = await upload(M1);
	assert.equal(r.status, 201);
	assert.equal(r.body.data.status, 'PENDING');
	assert.doesNotMatch(JSON.stringify(r.body), /private:/);
	assert.match(aff.a1.kycDocumentUrl!, /^private:/);
	assert.equal(aff.a1.identityVerified, false);
	assert.equal((await call(M1, 'GET', '/marketer/profile/kyc-status')).body.data.status, 'PENDING');
});

test('who can upload: unauthenticated 401, a non-marketer 403; bad type 415; too large 413; no file 400', async () => {
	resetAff();
	assert.equal((await upload(null)).status, 401);
	assert.equal((await upload(CLIENT)).status, 403);
	assert.equal((await upload(M1, file('image/svg+xml'))).status, 415);
	assert.equal((await upload(M1, file('image/png', 6 * 1024 * 1024))).status, 413);
	assert.equal((await call(M1, 'POST', '/marketer/profile/kyc-document', { form: new FormData() })).status, 400);
	assert.equal(aff.a1.kycDocumentUrl, null);
});

test('the marketer cannot approve themselves: a body field "identityVerified" is ignored and every admin route is 403 for a marketer', async () => {
	resetAff();
	await upload(M1, file('image/png', 8, { identityVerified: 'true', kycStatus: 'VERIFIED' }));
	assert.equal(aff.a1.identityVerified, false, 'a form field cannot set identityVerified');
	assert.equal((await call(M1, 'POST', '/admin/brokers/kyc-requests/a1/approve')).status, 403);
	assert.equal((await call(M1, 'POST', '/admin/brokers/kyc-requests/a1/reject', { json: { reason: 'x'.repeat(5) } })).status, 403);
	assert.equal((await call(M1, 'GET', '/admin/brokers/kyc-requests')).status, 403);
	assert.equal(aff.a1.identityVerified, false);
	assert.equal((await call(null, 'POST', '/admin/brokers/kyc-requests/a1/approve')).status, 401);
});

test('an admin sees the pending request (reference scrubbed, access flag set) and approval writes identityVerified only then', async () => {
	resetAff();
	await upload(M1);
	await upload(M2);
	const list = await call(ADMIN, 'GET', '/admin/brokers/kyc-requests');
	assert.equal(list.status, 200);
	assert.deepEqual(list.body.data.items.map((i: any) => i.affiliateId).sort(), ['a1', 'a2']);
	assert.equal(list.body.data.items[0].kycDocumentUrl, null);
	assert.equal(list.body.data.items[0].kycDocumentUrlAccess.private, true);
	assert.doesNotMatch(JSON.stringify(list.body), /private:/);
	assert.equal(aff.a1.identityVerified, false, 'listing never verifies');

	const ok = await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/approve');
	assert.equal(ok.status, 200);
	assert.equal(aff.a1.identityVerified, true);
	assert.equal(aff.a2.identityVerified, false, 'only the decided one');
	assert.ok(audit.some(e => e.eventType === 'MARKETER_KYC_APPROVED' && e.userId === M1 && e.details.reviewerUserId === ADMIN));
	assert.ok(notes.some(n => n.userId === M1));
	assert.equal((await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/approve')).status, 409, 'a decided request cannot be approved twice');
	assert.equal((await call(ADMIN, 'GET', '/admin/brokers/kyc-requests')).body.data.items.length, 1, 'the approved one left the queue');
});

test('an approved marketer cannot replace the document (409) and identityVerified is not reset', async () => {
	resetAff();
	await upload(M1);
	await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/approve');
	const before = aff.a1.kycDocumentUrl;
	assert.equal((await upload(M1)).status, 409);
	assert.equal(aff.a1.identityVerified, true);
	assert.equal(aff.a1.kycDocumentUrl, before);
	assert.equal((await call(M1, 'GET', '/marketer/profile/kyc-status')).body.data.status, 'APPROVED');
});

test('rejection needs a reason, clears the document, never sets identityVerified, notifies with the reason, and the marketer can upload again', async () => {
	resetAff();
	await upload(M1);
	assert.equal((await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/reject', { json: {} })).status, 400);
	assert.equal(aff.a1.kycDocumentUrl !== null, true);
	const r = await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/reject', { json: { reason: '<b>الصورة غير واضحة</b>' } });
	assert.equal(r.status, 200);
	assert.equal(aff.a1.kycDocumentUrl, null);
	assert.equal(aff.a1.identityVerified, false);
	assert.match(notes.find(n => n.userId === M1).message, /الصورة غير واضحة/);
	assert.doesNotMatch(notes.find(n => n.userId === M1).message, /<b>/);
	assert.ok(audit.some(e => e.eventType === 'MARKETER_KYC_REJECTED'));
	// the reason and the time are kept, so the marketer still sees them after a refresh; nothing is approved
	const st = (await call(M1, 'GET', '/marketer/profile/kyc-status')).body.data;
	assert.equal(st.status, 'REJECTED');
	assert.equal(st.rejectionReason, 'الصورة غير واضحة');
	assert.ok(st.reviewedAt);
	assert.equal(aff.a1.identityVerified, false);
	assert.equal((await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/approve')).status, 404, 'nothing pending to approve');
	// a new document starts a new review: the rejection is cleared and the status is PENDING again
	assert.equal((await upload(M1)).status, 201);
	const after = (await call(M1, 'GET', '/marketer/profile/kyc-status')).body.data;
	assert.deepEqual([after.status, after.rejectionReason, after.reviewedAt], ['PENDING', null, null]);
	assert.equal((aff.a1 as any).kycRejectionReason, null);
});

test('a never-uploaded marketer is NONE (no rejection), and approval clears any old reason and stamps the review time', async () => {
	resetAff();
	const none = (await call(M1, 'GET', '/marketer/profile/kyc-status')).body.data;
	assert.deepEqual([none.status, none.rejectionReason], ['NONE', null]);
	await upload(M1);
	await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/reject', { json: { reason: 'سبب أول' } });
	await upload(M1);
	assert.equal((await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/approve')).status, 200);
	const ok = (await call(M1, 'GET', '/marketer/profile/kyc-status')).body.data;
	assert.deepEqual([ok.status, ok.rejectionReason], ['APPROVED', null]);
	assert.equal((aff.a1 as any).kycRejectionReason, null);
	assert.ok((aff.a1 as any).kycReviewedAt instanceof Date);
});

test('a database without the review columns keeps working: reject / upload fall back to the old write (the reason still goes to the notification)', async () => {
	resetAff();
	const real = prisma.affiliateProfile.updateMany;
	prisma.affiliateProfile.updateMany = async (a: any) => {
		if ('kycRejectionReason' in (a.data ?? {})) throw Object.assign(new Error('The column `kycRejectionReason` does not exist in the current database.'), { code: 'P2022' });
		return real(a);
	};
	try {
		assert.equal((await upload(M1)).status, 201);
		assert.equal((await call(ADMIN, 'POST', '/admin/brokers/kyc-requests/a1/reject', { json: { reason: 'سبب' } })).status, 200);
		assert.equal(aff.a1.kycDocumentUrl, null);
		assert.match(notes.filter(n => n.userId === M1).pop().message, /سبب/);
	} finally { prisma.affiliateProfile.updateMany = real; }
});

test('an admin who also holds a marketer profile cannot decide on their own document', async () => {
	resetAff();
	await upload(ADMIN_MARKETER).catch(() => null);
	aff.a3.kycDocumentUrl = 'private:image:png:waseetai/marketers/x/identity-1';
	const r = await call(ADMIN_MARKETER, 'POST', '/admin/brokers/kyc-requests/a3/approve');
	assert.equal(r.status, 403);
	assert.equal(aff.a3.identityVerified, false);
});

test('access-link: the owner opens their own marketer document, an admin opens it (audited), another marketer is refused', async () => {
	resetAff();
	await upload(M1);
	const own = await call(M1, 'POST', '/kyc-documents/access-link', { json: { document: 'marketer_kyc_document' } });
	assert.equal(own.status, 200);
	assert.equal(own.body.data.expiresInSeconds, 120);
	audit.length = 0;
	const adm = await call(ADMIN, 'POST', '/kyc-documents/access-link', { json: { document: 'marketer_kyc_document', userId: M1 } });
	assert.equal(adm.status, 200);
	assert.ok(audit.some(e => e.eventType === 'KYC_DOCUMENT_VIEWED_BY_ADMIN'));
	assert.equal((await call(M2, 'POST', '/kyc-documents/access-link', { json: { document: 'marketer_kyc_document', userId: M1 } })).status, 403);
	assert.equal((await call(M2, 'POST', '/kyc-documents/access-link', { json: { document: 'marketer_kyc_document' } })).status, 404, 'M2 has no document of its own');
});

test.after(async () => { (await server()).close(); });
