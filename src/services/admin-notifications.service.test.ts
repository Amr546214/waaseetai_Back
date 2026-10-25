import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// One fake database for the whole file (t.mock.module is used once per module). Recipients are filtered by the SAME where the service sends (live account, ACTIVE staff row, the role
// holding the permission), so a wrong filter (suspended staff, banned, SUPER_ADMIN without a role, a role without the permission) shows up as a wrong recipient list.
const live = (u: any) => u.status === 'ACTIVE' && u.isBanned === false;
const user = (id: string, accountType: string, over: any = {}) => ({ id, accountType, status: 'ACTIVE', isBanned: false, email: `${id}@x.com`, activeRole: 'CLIENT', roles: ['CLIENT'], ...over });
const users = [
	user('super-1', 'SUPER_ADMIN'), user('super-susp', 'SUPER_ADMIN', { status: 'SUSPENDED' }), user('bare-admin', 'ADMIN'),
	user('st-disp', 'ADMIN'), user('st-sup', 'ADMIN'), user('st-wd', 'ADMIN'), user('st-idr', 'ADMIN'), user('st-fin', 'ADMIN'), user('st-pay', 'ADMIN'),
	user('st-disp-susp', 'ADMIN'), user('st-disp-denied', 'ADMIN'), user('st-usr-granted', 'ADMIN'), user('st-disp-scoped-out', 'ADMIN'), user('st-disp-scoped-in', 'ADMIN'), user('st-disp-ban', 'ADMIN', { isBanned: true }), user('st-disp-userSusp', 'ADMIN', { status: 'SUSPENDED' }),
	user('client-1', 'CLIENT_INDIVIDUAL'), user('prov-1', 'PROVIDER_INDIVIDUAL', { activeRole: 'PROVIDER', roles: ['PROVIDER'] }), user('emp-1', 'EMPLOYEE'),
];
const roles: Record<string, string[]> = { usr: ['users.view'], disp: ['disputes.view'], sup: ['support.review'], wd: ['withdrawals.review'], idr: ['identity.review'], fin: ['finance.read'], pay: ['payouts.send'] };
const staff: any[] = [
	{ userId: 'st-disp', status: 'ACTIVE', roleKey: 'disp' }, { userId: 'st-sup', status: 'ACTIVE', roleKey: 'sup' }, { userId: 'st-wd', status: 'ACTIVE', roleKey: 'wd' }, { userId: 'st-idr', status: 'ACTIVE', roleKey: 'idr' },
	{ userId: 'st-fin', status: 'ACTIVE', roleKey: 'fin' }, { userId: 'st-pay', status: 'ACTIVE', roleKey: 'pay' },
	{ userId: 'st-disp-susp', status: 'SUSPENDED', roleKey: 'disp' }, { userId: 'st-disp-ban', status: 'ACTIVE', roleKey: 'disp' }, { userId: 'st-disp-userSusp', status: 'ACTIVE', roleKey: 'disp' },
	// personal changes: a DENY beats the role, a GRANT adds one permission, a section scope narrows
	{ userId: 'st-disp-denied', status: 'ACTIVE', roleKey: 'disp', overrides: [{ permission: 'disputes.view', effect: 'DENY' }] },
	{ userId: 'st-usr-granted', status: 'ACTIVE', roleKey: 'usr', overrides: [{ permission: 'disputes.view', effect: 'GRANT' }] },
	{ userId: 'st-disp-scoped-out', status: 'ACTIVE', roleKey: 'disp', scoped: true, departments: ['users'] },
	{ userId: 'st-disp-scoped-in', status: 'ACTIVE', roleKey: 'disp', scoped: true, departments: ['disputes'] },
];
const byId = (id: string) => users.find(u => u.id === id);
const rows: any[] = [];
let failCreate = false;
const prisma: any = {
	user: { findUnique: async ({ where }: any) => byId(where.id) ?? null, findMany: async ({ where }: any) => users.filter(u => u.accountType === where.accountType && u.status === where.status && u.isBanned === where.isBanned).map(u => ({ id: u.id })) },
	adminStaff: {
		findUnique: async ({ where }: any) => { const s = staff.find(x => x.userId === where.userId); return s ? { id: `sf-${s.userId}`, status: s.status, roleId: s.roleKey, scoped: s.scoped ?? false, departments: s.departments ?? [], overrides: s.overrides ?? [], role: { id: s.roleKey, name: s.roleKey, permissions: roles[s.roleKey] } } : null; },
		findMany: async ({ where }: any) => staff.filter(s => s.status === where.status && live(byId(s.userId)!)).map(s => ({ userId: s.userId, scoped: s.scoped ?? false, departments: s.departments ?? [], overrides: s.overrides ?? [], role: { permissions: roles[s.roleKey] } })),
	},
	notification: {
		create: async ({ data }: any) => { if (failCreate) throw new Error('db down'); const row = { id: `n${rows.length + 1}`, actionText: null, metadata: null, isRead: false, createdAt: new Date(), ...data }; rows.push(row); return row; },
		findMany: async ({ where }: any) => rows.filter(r => r.userId === where.userId && (where.isRead === undefined || r.isRead === where.isRead) && (!where.type || r.type === where.type) && (!where.AND || where.AND.every((c: any) => !c.type?.notIn || !c.type.notIn.includes(r.type)))),
		count: async ({ where }: any) => rows.filter(r => r.userId === where.userId && (where.isRead === undefined || r.isRead === where.isRead) && (!where.type?.notIn || !where.type.notIn.includes(r.type))).length,
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
	const cases: Array<[any, any, RegExp, string]> = [
		['NEW_DISPUTE', { id: 'd1', ref: 'مشروع' }, /^\/supper-admin-overview\/disputes\/d1$/, 'st-disp'],
		['NEW_TICKET', { id: 't1', ref: 'TKT-1' }, /^\/supper-admin-overview\/support\/t1$/, 'st-sup'],
		['WITHDRAWAL_REQUESTED', { id: 'w1', ref: '50 $' }, /^\/supper-admin-overview\/withdrawals\/w1$/, 'st-wd'],
		['KYC_SUBMITTED', { ref: 'مزود خدمة' }, /^\/supper-admin-overview\/kyc$/, 'st-idr'],
		['SUSPICIOUS_PAYMENT', { ref: 'PayPal X' }, /^\/supper-admin-overview\/risk-center$/, 'st-fin'],
		['PAYOUT_FAILED', { id: 'w2' }, /^\/supper-admin-overview\/withdrawals\/w2$/, 'st-pay']
	];
	for (const [event, payload, url, holder] of cases) {
		await t.test(`${event}: only live SUPER_ADMIN accounts and the ACTIVE staff who hold the permission now (role + personal GRANT - DENY, inside their sections) get one row, with a real admin actionUrl`, async () => {
			rows.length = 0;
			await notifyAdmins(event, payload);
			assert.deepEqual(rows.map(r => r.userId).sort(), ['super-1', holder, ...(event === 'NEW_DISPUTE' ? ['st-usr-granted', 'st-disp-scoped-in'] : [])].sort());
			for (const r of rows) {
				assert.match(r.actionUrl, url);
				assert.ok(REAL_ADMIN_ROUTES.some(x => x.test(r.actionUrl)));
				assert.equal(r.type, `ADMIN_${event}`);
				assert.ok(r.title && r.message && r.isRead === false);
			}
			for (const nonAdmin of ['super-susp', 'bare-admin', 'client-1', 'prov-1', 'emp-1', 'st-disp-susp', 'st-disp-ban', 'st-disp-userSusp', 'st-disp-denied', 'st-disp-scoped-out']) assert.ok(!rows.some(r => r.userId === nonAdmin));
		});
	}

	await t.test('a failure inside notifyAdmins never reaches the caller (create fails, lookup fails)', async () => {
		failCreate = true;
		await assert.doesNotReject(notifyAdmins('NEW_DISPUTE', { id: 'd1' }));
		failCreate = false;
		const original = prisma.adminStaff.findMany;
		prisma.adminStaff.findMany = async () => { throw new Error('db down'); };
		await assert.doesNotReject(notifyAdmins('NEW_TICKET', { id: 't1' }));
		prisma.adminStaff.findMany = original;
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

	await t.test('routes: a SUPER_ADMIN lists, filters unread, marks one read and marks all read; a member sees only what their permission covers', async () => {
		rows.length = 0;
		await notifyAdmins('NEW_DISPUTE', { id: 'd1' });
		await notifyAdmins('NEW_TICKET', { id: 't1' });
		const list = await call(port, 'GET', '/notifications', token('super-1'));
		assert.equal(list.status, 200);
		assert.equal(list.body.data.length, 2);
		const mine = list.body.data[0];
		const read = await call(port, 'PATCH', `/notifications/${mine.id}/read`, token('super-1'));
		assert.equal(read.status, 200);
		assert.equal(read.body.data.isRead, true);
		const unread = await call(port, 'GET', '/notifications?unreadOnly=true', token('super-1'));
		assert.equal(unread.body.data.length, 1);
		const byType = await call(port, 'GET', '/notifications?type=ADMIN_NEW_TICKET', token('st-sup'));
		assert.deepEqual(byType.body.data.map((n: any) => n.type), ['ADMIN_NEW_TICKET']);
		assert.deepEqual((await call(port, 'GET', '/notifications', token('st-sup'))).body.data.map((n: any) => n.type), ['ADMIN_NEW_TICKET']); // not the dispute
		assert.equal((await call(port, 'PATCH', '/notifications/read-all', token('super-1'))).status, 200);
		assert.equal((await call(port, 'GET', '/notifications?unreadOnly=true', token('super-1'))).body.data.length, 0);
	});

	await t.test('routes: what was delivered is hidden once the permission is withdrawn (list and unread count), and comes back with it', async () => {
		rows.length = 0;
		await notifyAdmins('NEW_DISPUTE', { id: 'd1' });
		assert.equal((await call(port, 'GET', '/notifications', token('st-disp'))).body.data.length, 1);
		const saved = roles.disp; roles.disp = ['users.view'];
		try {
			const after = await call(port, 'GET', '/notifications', token('st-disp'));
			assert.equal(after.body.data.length, 0); assert.equal(after.body.unreadCount, 0);
		} finally { roles.disp = saved; }
		assert.equal((await call(port, 'GET', '/notifications', token('st-disp'))).body.data.length, 1);
		// an account that cannot be resolved to any access sees none of them (fail closed)
		const savedFind = prisma.adminStaff.findUnique; prisma.adminStaff.findUnique = async () => { throw new Error('db down'); };
		try { assert.equal((await call(port, 'GET', '/notifications', token('st-disp'))).body.data.length, 0); } finally { prisma.adminStaff.findUnique = savedFind; }
	});

	await t.test('routes: marking another user\'s notification is 404 and leaves it unread', async () => {
		rows.length = 0;
		await notifyAdmins('NEW_DISPUTE', { id: 'd1' });
		const holderRow = rows.find(r => r.userId === 'st-disp');
		const res = await call(port, 'PATCH', `/notifications/${holderRow.id}/read`, token('super-1'));
		assert.equal(res.status, 404);
		assert.equal(holderRow.isRead, false);
	});
});
