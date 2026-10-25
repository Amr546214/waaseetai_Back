import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * REAL PostgreSQL (isolated local :55432, database qa_team) + the REAL admin-team router, services and permission guard over HTTP. Only `authenticate` is replaced: it reads the user id from
 * a header and loads that user from the database (the session / JWT layer has its own tests). Nothing here touches money: the finance / dispute routes are only asked WHETHER they let a
 * caller in (a refusal is 403; a pass ends in the real handler failing on a missing id, which is "not 403").
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432, database qa_team) to run' };
process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x'; process.env.FRONTEND_URL ??= 'https://front.test';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';

let setup: Promise<any> | null = null;
async function env() {
	if (setup) return setup;
	setup = (async () => {
		const { prisma } = await import('../config/db');
		mock.module('../middlewares/auth.middleware', {
			namedExports: {
				authenticate: async (req: any, res: any, next: any) => {
					const id = req.headers['x-test-user'];
					const u = id ? await prisma.user.findUnique({ where: { id: String(id) } }) : null;
					if (!u) return res.status(401).json({ success: false, message: 'غير مصرح' });
					req.user = { id: u.id, userId: u.id, email: u.email, accountType: u.accountType, status: u.status, activeRole: u.activeRole, roles: u.roles, sessionId: 's' };
					next();
				},
				requireActiveUser: (req: any, res: any, next: any) => (req.user?.status === 'ACTIVE' ? next() : res.status(403).json({ success: false, message: 'الحساب غير نشط' })),
				authorize: () => (_q: any, _r: any, n: any) => n(), authorizeAdminActing: (_q: any, _r: any, n: any) => n(),
			},
		});
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const team = (await import('../routes/admin-team.routes')).default;
		const pub = (await import('../routes/admin-team.routes')).adminInvitePublicRouter;
		const withdrawals = (await import('../routes/admin-withdrawals.routes')).default;
		const disputes = (await import('../routes/admin-disputes.routes')).default;
		const users = (await import('../routes/admin-users.routes')).default;
		const dashboard = (await import('../routes/admin-dashboard.routes')).default;
		const app = express(); app.use(express.json());
		app.use('/admin/team', team); app.use('/admin-invite', pub); app.use('/admin/withdrawals', withdrawals); app.use('/admin/disputes', disputes); app.use('/admin/users', users); app.use('/admin/dashboard', dashboard);
		app.use(globalErrorHandler as any);
		const server = http.createServer(app);
		await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as AddressInfo).port;
		const call = async (method: string, url: string, who?: string | null, body?: any) => {
			const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json', connection: 'close', ...(who ? { 'x-test-user': who } : {}) }, body: body === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body) });
			const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ }
			return { status: res.status, json, text };
		};
		const mkUser = async (accountType: string = 'ADMIN', tag = 'u') => prisma.user.create({ data: { id: randomUUID(), accountType: accountType as any, status: 'ACTIVE', roles: [accountType === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : accountType === 'ADMIN' ? 'ADMIN' : 'CLIENT'] as any, activeRole: (accountType === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : accountType === 'ADMIN' ? 'ADMIN' : 'CLIENT') as any, firstName: tag, lastName: 'T', email: `${tag}-${randomUUID().slice(0, 8)}@pg.test` } as any });
		// the single owner of this database (a CHECK allows only id = 1)
		await prisma.platformOwner.deleteMany({});
		const owner = await mkUser('ADMIN', 'owner');
		await prisma.platformOwner.create({ data: { userId: owner.id, designatedBy: 'test' } });
		return { prisma, call, mkUser, owner, server };
	})();
	return setup;
}
const mkRole = async (e: any, perms: string[], name?: string) => { const r = await e.call('POST', '/admin/team/roles', e.owner.id, { name: name ?? `دور ${randomUUID().slice(0, 6)}`, permissions: perms }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.data; };
const mkStaff = async (e: any, perms: string[], tag = 'staff') => { const role = await mkRole(e, perms); const u = await e.mkUser('ADMIN', tag); await e.prisma.adminStaff.create({ data: { userId: u.id, roleId: role.id } }); return { user: u, role }; };

test('PG: only the owner creates / edits roles and grants permissions; staff, SUPER_ADMIN accounts and strangers are refused with a fixed code and nothing is written', opts, async () => {
	const e = await env();
	const { user: staff } = await mkStaff(e, ['team.view', 'tasks.manage']);
	const sa = await e.mkUser('SUPER_ADMIN', 'sa'); // a SUPER_ADMIN account is NOT the owner
	const before = await e.prisma.adminRole.count();
	for (const who of [staff.id, sa.id]) {
		const r = await e.call('POST', '/admin/team/roles', who, { name: `ترقية ${randomUUID().slice(0, 6)}`, permissions: ['users.delete'] });
		assert.equal(r.status, 403, who); assert.equal(r.json.code, 'ADMIN_OWNER_REQUIRED'); assert.match(r.json.message, /مالك المنصة/);
	}
	assert.equal((await e.call('POST', '/admin/team/roles', null, { name: 'x', permissions: [] })).status, 401);
	assert.equal(await e.prisma.adminRole.count(), before);
	const ok = await e.call('POST', '/admin/team/roles', e.owner.id, { name: `دور المالك ${randomUUID().slice(0, 6)}`, permissions: ['users.view'] });
	assert.equal(ok.status, 201); assert.equal(ok.json.data.permissions[0], 'users.view');
});

test('PG: no mass assignment - unknown / privileged fields are refused (owner flag, creator, version, status, role id on a create)', opts, async () => {
	const e = await env(); const { user: s } = await mkStaff(e, ['team.view']);
	for (const bad of [{ name: 'a1', permissions: [], createdById: s.id }, { name: 'a2', permissions: [], isOwner: true }, { name: 'a3', permissions: [], version: 9 }]) {
		const r = await e.call('POST', '/admin/team/roles', e.owner.id, bad); assert.equal(r.status, 400, JSON.stringify(bad));
	}
	const role = await mkRole(e, ['users.view']);
	assert.equal((await e.call('PATCH', `/admin/team/staff/${s.id}/role`, e.owner.id, { roleId: role.id, expectedVersion: 1, status: 'ACTIVE', userId: s.id })).status, 400);
	assert.equal((await e.call('PATCH', `/admin/users/${s.id}/roles`, s.id, { roles: ['SUPER_ADMIN'] })).status, 403); // the old roles endpoint is owner-only too
	const sa = await e.mkUser('SUPER_ADMIN', 'sa2');
	assert.equal((await e.call('PATCH', `/admin/users/${s.id}/roles`, sa.id, { roles: ['SUPER_ADMIN'] })).status, 403);
	assert.equal((await e.prisma.platformOwner.count()), 1);
});

test('PG: a refused caller never reaches a handler: an ADMIN / SUPER_ADMIN account with no role gets 403 on withdrawals, disputes, users and the dashboard; the account-state route tells it why', opts, async () => {
	const e = await env(); const admin = await e.mkUser('ADMIN', 'bare'); const sa = await e.mkUser('SUPER_ADMIN', 'bare-sa');
	for (const who of [admin.id, sa.id]) {
		for (const [m, url] of [['GET', '/admin/withdrawals'], ['POST', '/admin/withdrawals/x/approve'], ['POST', '/admin/withdrawals/x/send-payout'], ['POST', '/admin/disputes/x/resolve-financial'], ['DELETE', '/admin/users/x'], ['GET', '/admin/users'], ['GET', '/admin/dashboard/summary'], ['GET', '/admin/team/staff'], ['GET', '/admin/team/tasks']] as const) {
			const r = await e.call(m, url, who, {}); assert.equal(r.status, 403, `${m} ${url}`); assert.equal(r.json.code, 'ADMIN_PERMISSION_DENIED');
		}
		const me = await e.call('GET', '/admin/team/access/me', who); assert.equal(me.status, 200); assert.equal(me.json.data.state, 'NOT_IN_TEAM'); assert.deepEqual(me.json.data.permissions, []);
	}
});

test('PG: read, approve, reject and payout are separate permissions; finance.read opens no withdrawal action; a read-only role writes nothing', opts, async () => {
	const e = await env();
	const reader = (await mkStaff(e, ['withdrawals.review'], 'wr')).user, approver = (await mkStaff(e, ['withdrawals.review', 'withdrawals.approve'], 'wa')).user, finance = (await mkStaff(e, ['finance.read'], 'fr')).user;
	const rejecter = (await mkStaff(e, ['withdrawals.review', 'withdrawals.reject'], 'wj')).user, payer = (await mkStaff(e, ['withdrawals.review', 'payouts.send'], 'wp')).user;
	const status = async (who: string, m: string, url: string) => (await e.call(m, url, who, {})).status;
	assert.notEqual(await status(reader.id, 'GET', '/admin/withdrawals'), 403);                      // reads
	assert.equal(await status(reader.id, 'POST', '/admin/withdrawals/x/approve'), 403);              // ...but cannot approve
	assert.equal(await status(reader.id, 'POST', '/admin/withdrawals/x/reject'), 403);
	assert.equal(await status(reader.id, 'POST', '/admin/withdrawals/x/send-payout'), 403);
	assert.notEqual(await status(approver.id, 'POST', '/admin/withdrawals/x/approve'), 403);          // approver may approve
	assert.equal(await status(approver.id, 'POST', '/admin/withdrawals/x/send-payout'), 403);        // ...not pay out
	assert.equal(await status(approver.id, 'POST', '/admin/withdrawals/x/reject'), 403);
	assert.notEqual(await status(rejecter.id, 'POST', '/admin/withdrawals/x/reject'), 403);
	assert.equal(await status(rejecter.id, 'POST', '/admin/withdrawals/x/approve'), 403);
	assert.notEqual(await status(payer.id, 'POST', '/admin/withdrawals/x/send-payout'), 403);
	assert.equal(await status(finance.id, 'GET', '/admin/withdrawals'), 403);                         // finance.read is not withdrawals.review
	assert.equal(await status(finance.id, 'POST', '/admin/withdrawals/x/approve'), 403);
	// the financial dispute decision needs BOTH ids
	const onlyResolve = (await mkStaff(e, ['disputes.view', 'disputes.resolve'], 'dr')).user, both = (await mkStaff(e, ['disputes.view', 'disputes.resolve', 'payouts.send'], 'db')).user;
	assert.equal(await status(onlyResolve.id, 'POST', '/admin/disputes/x/resolve-financial'), 403);
	assert.notEqual(await status(both.id, 'POST', '/admin/disputes/x/resolve-financial'), 403);
	assert.equal(await e.prisma.withdrawal.count(), 0); // nothing real was executed
});

test('PG: withdrawing a permission, editing a role or suspending a member applies to the NEXT request (an old session / tab changes nothing)', opts, async () => {
	const e = await env(); const { user, role } = await mkStaff(e, ['users.view', 'users.suspend'], 'rev');
	assert.notEqual((await e.call('GET', '/admin/users', user.id)).status, 403);
	const cur = await e.prisma.adminRole.findUniqueOrThrow({ where: { id: role.id } });
	const upd = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.owner.id, { permissions: ['users.suspend'], expectedVersion: cur.version });
	assert.equal(upd.status, 200, JSON.stringify(upd.json));
	assert.equal((await e.call('GET', '/admin/users', user.id)).status, 403, 'users.view withdrawn: the very next call is refused');
	await e.call('PATCH', `/admin/team/roles/${role.id}`, e.owner.id, { permissions: ['users.view'], expectedVersion: cur.version + 1 });
	assert.notEqual((await e.call('GET', '/admin/users', user.id)).status, 403);
	assert.equal((await e.call('POST', `/admin/team/staff/${user.id}/suspend`, e.owner.id)).status, 200);
	const sus = await e.call('GET', '/admin/users', user.id); assert.equal(sus.status, 403);
	assert.equal((await e.call('GET', '/admin/team/access/me', user.id)).json.data.state, 'SUSPENDED');
	assert.equal((await e.call('POST', `/admin/team/staff/${user.id}/reactivate`, e.owner.id)).status, 200);
	assert.notEqual((await e.call('GET', '/admin/users', user.id)).status, 403);
	// the audit trail says who changed what, with no secrets
	const audit = await e.prisma.adminAccessAudit.findMany({ where: { roleId: role.id, action: 'ROLE_UPDATED' } });
	assert.ok(audit.length >= 2); assert.equal(audit[0].actorId, e.owner.id);
	assert.ok(await e.prisma.adminAccessAudit.findFirst({ where: { subjectUserId: user.id, action: 'STAFF_SUSPENDED' } }));
});

test('PG: concurrent role edits - the second writer with a stale version gets a clear conflict and the newer change is NOT replaced; sensitive grants need an explicit confirmation; a failed write leaves nothing', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['users.view']);
	const a = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.owner.id, { permissions: ['users.view', 'reports.view'], expectedVersion: 1 });
	assert.equal(a.status, 200);
	const b = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.owner.id, { permissions: ['users.view', 'support.review'], expectedVersion: 1 });
	assert.equal(b.status, 409); assert.equal(b.json.code, 'ROLE_VERSION_CONFLICT');
	assert.deepEqual((await e.prisma.adminRole.findUniqueOrThrow({ where: { id: role.id } })).permissions.sort(), ['reports.view', 'users.view']);
	const sens = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.owner.id, { permissions: ['users.view', 'users.delete'], expectedVersion: 2 });
	assert.equal(sens.status, 409); assert.equal(sens.json.code, 'SENSITIVE_CONFIRMATION_REQUIRED');
	const prev = await e.call('POST', `/admin/team/roles/${role.id}/preview`, e.owner.id, { permissions: ['users.view', 'users.delete'] });
	assert.deepEqual(prev.json.data.addedSensitive, ['users.delete']); assert.deepEqual(prev.json.data.removed, ['reports.view']);
	// a failing audit write rolls the role change back (no partial save)
	const realTx = (e.prisma as any).$transaction.bind(e.prisma);
	(e.prisma as any).$transaction = (fn: any, o?: any) => realTx((tx: any) => fn(new Proxy(tx, { get: (t, k) => (k === 'adminAccessAudit' ? { create: async () => { throw new Error('simulated failure'); } } : t[k]) })), o);
	const r = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.owner.id, { permissions: ['users.view'], expectedVersion: 2 });
	(e.prisma as any).$transaction = realTx;
	assert.ok(r.status >= 500, `status ${r.status}`);
	const after = await e.prisma.adminRole.findUniqueOrThrow({ where: { id: role.id } }); assert.equal(after.version, 2); assert.deepEqual(after.permissions.sort(), ['reports.view', 'users.view']);
	// two truly parallel writers: exactly one wins
	const res = await Promise.all([1, 2].map(i => e.call('PATCH', `/admin/team/roles/${role.id}`, e.owner.id, { description: `d${i}`, expectedVersion: 2 })));
	assert.deepEqual(res.map(x => x.status).sort(), [200, 409]);
});

test('PG: the owner is protected and unique; nobody changes, suspends or re-roles the owner; a second owner cannot exist', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['users.view']);
	for (const [m, url, body] of [['POST', `/admin/team/staff/${e.owner.id}/suspend`, undefined], ['PATCH', `/admin/team/staff/${e.owner.id}/role`, { roleId: role.id, expectedVersion: 1 }], ['POST', '/admin/team/staff/attach', { userId: e.owner.id, roleId: role.id }]] as const) {
		const r = await e.call(m, url, e.owner.id, body); assert.equal(r.status, 403, url); assert.equal(r.json.code, 'OWNER_PROTECTED');
	}
	const u = await e.mkUser('ADMIN', 'second');
	await assert.rejects(e.prisma.platformOwner.create({ data: { id: 2, userId: u.id, designatedBy: 'x' } }), /platform_owner_single_row|check constraint/i);
	await assert.rejects(e.prisma.platformOwner.create({ data: { userId: u.id, designatedBy: 'x' } })); // id 1 is taken
	const st = await mkStaff(e, ['team.view']);
	assert.equal((await e.call('POST', `/admin/team/staff/${e.owner.id}/suspend`, st.user.id)).status, 403); // a staff member cannot even try
});

test('PG: existing admin accounts enter the team only when the OWNER places them; nobody is in the team or has a role by default', opts, async () => {
	const e = await env(); const legacy = await e.mkUser('ADMIN', 'legacy'); const legacySa = await e.mkUser('SUPER_ADMIN', 'legacy-sa'); const role = await mkRole(e, ['team.view']);
	const list = await e.call('GET', '/admin/team/staff/unplaced', e.owner.id);
	const ids = list.json.data.map((x: any) => x.userId); assert.ok(ids.includes(legacy.id) && ids.includes(legacySa.id));
	assert.equal(await e.prisma.adminStaff.count({ where: { userId: { in: [legacy.id, legacySa.id] } } }), 0);
	assert.equal((await e.call('GET', '/admin/team/staff', legacy.id)).status, 403);
	const a = await e.call('POST', '/admin/team/staff/attach', e.owner.id, { userId: legacy.id, roleId: role.id }); assert.equal(a.status, 201);
	assert.equal((await e.call('GET', '/admin/team/staff', legacy.id)).status, 200);
	assert.equal((await e.call('POST', '/admin/team/staff/attach', e.owner.id, { userId: legacy.id, roleId: role.id })).status, 409);
	const client = await e.mkUser('CLIENT_INDIVIDUAL', 'cl'); assert.equal((await e.call('POST', '/admin/team/staff/attach', e.owner.id, { userId: client.id, roleId: role.id })).status, 400);
});

test('PG: invitations - one-time token, one pending per e-mail, expiry, cancel, resend replaces the token, concurrent acceptance has ONE winner, an existing e-mail is refused', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['team.view']); const email = `inv-${randomUUID().slice(0, 8)}@pg.test`;
	const staff = (await mkStaff(e, ['team.view'])).user;
	assert.equal((await e.call('POST', '/admin/team/invites', staff.id, { email, fullName: 'مدعو اختبار', roleId: role.id })).status, 403);
	const c = await e.call('POST', '/admin/team/invites', e.owner.id, { email, fullName: 'مدعو اختبار', roleId: role.id }); assert.equal(c.status, 201);
	const token = new URL(c.json.data.link, 'https://x.test').pathname.split('/').pop()!;
	assert.equal(c.json.data.emailed, false); // nothing is e-mailed unless a sender is wired
	assert.equal((await e.call('POST', '/admin/team/invites', e.owner.id, { email: email.toUpperCase(), fullName: 'مكرر', roleId: role.id })).status, 409);
	assert.equal(await e.prisma.user.count({ where: { email } }), 0); // no access before acceptance
	const pv = await e.call('GET', `/admin-invite/preview?token=${token}`); assert.equal(pv.status, 200); assert.match(pv.json.data.email, /^in\*\*\*@pg\.test$/);
	assert.equal((await e.call('GET', '/admin-invite/preview?token=short')).status, 400);
	// resend: the OLD link stops working, the new one works; the gap rule applies
	assert.equal((await e.call('POST', `/admin/team/invites/${c.json.data.id}/resend`, e.owner.id)).status, 429);
	await e.prisma.adminInvite.update({ where: { id: c.json.data.id }, data: { lastSentAt: new Date(Date.now() - 120_000) } });
	const rs = await e.call('POST', `/admin/team/invites/${c.json.data.id}/resend`, e.owner.id); assert.equal(rs.status, 200);
	const token2 = new URL(rs.json.data.link, 'https://x.test').pathname.split('/').pop()!; assert.notEqual(token2, token);
	assert.equal((await e.call('GET', `/admin-invite/preview?token=${token}`)).status, 400);
	// weak password refused, then two concurrent acceptances: exactly one account
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'weak' })).status, 400);
	const res = await Promise.all([1, 2, 3].map(() => e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'Strong#Pass1' })));
	assert.equal(res.filter(r => r.status === 200).length, 1, JSON.stringify(res.map(r => r.status)));
	assert.equal(await e.prisma.user.count({ where: { email } }), 1);
	const u = await e.prisma.user.findUniqueOrThrow({ where: { email }, include: { adminStaff: true } });
	assert.equal(u.accountType, 'ADMIN'); assert.equal(u.adminStaff?.roleId, role.id); assert.equal(u.adminStaff?.status, 'ACTIVE');
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'Strong#Pass1' })).status, 400); // used twice
	// cancelled and expired tokens never work; an existing account's e-mail is refused
	const e2 = `inv2-${randomUUID().slice(0, 8)}@pg.test`; const c2 = await e.call('POST', '/admin/team/invites', e.owner.id, { email: e2, fullName: 'ملغاة', roleId: role.id });
	await e.call('POST', `/admin/team/invites/${c2.json.data.id}/cancel`, e.owner.id);
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: new URL(c2.json.data.link, 'https://x.test').pathname.split('/').pop(), password: 'Strong#Pass1' })).status, 400);
	const e3 = `inv3-${randomUUID().slice(0, 8)}@pg.test`; const c3 = await e.call('POST', '/admin/team/invites', e.owner.id, { email: e3, fullName: 'منتهية', roleId: role.id });
	await e.prisma.adminInvite.update({ where: { id: c3.json.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: new URL(c3.json.data.link, 'https://x.test').pathname.split('/').pop(), password: 'Strong#Pass1' })).status, 400);
	assert.equal((await e.call('POST', '/admin/team/invites', e.owner.id, { email: u.email, fullName: 'موجود', roleId: role.id })).status, 409);
	assert.ok(await e.prisma.adminAccessAudit.findFirst({ where: { action: 'INVITE_ACCEPTED', subjectUserId: u.id } }));
});

test('PG: tasks - the assignee must already hold the permission the work needs (assigning grants nothing), linking needs access to the item, own-status updates work, scope is own vs team, stale edits conflict', opts, async () => {
	const e = await env();
	const manager = (await mkStaff(e, ['tasks.manage', 'team.view', 'disputes.view', 'support.review'], 'mgr')).user;
	const worker = (await mkStaff(e, ['support.review'], 'wrk')).user, other = (await mkStaff(e, ['support.review'], 'oth')).user, noPerm = (await mkStaff(e, ['team.view'], 'np')).user;
	assert.equal((await e.call('POST', '/admin/team/tasks', worker.id, { title: 'مهمة', type: 'SUPPORT' })).status, 403); // no tasks.manage
	const bad = await e.call('POST', '/admin/team/tasks', manager.id, { title: 'مهمة دعم', type: 'SUPPORT', assigneeId: noPerm.id }); assert.equal(bad.status, 400);
	const baseline = (await e.call('GET', '/admin/team/access/me', noPerm.id)).json.data.permissions;
	const t = await e.call('POST', '/admin/team/tasks', manager.id, { title: 'مهمة دعم', type: 'SUPPORT', priority: 'HIGH', assigneeId: worker.id, dueAt: new Date(Date.now() + 86400000).toISOString() }); assert.equal(t.status, 201, JSON.stringify(t.json));
	assert.equal((await e.call('GET', '/admin/team/access/me', worker.id)).json.data.permissions.join(), ['support.review'].join()); // nothing was granted
	assert.deepEqual((await e.call('GET', '/admin/team/access/me', noPerm.id)).json.data.permissions, baseline);
	const link = await e.call('POST', '/admin/team/tasks', manager.id, { title: 'ربط', type: 'SUPPORT', linkType: 'TICKET', linkId: 'x', assigneeId: worker.id }); assert.equal(link.status, 201);
	const noLink = await e.call('POST', '/admin/team/tasks', (await mkStaff(e, ['tasks.manage'], 'ml')).user.id, { title: 'ربط بلا صلاحية', type: 'SUPPORT', linkType: 'DISPUTE', linkId: 'd1' }); assert.equal(noLink.status, 403);
	const id = t.json.data.id;
	assert.equal((await e.call('GET', `/admin/team/tasks/${id}`, other.id)).status, 404);               // not mine, not a manager: invisible
	assert.equal((await e.call('GET', `/admin/team/tasks/${id}`, worker.id)).status, 200);
	assert.equal((await e.call('POST', `/admin/team/tasks/${id}/status`, other.id, { status: 'DONE', expectedVersion: 1 })).status, 403);
	const mine = await e.call('POST', `/admin/team/tasks/${id}/status`, worker.id, { status: 'IN_PROGRESS', expectedVersion: 1 }); assert.equal(mine.status, 200);
	assert.equal((await e.call('POST', `/admin/team/tasks/${id}/status`, worker.id, { status: 'CANCELLED', expectedVersion: 2 })).status, 403);
	const stale = await e.call('POST', `/admin/team/tasks/${id}/status`, worker.id, { status: 'DONE', expectedVersion: 1 }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'TASK_VERSION_CONFLICT');
	assert.equal((await e.call('POST', `/admin/team/tasks/${id}/status`, worker.id, { status: 'DONE', expectedVersion: 2 })).status, 200);
	const fresh = await e.prisma.adminTask.findUniqueOrThrow({ where: { id } }); assert.ok(fresh.completedAt); assert.ok(fresh.startedAt);
	const mineList = await e.call('GET', '/admin/team/tasks', worker.id); assert.ok(mineList.json.data.every((x: any) => x.assignee?.id === worker.id));
	const teamList = await e.call('GET', '/admin/team/tasks', manager.id); assert.ok(teamList.json.data.length >= 2);
	assert.equal((await e.call('PATCH', `/admin/team/tasks/${id}`, manager.id, { assigneeId: noPerm.id, expectedVersion: fresh.version })).status, 400); // reassign to someone without the permission
	const ev = await e.prisma.adminTaskEvent.findMany({ where: { taskId: id }, orderBy: { at: 'asc' } }); assert.deepEqual(ev.map(x => x.kind), ['CREATED', 'STATUS', 'STATUS']);
});

test('PG: performance comes only from recorded task events; unavailable measures are null (never 0 or a sample); the export needs both permissions and is the same data', opts, async () => {
	const e = await env();
	const viewer = (await mkStaff(e, ['performance.view'], 'pv')).user, exporter = (await mkStaff(e, ['performance.view', 'performance.export'], 'pe')).user, worker = (await mkStaff(e, ['support.review'], 'pw')).user;
	const now = new Date();
	await e.prisma.adminTask.deleteMany({});
	await e.prisma.adminTask.createMany({ data: [
		{ title: 'في الموعد', type: 'SUPPORT', status: 'DONE', assigneeId: worker.id, createdById: worker.id, createdAt: new Date(now.getTime() - 4 * 3600_000), completedAt: new Date(now.getTime() - 2 * 3600_000), dueAt: new Date(now.getTime() - 1 * 3600_000) },
		{ title: 'متأخرة', type: 'SUPPORT', status: 'DONE', assigneeId: worker.id, createdById: worker.id, createdAt: new Date(now.getTime() - 10 * 3600_000), completedAt: new Date(now.getTime() - 1 * 3600_000), dueAt: new Date(now.getTime() - 5 * 3600_000) },
		{ title: 'بلا موعد', type: 'SUPPORT', status: 'DONE', assigneeId: worker.id, createdById: worker.id, createdAt: new Date(now.getTime() - 2 * 3600_000), completedAt: now },
	] as any });
	assert.equal((await e.call('GET', '/admin/team/performance', worker.id)).status, 403);
	const r = await e.call('GET', '/admin/team/performance?period=year', viewer.id); assert.equal(r.status, 200);
	const row = r.json.data.members.find((m: any) => m.userId === worker.id);
	assert.equal(row.completed, 3); assert.equal(row.onTimeRate, 50); assert.equal(row.onTimeOf, 2); assert.equal(row.avgCompletionHours, 4.3);
	assert.equal(row.slaRate, null); assert.equal(row.userRating, null); assert.equal(row.overallScore, null);
	assert.equal(r.json.data.team.overallScore, null); assert.ok(r.json.data.definitions.decisionsNeeded.length >= 3);
	const emptyMember = r.json.data.members.find((m: any) => m.userId === viewer.id); assert.equal(emptyMember.completed, 0); assert.equal(emptyMember.onTimeRate, null); assert.equal(emptyMember.avgCompletionHours, null);
	assert.equal((await e.call('GET', '/admin/team/performance/export?period=year', viewer.id)).status, 403);
	const csv = await e.call('GET', '/admin/team/performance/export?period=year', exporter.id); assert.equal(csv.status, 200);
	assert.match(csv.text, /مهام مكتملة/); assert.ok(csv.text.includes('3') && csv.text.includes('50'));
	assert.equal((await e.call('GET', '/admin/team/performance?period=week', viewer.id)).status, 400);
});

test('PG: the dashboard is open to team members but carries only what their permissions allow (revenue / withdrawals / disputes removed, not zeroed)', opts, async () => {
	const e = await env(); const basic = (await mkStaff(e, ['users.view'], 'db1')).user, fin = (await mkStaff(e, ['finance.read', 'withdrawals.review'], 'db2')).user;
	const a = await e.call('GET', '/admin/dashboard/summary', basic.id); assert.equal(a.status, 200);
	assert.ok(a.json.data.kpis.users); assert.equal(a.json.data.kpis.revenue, undefined); assert.equal(a.json.data.kpis.withdrawals, undefined); assert.equal(a.json.data.kpis.disputes, undefined);
	assert.ok(a.json.data.queues.every((q: any) => q.key !== 'withdrawals'));
	const b = await e.call('GET', '/admin/dashboard/summary', fin.id); assert.ok(b.json.data.kpis.revenue); assert.ok(b.json.data.kpis.withdrawals); assert.equal(b.json.data.kpis.users, undefined);
	const empty = await mkStaff(e, [], 'db3'); assert.equal((await e.call('GET', '/admin/dashboard/summary', empty.user.id)).status, 403); // a role with no permission opens nothing
});

test('PG: the access audit trail is readable only with audit.view and never contains a secret', opts, async () => {
	const e = await env(); const reader = (await mkStaff(e, ['audit.view'], 'au')).user, nobody = (await mkStaff(e, ['team.view'], 'au2')).user;
	assert.equal((await e.call('GET', '/admin/team/access-audit', nobody.id)).status, 403);
	const r = await e.call('GET', '/admin/team/access-audit?limit=100', reader.id); assert.equal(r.status, 200); assert.ok(r.json.data.length > 0);
	const text = JSON.stringify(r.json.data); assert.ok(!/token|password|hash/i.test(text), 'no token / password / hash in the trail');
	assert.ok(r.json.data.some((x: any) => x.action === 'INVITE_CREATED' || x.action === 'ROLE_CREATED'));
});

after(async () => { const e = await setup; if (e) { e.server.closeAllConnections?.(); await new Promise(r => e.server.close(r)); await e.prisma.$disconnect(); } });
