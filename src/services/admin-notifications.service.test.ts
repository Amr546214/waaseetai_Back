import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// One fake database for the whole file (t.mock.module is used once per module). Users are filtered by the SAME where the service sends, so a wrong
// filter (non-admins, suspended admins) shows up as a wrong recipient list.
const users = [
	{ id: 'admin-1', accountType: 'ADMIN', status: 'ACTIVE', isBanned: false, email: 'a1@x.com', activeRole: 'CLIENT', roles: ['CLIENT'] },
	{ id: 'super-1', accountType: 'SUPER_ADMIN', status: 'ACTIVE', isBanned: false, email: 's1@x.com', activeRole: 'CLIENT', roles: ['CLIENT'] },
	{ id: 'admin-susp', accountType: 'ADMIN', status: 'SUSPENDED', isBanned: false, email: 'a2@x.com', activeRole: 'CLIENT', roles: ['CLIENT'] },
	{ id: 'admin-ban', accountType: 'ADMIN', status: 'ACTIVE', isBanned: true, email: 'a3@x.com', activeRole: 'CLIENT', roles: ['CLIENT'] },
	{ id: 'client-1', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', isBanned: false, email: 'c@x.com', activeRole: 'CLIENT', roles: ['CLIENT'] },
	{ id: 'prov-1', accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', isBanned: false, email: 'p@x.com', activeRole: 'PROVIDER', roles: ['PROVIDER'] },
	{ id: 'emp-1', accountType: 'EMPLOYEE', status: 'ACTIVE', isBanned: false, email: 'e@x.com', activeRole: 'CLIENT', roles: ['CLIENT'] }
];
const rows: any[] = [];
let failCreate = false;
const prisma: any = {
	user: {
		findMany: async ({ where }: any) => users.filter(u => where.accountType.in.includes(u.accountType) && u.status === where.status && u.isBanned === where.isBanned).map(u => ({ id: u.id })),
		findUnique: async ({ where }: any) => users.find(u => u.id === where.id) ?? null
	},
	notification: {
		create: async ({ data }: any) => { if (failCreate) throw new Error('db down'); const row = { id: `n${rows.length + 1}`, actionText: null, metadata: null, isRead: false, createdAt: new Date(), ...data }; rows.push(row); return row; },
		findMany: async ({ where }: any) => rows.filter(r => r.userId === where.userId && (where.isRead === undefined || r.isRead === where.isRead) && (!where.type || r.type === where.type)),
		findFirst: async ({ where }: any) => rows.find(r => r.id === where.id && r.userId === where.userId) ?? null,
		update: async ({ where, data }: any) => Object.assign(rows.find(r => r.id === where.id), data),
		updateMany: async ({ where, data }: any) => { rows.filter(r => r.userId === where.userId && r.isRead === where.isRead).forEach(r => Object.assign(r, data)); return { count: 1 }; }
	},
	providerProfile: { findUnique: async () => null },
	notificationPreference: { findUnique: async () => null }
};

const token = (userId: string) => jwt.sign({ userId, accountType: 'ADMIN' }, 'test-secret', { expiresIn: '1h' });
const call = (port: number, method: string, path: string, bearer?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
	const req = http.request({ port, method, path, headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }, res => {
		let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
	});
	req.on('error', reject); req.end();
});

test('admin notifications', async t => {
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async () => ({}) }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
	t.mock.module('../socket', { namedExports: { getIO: () => null } });
	t.mock.module('../config/db', { namedExports: { prisma } });
	t.mock.module('./session.service', { namedExports: { sessionService: { validateOrRegister: async (id: string) => ({ id: `s-${id}` }) } } });
	const { notifyAdmins } = await import('./admin-notifications.service');

	const REAL_ADMIN_ROUTES = [
		/^\/supper-admin-overview\/disputes\/[^/]+$/, /^\/supper-admin-overview\/support\/[^/]+$/, /^\/supper-admin-overview\/withdrawals\/[^/]+$/,
		/^\/supper-admin-overview\/kyc$/, /^\/supper-admin-overview\/risk-center$/
	];
	const cases: Array<[any, any, RegExp]> = [
		['NEW_DISPUTE', { id: 'd1', ref: 'مشروع' }, /^\/supper-admin-overview\/disputes\/d1$/],
		['NEW_TICKET', { id: 't1', ref: 'TKT-1' }, /^\/supper-admin-overview\/support\/t1$/],
		['WITHDRAWAL_REQUESTED', { id: 'w1', ref: '50 $' }, /^\/supper-admin-overview\/withdrawals\/w1$/],
		['KYC_SUBMITTED', { ref: 'مزود خدمة' }, /^\/supper-admin-overview\/kyc$/],
		['SUSPICIOUS_PAYMENT', { ref: 'PayPal X' }, /^\/supper-admin-overview\/risk-center$/],
		['PAYOUT_FAILED', { id: 'w2' }, /^\/supper-admin-overview\/withdrawals\/w2$/]
	];
	for (const [event, payload, url] of cases) {
		await t.test(`${event}: only active admins / super-admins get one row, with a real admin actionUrl`, async () => {
			rows.length = 0;
			await notifyAdmins(event, payload);
			assert.deepEqual(rows.map(r => r.userId).sort(), ['admin-1', 'super-1']);
			for (const r of rows) {
				assert.match(r.actionUrl, url);
				assert.ok(REAL_ADMIN_ROUTES.some(x => x.test(r.actionUrl)));
				assert.equal(r.type, `ADMIN_${event}`);
				assert.ok(r.title && r.message && r.isRead === false);
			}
			for (const nonAdmin of ['client-1', 'prov-1', 'emp-1', 'admin-susp', 'admin-ban']) assert.ok(!rows.some(r => r.userId === nonAdmin));
		});
	}

	await t.test('a failure inside notifyAdmins never reaches the caller (create fails, lookup fails)', async () => {
		failCreate = true;
		await assert.doesNotReject(notifyAdmins('NEW_DISPUTE', { id: 'd1' }));
		failCreate = false;
		const original = prisma.user.findMany;
		prisma.user.findMany = async () => { throw new Error('db down'); };
		await assert.doesNotReject(notifyAdmins('NEW_TICKET', { id: 't1' }));
		prisma.user.findMany = original;
		await assert.doesNotReject(notifyAdmins('NOPE' as any, {}));
	});

	// Real router + real authenticate / requireActiveUser over HTTP.
	const express = (await import('express')).default;
	const notificationsRouter = (await import('../routes/notifications.routes')).default;
	const app = express();
	app.use('/notifications', notificationsRouter);
	app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message }));
	const server = http.createServer(app);
	await new Promise<void>(r => server.listen(0, r));
	const port = (server.address() as any).port;
	t.after(() => server.close());

	await t.test('routes: no token is 401', async () => {
		assert.equal((await call(port, 'GET', '/notifications')).status, 401);
		assert.equal((await call(port, 'PATCH', '/notifications/n1/read')).status, 401);
	});

	await t.test('routes: an admin lists, filters unread, marks one read and marks all read', async () => {
		rows.length = 0;
		await notifyAdmins('NEW_DISPUTE', { id: 'd1' });
		await notifyAdmins('NEW_TICKET', { id: 't1' });
		const list = await call(port, 'GET', '/notifications', token('admin-1'));
		assert.equal(list.status, 200);
		assert.equal(list.body.data.length, 2);
		const mine = list.body.data[0];
		const read = await call(port, 'PATCH', `/notifications/${mine.id}/read`, token('admin-1'));
		assert.equal(read.status, 200);
		assert.equal(read.body.data.isRead, true);
		const unread = await call(port, 'GET', '/notifications?unreadOnly=true', token('admin-1'));
		assert.equal(unread.body.data.length, 1);
		const byType = await call(port, 'GET', '/notifications?type=ADMIN_NEW_TICKET', token('super-1'));
		assert.deepEqual(byType.body.data.map((n: any) => n.type), ['ADMIN_NEW_TICKET']);
		assert.equal((await call(port, 'PATCH', '/notifications/read-all', token('admin-1'))).status, 200);
		assert.equal((await call(port, 'GET', '/notifications?unreadOnly=true', token('admin-1'))).body.data.length, 0);
	});

	await t.test('routes: marking another user\'s notification is 404 and leaves it unread', async () => {
		rows.length = 0;
		await notifyAdmins('NEW_DISPUTE', { id: 'd1' });
		const superRow = rows.find(r => r.userId === 'super-1');
		const res = await call(port, 'PATCH', `/notifications/${superRow.id}/read`, token('admin-1'));
		assert.equal(res.status, 404);
		assert.equal(superRow.isRead, false);
	});
});
