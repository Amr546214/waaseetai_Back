import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { ownerModels } from '../testing/admin-owner.testutil';

// Item 22: real Express + real authenticate/authorize + real multer + real services; only the DB, sessions, Cloudinary and the audit sink are replaced.
process.env.JWT_SECRET = 'admin-content-secret';
process.env.OPENAI_API_KEY = 'x';

const ADMIN = '99999999-9999-4999-8999-999999999999', CLIENT = '33333333-3333-4333-8333-333333333333';
const users: Record<string, any> = {
	[ADMIN]: { id: ADMIN, email: 'a@x.com', accountType: 'ADMIN', status: 'ACTIVE', activeRole: 'ADMIN', roles: ['ADMIN'] },
	[CLIENT]: { id: CLIENT, email: 'c@x.com', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] }
};
const audit: any[] = [], uploads: any[] = [];
let settings: Array<{ key: string; value: any }> = [];
let assets: any[] = [];
let services: any[] = [];
let tablesMissing = false;
const missing = () => Object.assign(new Error('The table `public.x` does not exist'), { code: 'P2021' });
const guard = <T>(fn: () => T) => async (...a: any[]) => { if (tablesMissing) throw missing(); return (fn as any)(...a); };

const prisma: any = {
	...ownerModels(),
	user: { findUnique: async ({ where }: any) => users[where.id] ?? null },
	platformSetting: {
		findMany: guard(() => settings.map(s => ({ ...s }))), count: guard(() => settings.length),
		upsert: guard(function ({ where, create, update }: any) { const i = settings.findIndex(s => s.key === where.key); if (i >= 0) settings[i].value = update.value; else settings.push({ key: create.key, value: create.value }); return {}; })
	},
	marketingAsset: {
		findMany: guard(() => [...assets]), count: guard(() => assets.length),
		findUnique: guard(function ({ where }: any) { const a = assets.find(x => x.id === where.id); return a ? { ...a } : null; }),
		create: guard(function ({ data }: any) { const a = { id: `00000000-0000-4000-8000-00000000000${assets.length + 1}`, ...data }; assets.push(a); return a; }),
		update: guard(function ({ where, data }: any) { const a = assets.find(x => x.id === where.id); Object.assign(a, data); return { ...a }; })
	},
	serviceCatalog: {
		findMany: async () => services, count: async () => services.length,
		findUnique: async ({ where }: any) => services.find(s => s.id === where.id) ?? null,
		update: async ({ where, data }: any) => { const s = services.find(x => x.id === where.id); Object.assign(s, data); return s; }
	},
	$transaction: async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma))
};
const SVC = '11111111-1111-4111-8111-111111111111';

let serverPromise: Promise<{ url: string }> | undefined;
let httpServer: http.Server | undefined;
after(() => { httpServer?.closeAllConnections?.(); httpServer?.close(); });
function server() {
	serverPromise ??= (async () => {
		const real = await import('../utils/cloudinary-storage');
		mock.module('../utils/cloudinary-storage', { namedExports: { ...real, uploadMulterFile: async (file: any, folder: string) => { uploads.push({ name: file.originalname, folder }); return { url: `https://res.cloudinary.com/t/${file.originalname}`, fileName: file.originalname, mimeType: file.mimetype, bytes: file.size }; } } });
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }) } } });
		mock.module('../services/account-logs.service', { namedExports: { accountAuditLogService: { record: async (e: any) => { audit.push(e); } } } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express();
		app.use(express.json());
		app.use('/admin/settings', (await import('./admin-settings.routes')).default);
		app.use('/public', (await import('./public-settings.routes')).default);
		app.use('/admin/marketing-assets', (await import('./admin-marketing-assets.routes')).default);
		app.use('/admin/marketplace-services', (await import('./admin-marketplace-services.routes')).default);
		app.use(globalErrorHandler);
		const srv = httpServer = http.createServer(app);
		await new Promise<void>(r => srv.listen(0, r));
		return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
	})();
	return serverPromise;
}
async function call(as: string | null, method: string, path: string, opts: { json?: any; form?: FormData } = {}) {
	const { url } = await server();
	const headers: Record<string, string> = {};
	if (as) headers.authorization = `Bearer ${jwt.sign({ userId: as, accountType: users[as].accountType }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
	if (opts.json) headers['content-type'] = 'application/json';
	const res = await fetch(`${url}${path}`, { method, headers, body: opts.form ?? (opts.json ? JSON.stringify(opts.json) : undefined) });
	return { status: res.status, body: await res.json().catch(() => ({})) as any };
}
const reset = () => { settings = []; assets = []; audit.length = 0; uploads.length = 0; tablesMissing = false; services = [{ id: SVC, title: 'خدمة', status: 'PENDING_APPROVAL', providerId: 'p1', approvedAt: null }]; };
const assetForm = (f: Record<string, string>, file?: [string, string, number]) => { const form = new FormData(); for (const [k, v] of Object.entries(f)) form.append(k, v); if (file) form.append('file', new Blob(['x'.repeat(file[2])], { type: file[1] }), file[0]); return form; };

test('settings: only admins; defaults, save, read back, audit entry, unknown key / bad email rejected', async () => {
	reset();
	assert.equal((await call(null, 'GET', '/admin/settings')).status, 401);
	assert.equal((await call(CLIENT, 'GET', '/admin/settings')).status, 403);
	assert.equal((await call(ADMIN, 'GET', '/admin/settings')).body.data.platformName, '');
	assert.equal((await call(ADMIN, 'PUT', '/admin/settings', { json: { hacked: 1 } })).status, 400);
	assert.equal((await call(ADMIN, 'PUT', '/admin/settings', { json: { supportEmail: 'nope' } })).status, 400);
	const r = await call(ADMIN, 'PUT', '/admin/settings', { json: { platformName: 'وسيط', maintenanceBannerEnabled: true, maintenanceBannerText: 'صيانة' } });
	assert.equal(r.status, 200);
	assert.equal(r.body.data.platformName, 'وسيط');
	assert.equal((await call(ADMIN, 'GET', '/admin/settings')).body.data.maintenanceBannerText, 'صيانة');
	assert.equal(audit.length, 1);
	assert.equal(audit[0].eventType, 'PLATFORM_SETTINGS_UPDATED');
	assert.equal(audit[0].userId, ADMIN);
	assert.deepEqual(audit[0].after.platformName, 'وسيط');
	await call(ADMIN, 'PUT', '/admin/settings', { json: { platformName: 'وسيط' } });
	assert.equal(audit.length, 1, 'no change = no audit entry');
});

test('public settings: no auth, only public keys (admin-only key never leaks)', async () => {
	reset();
	await call(ADMIN, 'PUT', '/admin/settings', { json: { supportEmail: 's@x.com', adminNotificationEmail: 'secret@x.com' } });
	const r = await call(null, 'GET', '/public/settings');
	assert.equal(r.status, 200);
	assert.equal(r.body.data.supportEmail, 's@x.com');
	assert.equal('adminNotificationEmail' in r.body.data, false);
});

test('missing tables: visible reads answer 200 with defaults / an empty list (storageReady=false); only a save / upload is a clear 503', async () => {
	reset(); tablesMissing = true;
	const st = await call(ADMIN, 'GET', '/admin/settings');
	assert.equal(st.status, 200); assert.equal(st.body.storageReady, false); assert.equal(st.body.data.platformName, '');
	assert.equal((await call(null, 'GET', '/public/settings')).status, 200);
	const as = await call(ADMIN, 'GET', '/admin/marketing-assets');
	assert.equal(as.status, 200); assert.equal(as.body.data.storageReady, false); assert.deepEqual(as.body.data.items, []);
	const put = await call(ADMIN, 'PUT', '/admin/settings', { json: { platformName: 'x' } });
	assert.equal(put.status, 503); assert.match(JSON.stringify(put.body), /غير جاهز/);
	assert.equal((await call(ADMIN, 'POST', '/admin/marketing-assets', { form: assetForm({ title: 'عنوان', kind: 'TEXT', text: 'نص' }) })).status, 503);
});

test('marketing assets: upload stores the file, lists it (incl. inactive), disable is audited, validation holds', async () => {
	reset();
	assert.equal((await call(CLIENT, 'GET', '/admin/marketing-assets')).status, 403);
	const up = await call(ADMIN, 'POST', '/admin/marketing-assets', { form: assetForm({ title: 'شعار', kind: 'IMAGE', audience: 'MARKETER' }, ['logo.png', 'image/png', 10]) });
	assert.equal(up.status, 201);
	assert.equal(up.body.data.fileUrl, 'https://res.cloudinary.com/t/logo.png');
	assert.equal(up.body.data.active, true);
	assert.equal(uploads[0].folder, 'waseetai/marketing-assets');
	assert.equal(audit.at(-1).eventType, 'MARKETING_ASSET_CREATED');
	// kind/file mismatch, missing file, svg, bad link, text without body
	assert.equal((await call(ADMIN, 'POST', '/admin/marketing-assets', { form: assetForm({ title: 'فيديو', kind: 'VIDEO' }, ['a.png', 'image/png', 5]) })).status, 415);
	assert.equal((await call(ADMIN, 'POST', '/admin/marketing-assets', { form: assetForm({ title: 'صورة', kind: 'IMAGE' }) })).status, 400);
	assert.equal((await call(ADMIN, 'POST', '/admin/marketing-assets', { form: assetForm({ title: 'صورة', kind: 'IMAGE' }, ['a.svg', 'image/svg+xml', 5]) })).status, 415);
	assert.equal((await call(ADMIN, 'POST', '/admin/marketing-assets', { form: assetForm({ title: 'رابط', kind: 'LINK', linkUrl: 'javascript:alert(1)' }) })).status, 400);
	assert.equal((await call(ADMIN, 'POST', '/admin/marketing-assets', { form: assetForm({ title: 'نص', kind: 'TEXT' }) })).status, 400);
	const link = await call(ADMIN, 'POST', '/admin/marketing-assets', { form: assetForm({ title: 'رابط', kind: 'LINK', linkUrl: 'https://example.com/x' }) });
	assert.equal(link.status, 201);
	const id = up.body.data.id;
	const off = await call(ADMIN, 'PATCH', `/admin/marketing-assets/${id}`, { json: { active: false } });
	assert.equal(off.status, 200);
	assert.equal(off.body.data.active, false);
	assert.equal(audit.at(-1).eventType, 'MARKETING_ASSET_DISABLED');
	assert.equal((await call(ADMIN, 'GET', '/admin/marketing-assets')).body.data.items.length, 2, 'inactive assets stay in the admin list');
	assert.equal((await call(ADMIN, 'PATCH', '/admin/marketing-assets/00000000-0000-4000-8000-0000000000ff', { json: { active: true } })).status, 404);
	assert.equal((await call(ADMIN, 'PATCH', `/admin/marketing-assets/${id}`, { json: { active: 'maybe' } })).status, 400);
});

test('marketplace service moderation: reject needs a reason, state machine enforced, audited', async () => {
	reset();
	assert.equal((await call(CLIENT, 'PATCH', `/admin/marketplace-services/${SVC}/moderation`, { json: { action: 'APPROVE' } })).status, 403);
	assert.equal((await call(ADMIN, 'PATCH', `/admin/marketplace-services/${SVC}/moderation`, { json: { action: 'REJECT' } })).status, 400);
	assert.equal((await call(ADMIN, 'PATCH', `/admin/marketplace-services/${SVC}/moderation`, { json: { action: 'HIDE' } })).status, 409);
	const ok = await call(ADMIN, 'PATCH', `/admin/marketplace-services/${SVC}/moderation`, { json: { action: 'APPROVE' } });
	assert.equal(ok.status, 200);
	assert.equal(services[0].status, 'PUBLISHED');
	assert.equal(audit.at(-1).eventType, 'MARKETPLACE_SERVICE_APPROVE');
	assert.equal((await call(ADMIN, 'PATCH', `/admin/marketplace-services/${SVC}/moderation`, { json: { action: 'HIDE', reason: 'x' } })).status, 200);
	assert.equal(services[0].status, 'ARCHIVED');
	assert.equal((await call(ADMIN, 'PATCH', `/admin/marketplace-services/${SVC}/moderation`, { json: { action: 'REJECT', reason: 'مخالف' } })).status, 409);
	assert.equal((await call(ADMIN, 'GET', '/admin/marketplace-services')).status, 200);
});
