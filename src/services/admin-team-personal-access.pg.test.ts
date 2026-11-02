import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env, opts, mkRole, mkStaff, closeEnv } from '../testing/admin-team.pgenv';

/**
 * Personal access on top of a role, and the section scope («الأقسام المتاحة»), on real PostgreSQL over HTTP. effective = (role + GRANT) - DENY, narrowed by the scope; only a SUPER_ADMIN writes it;
 * it takes effect on the very next request; colleagues on the same role are untouched; every change is in the audit trail; nothing here can grant a SUPER_ADMIN-only power.
 */
after(closeEnv);
const put = (e: any, userId: string, body: any, who?: string) => e.call('PUT', `/admin/team/staff/${userId}/access`, who ?? e.sa.id, body);
const detail = async (e: any, userId: string) => (await e.call('GET', `/admin/team/staff/${userId}/access`, e.sa.id)).json.data;
const mine = async (e: any, userId: string) => (await e.call('GET', '/admin/team/access/me', userId)).json.data;

test('PG: the role gives the base; a personal GRANT adds one permission, a personal DENY beats the role; reset returns to the role; colleagues on the same role are untouched; the next request already follows', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['users.view', 'support.review']);
	const a = await e.mkUser('ADMIN', 'pa'), b = await e.mkUser('ADMIN', 'pb');
	for (const u of [a, b]) await e.prisma.adminStaff.create({ data: { userId: u.id, roleId: role.id } });
	assert.deepEqual((await mine(e, a.id)).permissions, ['support.review', 'users.view']);
	let d = await detail(e, a.id); assert.deepEqual(d.overrides, []); assert.deepEqual(d.rolePermissions, ['support.review', 'users.view']);
	// GRANT disputes.view + DENY support.review for A only
	const r1 = await put(e, a.id, { overrides: [{ permission: 'disputes.view', effect: 'GRANT' }, { permission: 'support.review', effect: 'DENY' }], expectedVersion: d.version }); assert.equal(r1.status, 200, r1.text);
	assert.deepEqual((await mine(e, a.id)).permissions, ['disputes.view', 'users.view']);
	assert.deepEqual((await mine(e, b.id)).permissions, ['support.review', 'users.view']); // the colleague is unchanged
	assert.equal((await e.call('GET', '/admin/disputes', a.id)).status !== 403, true); assert.equal((await e.call('GET', '/admin/tickets', a.id)).status, 403); // the very next request
	assert.equal((await e.call('GET', '/admin/disputes', b.id)).status, 403); assert.notEqual((await e.call('GET', '/admin/tickets', b.id)).status, 403);
	d = await detail(e, a.id); assert.deepEqual(d.overrides.map((o: any) => `${o.permission}:${o.effect}`), ['disputes.view:GRANT', 'support.review:DENY']); assert.deepEqual(d.effective, ['disputes.view', 'users.view']);
	// editing the ROLE does not undo a personal DENY (the DENY wins), and does not erase the GRANT
	const cur = (await e.call('GET', '/admin/team/roles', e.sa.id)).json.data.find((x: any) => x.id === role.id);
	assert.equal((await e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { permissions: ['users.view', 'support.review', 'reports.view'], expectedVersion: cur.version })).status, 200);
	assert.deepEqual((await mine(e, a.id)).permissions, ['disputes.view', 'reports.view', 'users.view']); assert.ok(!(await mine(e, a.id)).permissions.includes('support.review'));
	// reset to the role
	d = await detail(e, a.id); assert.equal((await put(e, a.id, { overrides: [], scoped: false, departments: [], expectedVersion: d.version })).status, 200);
	assert.deepEqual((await mine(e, a.id)).permissions, ['reports.view', 'support.review', 'users.view']);
	const audit = await e.prisma.adminAccessAudit.findMany({ where: { subjectUserId: a.id, action: { in: ['STAFF_ACCESS_SET', 'STAFF_ACCESS_RESET'] } }, orderBy: { at: 'asc' } });
	assert.deepEqual(audit.map((x: any) => x.action), ['STAFF_ACCESS_SET', 'STAFF_ACCESS_RESET']); assert.equal(audit[0].actorId, e.sa.id);
	assert.ok(JSON.stringify(audit[0].after).includes('disputes.view')); assert.ok(JSON.stringify(audit[1].before).includes('support.review')); // before / after are recorded
});

test('PG: only a SUPER_ADMIN reads or writes personal access; a member cannot widen their own or a colleague\'s; unknown ids and SUPER_ADMIN-only powers cannot be granted; sensitive grants need a confirmation; stale versions conflict; a bad list saves nothing', opts, async () => {
	const e = await env(); const { user: s } = await mkStaff(e, ['team.view', 'tasks.manage', 'users.view']); const { user: t } = await mkStaff(e, ['users.view']);
	const body = { overrides: [{ permission: 'users.delete', effect: 'GRANT' }], expectedVersion: 1, confirmSensitive: true };
	for (const who of [s.id, t.id, (await e.mkUser('ADMIN', 'nobody')).id]) {
		assert.equal((await e.call('PUT', `/admin/team/staff/${s.id}/access`, who, body)).status, 403, 'a member cannot widen their own access');
		assert.equal((await e.call('PUT', `/admin/team/staff/${t.id}/access`, who, body)).status, 403, 'nor a colleague\'s');
		assert.equal((await e.call('GET', `/admin/team/staff/${t.id}/access`, who)).status, 403);
	}
	assert.deepEqual((await mine(e, s.id)).permissions, ['tasks.manage', 'team.view', 'users.view']);
	const d = await detail(e, t.id);
	for (const bad of ['bogus.perm', 'staff.invite', 'roles.manage', 'permissions.grant', 'super_admin.create', '*', '']) assert.equal((await put(e, t.id, { overrides: [{ permission: bad, effect: 'GRANT' }], expectedVersion: d.version, confirmSensitive: true })).status, 400, bad);
	assert.equal((await put(e, t.id, { overrides: [{ permission: 'users.view', effect: 'MAYBE' }], expectedVersion: d.version })).status, 400);
	assert.equal((await put(e, t.id, { overrides: [{ permission: 'users.view', effect: 'DENY' }, { permission: 'users.view', effect: 'GRANT' }], expectedVersion: d.version })).status, 400); // duplicate: nothing partial saved
	assert.equal((await put(e, t.id, { overrides: [], expectedVersion: d.version, role: 'x' })).status, 400); // unknown field
	assert.equal((await detail(e, t.id)).version, d.version); assert.equal(await e.prisma.adminStaffOverride.count({ where: { staff: { userId: t.id } } }), 0);
	// sensitive grants: explicit confirmation
	const need = await put(e, t.id, { overrides: [{ permission: 'withdrawals.approve', effect: 'GRANT' }], expectedVersion: d.version }); assert.equal(need.status, 409); assert.equal(need.json.code, 'SENSITIVE_CONFIRMATION_REQUIRED');
	assert.equal((await put(e, t.id, { overrides: [{ permission: 'withdrawals.approve', effect: 'GRANT' }], expectedVersion: d.version, confirmSensitive: true })).status, 200);
	// a stale version is a clear conflict and the newer state stays
	const stale = await put(e, t.id, { overrides: [], expectedVersion: d.version }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'STAFF_VERSION_CONFLICT');
	assert.ok((await mine(e, t.id)).permissions.includes('withdrawals.approve'));
	// DENY never needs a confirmation; the personal grant of a money permission still does not make anyone a SUPER_ADMIN
	assert.equal((await e.call('PATCH', `/admin/team/roles/${randomUUID()}`, t.id, { permissions: [] })).status, 403);
	assert.equal((await e.call('POST', '/admin/team/invites', t.id, { email: 'z@pg.test', fullName: 'اسم ثلاثي', roleId: randomUUID() })).status, 403);
	assert.equal((await e.prisma.user.findUniqueOrThrow({ where: { id: t.id } })).accountType, 'ADMIN');
});

test('PG: section scope is a real DATA scope - it narrows (never grants), is independent of the action permission, keeps non-section permissions, and a role change resets personal changes and scope (recorded)', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['users.view', 'users.suspend', 'disputes.view', 'finance.read']); const u = await e.mkUser('ADMIN', 'sc'); await e.prisma.adminStaff.create({ data: { userId: u.id, roleId: role.id } });
	let d = await detail(e, u.id);
	// scope = users only: the dispute section disappears, the users section stays with ITS action permissions, finance (no section) is untouched
	assert.equal((await put(e, u.id, { overrides: [], scoped: true, departments: ['users'], expectedVersion: d.version })).status, 200);
	assert.deepEqual((await mine(e, u.id)).permissions, ['finance.read', 'users.suspend', 'users.view']);
	assert.equal((await e.call('GET', '/admin/disputes', u.id)).status, 403); assert.notEqual((await e.call('GET', '/admin/users', u.id)).status, 403); assert.notEqual((await e.call('GET', '/admin/finance/overview', u.id)).status, 403);
	assert.deepEqual((await mine(e, u.id)).sections, ['users']);
	// the scope never grants: a section that the role has no permission for stays empty
	d = await detail(e, u.id); assert.equal((await put(e, u.id, { overrides: [], scoped: true, departments: ['users', 'support'], expectedVersion: d.version })).status, 200);
	assert.ok(!(await mine(e, u.id)).permissions.some((p: string) => p.startsWith('support.')));
	// and a personal GRANT outside the listed sections is cut by the scope too (the scope is data scope, the grant is the action)
	d = await detail(e, u.id); assert.equal((await put(e, u.id, { overrides: [{ permission: 'disputes.resolve', effect: 'GRANT' }], scoped: true, departments: ['users'], expectedVersion: d.version, confirmSensitive: true })).status, 200);
	assert.ok(!(await mine(e, u.id)).permissions.includes('disputes.resolve'));
	d = await detail(e, u.id); assert.equal((await put(e, u.id, { overrides: [{ permission: 'disputes.resolve', effect: 'GRANT' }], scoped: true, departments: ['users', 'disputes'], expectedVersion: d.version, confirmSensitive: true })).status, 200);
	assert.ok((await mine(e, u.id)).permissions.includes('disputes.resolve'));
	// invalid scopes
	d = await detail(e, u.id);
	for (const bad of [{ scoped: true, departments: [] }, { scoped: true, departments: ['nope'] }, { scoped: true, departments: 'users' }]) assert.equal((await put(e, u.id, { overrides: [], expectedVersion: d.version, ...bad })).status, 400, JSON.stringify(bad));
	// changing the role starts from the role: personal changes and scope are cleared AND recorded
	const other = await mkRole(e, ['reports.view']);
	assert.equal((await e.call('PATCH', `/admin/team/staff/${u.id}/role`, e.sa.id, { roleId: other.id, expectedVersion: d.version })).status, 200);
	assert.deepEqual((await mine(e, u.id)).permissions, ['reports.view']); assert.equal(await e.prisma.adminStaffOverride.count({ where: { staff: { userId: u.id } } }), 0);
	const roleChange = await e.prisma.adminAccessAudit.findFirstOrThrow({ where: { subjectUserId: u.id, action: 'STAFF_ROLE_SET' }, orderBy: { at: 'desc' } });
	assert.ok(JSON.stringify(roleChange.before).includes('disputes.resolve')); assert.ok(JSON.stringify(roleChange.before).includes('"users"'));
});

test('PG: an invitation carries the sections; the accepted account is a scoped ADMIN staff member (never SUPER_ADMIN), unknown sections are refused', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['users.view', 'disputes.view']);
	const mail = (n: string) => `sc-${n}-${randomUUID().slice(0, 6)}@pg.test`;
	assert.equal((await e.call('POST', '/admin/team/invites', e.sa.id, { email: mail('x'), fullName: 'مدعو اختبار', roleId: role.id, departments: ['nope'] })).status, 400);
	const email = mail('ok'); const c = await e.call('POST', '/admin/team/invites', e.sa.id, { email, fullName: 'مدعو اختبار', roleId: role.id, departments: ['disputes'] }); assert.equal(c.status, 201);
	const token = c.json.data.link.split('#')[1];
	assert.equal((await e.call('POST', '/admin-invite/request-code', null, { token })).status, 200);
	const acc = await e.call('POST', '/admin-invite/accept', null, { token, password: 'Strong#Pass1', code: e.sentCodes.get(email) }); assert.equal(acc.status, 200, acc.text);
	const u = await e.prisma.user.findUniqueOrThrow({ where: { email }, include: { adminStaff: true } });
	assert.equal(u.accountType, 'ADMIN'); assert.equal(u.adminStaff?.scoped, true); assert.deepEqual(u.adminStaff?.departments, ['disputes']);
	assert.deepEqual((await mine(e, u.id)).permissions, ['disputes.view']); // the role also had users.view: outside the invited section
});

test('PG: withdrawing access with an old session and an open socket - a personal DENY / suspension applies to the next request, the connection is cut, and nothing outside the grant is readable', opts, async () => {
	const e = await env(); const { setSocketServer } = await import('../utils/socket-registry');
	const st = await mkStaff(e, ['users.view', 'disputes.view'], 'sk'); const cut: string[] = []; const emitted: string[] = [];
	setSocketServer({ of: () => ({ fetchSockets: async () => [{ data: { userId: st.user.id }, emit: (ev: string) => emitted.push(ev), disconnect: () => cut.push(st.user.id) }] }) } as any);
	const d = await detail(e, st.user.id);
	assert.notEqual((await e.call('GET', '/admin/disputes', st.user.id)).status, 403); // the "old tab" is allowed now
	assert.equal((await put(e, st.user.id, { overrides: [{ permission: 'disputes.view', effect: 'DENY' }], expectedVersion: d.version })).status, 200);
	await new Promise(r => setTimeout(r, 30));
	assert.equal((await e.call('GET', '/admin/disputes', st.user.id)).status, 403); assert.ok(cut.length >= 1 && emitted.includes('admin_access_changed'));
	// the same member cannot read dispute data any other way: operations details of a disputed project are closed too
	const w = await (async () => { const c = await e.prisma.user.create({ data: { id: randomUUID(), accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', roles: ['CLIENT'], activeRole: 'CLIENT', firstName: 'c', lastName: 'c', email: `c-${randomUUID().slice(0, 6)}@pg.test`, password: 'x', agreedToTerms: true } }); const p = await e.prisma.project.create({ data: { id: randomUUID(), title: 't', description: 'd', specialty: 'x', deliveryDays: 3, clientId: c.id, status: 'IN_PROGRESS' } }); await e.prisma.dispute.create({ data: { id: randomUUID(), projectId: p.id, openedById: c.id, reason: 'x', description: 'y' } }); return p; })();
	assert.equal((await e.call('GET', `/admin/projects/${w.id}`, st.user.id)).status, 403);
	setSocketServer(null);
});

test('PG: base roles - ensureBaseRoles adds the five design roles once, never duplicates, never overwrites an edited role, places nobody; an invitation to each saves that roleId and the section scope', opts, async () => {
	const e = await env(); const { ADMIN_ROLE_TEMPLATES } = await import('../config/admin-permissions'); const { adminRolesService } = await import('./admin-roles.service');
	const names = ADMIN_ROLE_TEMPLATES.map(t => t.name);
	// the shared test database may already hold some of them (other tests): remove only the unreferenced ones, then make 'مدير فريق' an EDITED role that must survive untouched
	for (const n of names.filter(n => n !== 'مدير فريق')) await e.prisma.adminRole.deleteMany({ where: { name: n, staff: { none: {} }, invites: { none: {} } } });
	const edited = await e.prisma.adminRole.upsert({ where: { nameKey: 'مدير فريق' }, update: { description: 'معدّل', color: '#112233', permissions: ['users.view'] }, create: { name: 'مدير فريق', nameKey: 'مدير فريق', description: 'معدّل', color: '#112233', permissions: ['users.view'], createdById: e.sa.id } });
	const editedVersion = edited.version;
	const staffBefore = await e.prisma.adminStaff.count();
	const r1 = await adminRolesService.ensureBaseRoles(e.sa.id);
	assert.ok(r1.existing.includes('مدير فريق')); assert.equal(r1.created.length + r1.existing.length, 5);
	const r2 = await adminRolesService.ensureBaseRoles(e.sa.id); assert.equal(r2.created.length, 0);
	for (const n of names) assert.equal(await e.prisma.adminRole.count({ where: { name: n } }), 1, n);
	const still = await e.prisma.adminRole.findUniqueOrThrow({ where: { id: edited.id } }); assert.deepEqual(still.permissions, ['users.view']); assert.equal(still.color, '#112233'); assert.equal(still.version, editedVersion);
	assert.equal(await e.prisma.adminStaff.count(), staffBefore);
	for (const t of ADMIN_ROLE_TEMPLATES.filter(t => r1.created.includes(t.name))) assert.deepEqual((await e.prisma.adminRole.findFirstOrThrow({ where: { name: t.name } })).permissions, [...t.permissions].sort(), t.name);
	// the roles API lists them all (what the invitation dialog shows) and none is a SUPER_ADMIN role
	const list = await e.call('GET', '/admin/team/roles', e.sa.id); assert.equal(list.status, 200);
	for (const n of names) assert.ok(list.json.data.some((r: any) => r.name === n), n);
	assert.ok(!list.json.data.some((r: any) => /super/i.test(r.name)));
	// invitation per role: the saved roleId is the chosen one, and a section scope is kept
	for (const n of names) {
		const role = await e.prisma.adminRole.findFirstOrThrow({ where: { name: n } }); const email = `base-${randomUUID().slice(0, 8)}@pg.test`;
		const c = await e.call('POST', '/admin/team/invites', e.sa.id, { email, fullName: 'مدعو اختبار', roleId: role.id, departments: ['users'] }); assert.equal(c.status, 201, n);
		const inv = await e.prisma.adminInvite.findUniqueOrThrow({ where: { id: c.json.data.id } }); assert.equal(inv.roleId, role.id); assert.deepEqual(inv.departments, ['users']);
	}
	assert.equal(await e.prisma.adminStaff.count(), staffBefore);
});
