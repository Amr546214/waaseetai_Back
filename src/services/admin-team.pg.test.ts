import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env, opts, mkRole, mkStaff, closeEnv } from '../testing/admin-team.pgenv';


test('PG: only a SUPER_ADMIN creates / edits roles and grants permissions - no owner record involved; staff and an ADMIN without a role are refused with a fixed code and nothing is written', opts, async () => {
	const e = await env();
	const { user: staff } = await mkStaff(e, ['team.view', 'tasks.manage', 'users.view', 'users.suspend', 'users.delete', 'settings.manage', 'audit.view', 'withdrawals.approve']); // the broadest staff role one could build
	const bare = await e.mkUser('ADMIN', 'bare'); // the type ADMIN grants nothing
	const before = await e.prisma.adminRole.count();
	for (const who of [staff.id, bare.id]) {
		const r = await e.call('POST', '/admin/team/roles', who, { name: `ترقية ${randomUUID().slice(0, 6)}`, permissions: ['users.delete'] });
		assert.equal(r.status, 403, who); assert.ok(['ADMIN_SUPER_ADMIN_REQUIRED', 'ADMIN_PERMISSION_DENIED'].includes(r.json.code), r.json.code);
	}
	for (const [m, url, body] of [['POST', '/admin/team/invites', { email: 'x@pg.test', fullName: 'اسم ثلاثي', roleId: randomUUID() }], ['POST', '/admin/team/staff/attach', { userId: bare.id, roleId: null }], ['PUT', `/admin/team/staff/${staff.id}/access`, { overrides: [], expectedVersion: 1 }], ['POST', `/admin/team/staff/${staff.id}/suspend`, undefined], ['PATCH', `/admin/team/staff/${staff.id}/role`, { roleId: null, expectedVersion: 1 }]] as const) {
		const r = await e.call(m, url, staff.id, body as any); assert.equal(r.status, 403, `${m} ${url}`); assert.equal(r.json.code, 'ADMIN_SUPER_ADMIN_REQUIRED');
	}
	assert.equal((await e.call('POST', '/admin/team/roles', null, { name: 'x', permissions: [] })).status, 401);
	assert.equal(await e.prisma.adminRole.count(), before);
	const ok = await e.call('POST', '/admin/team/roles', e.sa.id, { name: `دور جديد ${randomUUID().slice(0, 6)}`, permissions: ['users.view'] });
	assert.equal(ok.status, 201); assert.equal(ok.json.data.permissions[0], 'users.view');
	// a SUPER_ADMIN works with no staff row and no other table: its type, read from the server, is the authority
	assert.equal(await e.prisma.adminStaff.count({ where: { userId: e.sa.id } }), 0);
	const reg = await e.call('GET', '/admin/team/permissions', e.sa.id); assert.equal(reg.status, 200); assert.ok(reg.json.data.superAdminCount >= 1); assert.equal(reg.json.data.permissions.length, 32);
	const me = await e.call('GET', '/admin/team/access/me', e.sa.id); assert.equal(me.json.data.state, 'SUPER_ADMIN'); assert.equal(me.json.data.permissions.length, 32);
});

test('PG: no mass assignment and no escalation - privileged fields are refused, and nobody (staff or SUPER_ADMIN) can create a SUPER_ADMIN or promote an account type through these routes', opts, async () => {
	const e = await env(); const { user: s } = await mkStaff(e, ['team.view', 'users.view', 'users.suspend', 'users.delete']);
	for (const bad of [{ name: 'a1', permissions: [], createdById: s.id }, { name: 'a2', permissions: [], isSuperAdmin: true }, { name: 'a3', permissions: [], version: 9 }, { name: 'a4', permissions: [], accountType: 'SUPER_ADMIN' }]) {
		const r = await e.call('POST', '/admin/team/roles', e.sa.id, bad); assert.equal(r.status, 400, JSON.stringify(bad));
	}
	const role = await mkRole(e, ['users.view']);
	assert.equal((await e.call('PATCH', `/admin/team/staff/${s.id}/role`, e.sa.id, { roleId: role.id, expectedVersion: 1, status: 'ACTIVE', userId: s.id, accountType: 'SUPER_ADMIN' })).status, 400);
	assert.equal((await e.call('PUT', `/admin/team/staff/${s.id}/access`, e.sa.id, { overrides: [], expectedVersion: 1, accountType: 'SUPER_ADMIN' })).status, 400);
	// staff cannot reach the roles endpoint at all; a SUPER_ADMIN cannot use it to hand out admin roles / types either
	assert.equal((await e.call('PATCH', `/admin/users/${s.id}/roles`, s.id, { roles: ['SUPER_ADMIN'] })).status, 403);
	const client = await e.mkUser('CLIENT_INDIVIDUAL', 'esc');
	for (const roles of [['SUPER_ADMIN'], ['ADMIN'], ['CLIENT', 'SUPER_ADMIN']]) assert.ok([400, 403].includes((await e.call('PATCH', `/admin/users/${client.id}/roles`, e.sa.id, { roles })).status), JSON.stringify(roles));
	assert.ok([400, 403].includes((await e.call('PATCH', `/admin/users/${s.id}/roles`, e.sa.id, { roles: ['SUPER_ADMIN'] })).status));
	assert.equal((await e.prisma.user.findUniqueOrThrow({ where: { id: s.id } })).accountType, 'ADMIN');
	// an invitation always creates an ADMIN account, and cannot carry an account type, a role list or permissions
	for (const extra of [{ accountType: 'SUPER_ADMIN' }, { roles: ['SUPER_ADMIN'] }, { permissions: ['users.delete'] }]) assert.equal((await e.call('POST', '/admin/team/invites', e.sa.id, { email: `esc-${randomUUID().slice(0, 6)}@pg.test`, fullName: 'مدعو اختبار', roleId: role.id, ...extra })).status, 400, JSON.stringify(extra));
	// no route lets a member change their OWN type / role: the users list refuses admin-type accounts, the team routes are SUPER_ADMIN-only
	for (const [m, url, body] of [['PATCH', `/admin/users/${s.id}/status`, { status: 'SUSPENDED', reason: 'اختبار' }], ['DELETE', `/admin/users/${s.id}`, {}]] as const) assert.equal((await e.call(m, url, s.id, body as any)).status, 403, url);
	assert.equal((await e.prisma.user.findUniqueOrThrow({ where: { id: s.id } })).accountType, 'ADMIN');
});

test('PG: a refused caller never reaches a handler: an ADMIN account with no role gets 403 on withdrawals, disputes, users and the dashboard; the account-state route tells it why', opts, async () => {
	const e = await env(); const admin = await e.mkUser('ADMIN', 'bare');
	for (const who of [admin.id]) {
		for (const [m, url] of [['GET', '/admin/withdrawals'], ['POST', '/admin/withdrawals/x/approve'], ['POST', '/admin/withdrawals/x/send-payout'], ['POST', '/admin/disputes/x/resolve-financial'], ['DELETE', '/admin/users/x'], ['GET', '/admin/users'], ['GET', '/admin/dashboard/summary'], ['GET', '/admin/team/staff'], ['GET', '/admin/team/tasks']] as const) {
			const r = await e.call(m, url, who, {}); assert.equal(r.status, 403, `${m} ${url}`); assert.equal(r.json.code, 'ADMIN_PERMISSION_DENIED');
		}
		const me = await e.call('GET', '/admin/team/access/me', who); assert.equal(me.status, 200); assert.equal(me.json.data.state, 'NOT_IN_TEAM'); assert.deepEqual(me.json.data.permissions, []);
	}
});

test('PG: read, approve, reject and payout are separate permissions; finance.read opens no withdrawal action; a read-only role writes nothing', opts, async () => {
	const e = await env();
	const wdBefore = await e.prisma.withdrawal.count();
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
	assert.equal(await e.prisma.withdrawal.count(), wdBefore); // nothing real was executed
});

test('PG: withdrawing a permission, editing a role or suspending a member applies to the NEXT request (an old session / tab changes nothing)', opts, async () => {
	const e = await env(); const { user, role } = await mkStaff(e, ['users.view', 'users.suspend'], 'rev');
	assert.notEqual((await e.call('GET', '/admin/users', user.id)).status, 403);
	const cur = await e.prisma.adminRole.findUniqueOrThrow({ where: { id: role.id } });
	const upd = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { permissions: ['users.suspend'], expectedVersion: cur.version });
	assert.equal(upd.status, 200, JSON.stringify(upd.json));
	assert.equal((await e.call('GET', '/admin/users', user.id)).status, 403, 'users.view withdrawn: the very next call is refused');
	await e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { permissions: ['users.view'], expectedVersion: cur.version + 1 });
	assert.notEqual((await e.call('GET', '/admin/users', user.id)).status, 403);
	assert.equal((await e.call('POST', `/admin/team/staff/${user.id}/suspend`, e.sa.id)).status, 200);
	const sus = await e.call('GET', '/admin/users', user.id); assert.equal(sus.status, 403);
	assert.equal((await e.call('GET', '/admin/team/access/me', user.id)).json.data.state, 'SUSPENDED');
	assert.equal((await e.call('POST', `/admin/team/staff/${user.id}/reactivate`, e.sa.id)).status, 200);
	assert.notEqual((await e.call('GET', '/admin/users', user.id)).status, 403);
	// the audit trail says who changed what, with no secrets
	const audit = await e.prisma.adminAccessAudit.findMany({ where: { roleId: role.id, action: 'ROLE_UPDATED' } });
	assert.ok(audit.length >= 2); assert.equal(audit[0].actorId, e.sa.id);
	assert.ok(await e.prisma.adminAccessAudit.findFirst({ where: { subjectUserId: user.id, action: 'STAFF_SUSPENDED' } }));
});

test('PG: concurrent role edits - the second writer with a stale version gets a clear conflict and the newer change is NOT replaced; sensitive grants need an explicit confirmation; a failed write leaves nothing', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['users.view']);
	const a = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { permissions: ['users.view', 'reports.view'], expectedVersion: 1 });
	assert.equal(a.status, 200);
	const b = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { permissions: ['users.view', 'support.review'], expectedVersion: 1 });
	assert.equal(b.status, 409); assert.equal(b.json.code, 'ROLE_VERSION_CONFLICT');
	assert.deepEqual((await e.prisma.adminRole.findUniqueOrThrow({ where: { id: role.id } })).permissions.sort(), ['reports.view', 'users.view']);
	const sens = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { permissions: ['users.view', 'users.delete'], expectedVersion: 2 });
	assert.equal(sens.status, 409); assert.equal(sens.json.code, 'SENSITIVE_CONFIRMATION_REQUIRED');
	const prev = await e.call('POST', `/admin/team/roles/${role.id}/preview`, e.sa.id, { permissions: ['users.view', 'users.delete'] });
	assert.deepEqual(prev.json.data.addedSensitive, ['users.delete']); assert.deepEqual(prev.json.data.removed, ['reports.view']);
	// a failing audit write rolls the role change back (no partial save)
	const realTx = (e.prisma as any).$transaction.bind(e.prisma);
	(e.prisma as any).$transaction = (fn: any, o?: any) => realTx((tx: any) => fn(new Proxy(tx, { get: (t, k) => (k === 'adminAccessAudit' ? { create: async () => { throw new Error('simulated failure'); } } : t[k]) })), o);
	const r = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { permissions: ['users.view'], expectedVersion: 2 });
	(e.prisma as any).$transaction = realTx;
	assert.ok(r.status >= 500, `status ${r.status}`);
	const after = await e.prisma.adminRole.findUniqueOrThrow({ where: { id: role.id } }); assert.equal(after.version, 2); assert.deepEqual(after.permissions.sort(), ['reports.view', 'users.view']);
	// two truly parallel writers: exactly one wins
	const res = await Promise.all([1, 2].map(i => e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { description: `d${i}`, expectedVersion: 2 })));
	assert.deepEqual(res.map(x => x.status).sort(), [200, 409]);
});

test('PG: SUPER_ADMIN accounts are not staff - the team routes refuse to place, re-role, narrow or suspend one, and the users list refuses to change one', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['users.view']); const other = await e.mkUser('SUPER_ADMIN', 'other-sa'); const st = await mkStaff(e, ['users.view', 'users.suspend', 'users.delete', 'team.view']);
	for (const [m, url, body] of [['POST', `/admin/team/staff/${other.id}/suspend`, undefined], ['PATCH', `/admin/team/staff/${other.id}/role`, { roleId: role.id, expectedVersion: 1 }], ['POST', '/admin/team/staff/attach', { userId: other.id, roleId: role.id }], ['PUT', `/admin/team/staff/${other.id}/access`, { overrides: [], expectedVersion: 1 }]] as const) {
		const r = await e.call(m, url, e.sa.id, body as any); assert.ok([400, 403].includes(r.status), `${m} ${url} -> ${r.status}`);
	}
	assert.equal(await e.prisma.adminStaff.count({ where: { userId: other.id } }), 0);
	for (const [m, url, body] of [['PATCH', `/admin/users/${other.id}/status`, { status: 'SUSPENDED', reason: 'اختبار' }], ['DELETE', `/admin/users/${other.id}`, {}], ['PATCH', `/admin/users/${other.id}/roles`, { roles: ['CLIENT'] }]] as const) {
		assert.equal((await e.call(m, url, st.user.id, body as any)).status, 403, `staff ${m} ${url}`);
		assert.equal((await e.call(m, url, e.sa.id, body as any)).status, 403, `even a SUPER_ADMIN does not change a super-admin account from the users list: ${m} ${url}`);
	}
	assert.equal((await e.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).status, 'ACTIVE');
	assert.equal((await e.call('GET', '/admin/team/access/me', other.id)).json.data.state, 'SUPER_ADMIN'); // still fully able to work
});

test('PG: existing ADMIN accounts enter the team only when a SUPER_ADMIN places them (SUPER_ADMIN accounts are never listed as unplaced); nobody is in the team or has a role by default', opts, async () => {
	const e = await env(); const legacy = await e.mkUser('ADMIN', 'legacy'); const legacySa = await e.mkUser('SUPER_ADMIN', 'legacy-sa'); const role = await mkRole(e, ['team.view']);
	const list = await e.call('GET', '/admin/team/staff/unplaced', e.sa.id);
	const ids = list.json.data.map((x: any) => x.userId); assert.ok(ids.includes(legacy.id)); assert.ok(!ids.includes(legacySa.id));
	assert.equal(await e.prisma.adminStaff.count({ where: { userId: { in: [legacy.id, legacySa.id] } } }), 0);
	assert.equal((await e.call('GET', '/admin/team/staff', legacy.id)).status, 403); // an ADMIN account nobody placed holds nothing
	assert.equal((await e.call('GET', '/admin/team/staff', legacySa.id)).status, 200); // a SUPER_ADMIN account works at once, with no role
	const a = await e.call('POST', '/admin/team/staff/attach', e.sa.id, { userId: legacy.id, roleId: role.id }); assert.equal(a.status, 201);
	assert.equal((await e.call('GET', '/admin/team/staff', legacy.id)).status, 200);
	assert.equal((await e.call('POST', '/admin/team/staff/attach', e.sa.id, { userId: legacy.id, roleId: role.id })).status, 409);
	const client = await e.mkUser('CLIENT_INDIVIDUAL', 'cl'); assert.equal((await e.call('POST', '/admin/team/staff/attach', e.sa.id, { userId: client.id, roleId: role.id })).status, 400);
});

test('PG: invitations - the link alone accepts nothing: a code sent to the INVITED address is required; one-time token, one pending per e-mail, expiry, cancel, resend replaces the token and the code, ONE winner under concurrency', opts, async () => {
	const e = await env(); const role = await mkRole(e, ['team.view']); const email = `inv-${randomUUID().slice(0, 8)}@pg.test`;
	const tokenOf = (link: string) => link.split('#')[1];
	const staff = (await mkStaff(e, ['team.view'])).user;
	assert.equal((await e.call('POST', '/admin/team/invites', staff.id, { email, fullName: 'مدعو اختبار', roleId: role.id })).status, 403);
	const c = await e.call('POST', '/admin/team/invites', e.sa.id, { email, fullName: 'مدعو اختبار', roleId: role.id }); assert.equal(c.status, 201);
	const token = tokenOf(c.json.data.link);
	assert.match(c.json.data.link, /\/admin-invite#[A-Za-z0-9_-]{40,}$/); // fragment: never sent to a server, so never in an access log
	assert.equal(c.json.data.emailed, false); // nothing is e-mailed unless a sender is wired
	assert.equal((await e.call('POST', '/admin/team/invites', e.sa.id, { email: email.toUpperCase(), fullName: 'مكرر', roleId: role.id })).status, 409);
	assert.equal(await e.prisma.user.count({ where: { email } }), 0); // no access before acceptance
	const pv = await e.call('POST', '/admin-invite/preview', null, { token }); assert.equal(pv.status, 200); assert.match(pv.json.data.email, /^in\*\*\*@pg\.test$/);
	assert.equal((await e.call('POST', '/admin-invite/preview', null, { token: 'short' })).status, 400);
	assert.equal((await e.call('GET', `/admin-invite/preview?token=${token}`)).status, 404); // the token is never accepted from a URL
	// the link alone is not enough
	const noCode = await e.call('POST', '/admin-invite/accept', null, { token, password: 'Strong#Pass1' }); assert.equal(noCode.status, 400); assert.equal(noCode.json.code, 'INVITE_CODE_INVALID');
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token, password: 'Strong#Pass1', code: '123456' })).status, 400); // no code was ever issued
	assert.equal(await e.prisma.user.count({ where: { email } }), 0);
	// resend: the OLD link stops working, the new one works; the gap rule applies
	assert.equal((await e.call('POST', `/admin/team/invites/${c.json.data.id}/resend`, e.sa.id)).status, 429);
	await e.prisma.adminInvite.update({ where: { id: c.json.data.id }, data: { lastSentAt: new Date(Date.now() - 120_000) } });
	const rs = await e.call('POST', `/admin/team/invites/${c.json.data.id}/resend`, e.sa.id); assert.equal(rs.status, 200);
	const token2 = tokenOf(rs.json.data.link); assert.notEqual(token2, token);
	assert.equal((await e.call('POST', '/admin-invite/preview', null, { token })).status, 400);
	assert.equal((await e.call('POST', '/admin-invite/request-code', null, { token })).status, 400);       // old link: no code
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token, password: 'Strong#Pass1', code: '000000' })).status, 400);
	// the code goes ONLY to the invited address (a caller cannot name another)
	const rq = await e.call('POST', '/admin-invite/request-code', null, { token: token2, email: 'attacker@evil.test' }); assert.equal(rq.status, 400); // unknown field refused
	const rq2 = await e.call('POST', '/admin-invite/request-code', null, { token: token2 }); assert.equal(rq2.status, 200); assert.equal(rq2.text.includes(e.sentCodes.get(email)), false);
	const code = e.sentCodes.get(email)!; assert.match(code, /^\d{6}$/); assert.equal([...e.sentCodes.keys()].includes('attacker@evil.test'), false);
	assert.equal((await e.call('POST', '/admin-invite/request-code', null, { token: token2 })).status, 429); // 60 s gap
	// weak password refused; a wrong code is refused and counted; the code dies after 5 wrong tries
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'weak', code })).status, 400);
	const wrong = code === '111111' ? '222222' : '111111';
	for (let i = 0; i < 5; i++) assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'Strong#Pass1', code: wrong })).status, 400);
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'Strong#Pass1', code })).status, 400, 'the right code is dead after 5 wrong attempts');
	assert.equal(await e.prisma.user.count({ where: { email } }), 0);
	await e.prisma.adminInvite.update({ where: { id: c.json.data.id }, data: { verifyCodeSentAt: new Date(Date.now() - 120_000) } });
	assert.equal((await e.call('POST', '/admin-invite/request-code', null, { token: token2 })).status, 200); // a new code resets the attempts
	const code2 = e.sentCodes.get(email)!;
	// an expired code is refused
	await e.prisma.adminInvite.update({ where: { id: c.json.data.id }, data: { verifyCodeExpiresAt: new Date(Date.now() - 1000) } });
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'Strong#Pass1', code: code2 })).status, 400);
	await e.prisma.adminInvite.update({ where: { id: c.json.data.id }, data: { verifyCodeSentAt: new Date(Date.now() - 120_000) } });
	assert.equal((await e.call('POST', '/admin-invite/request-code', null, { token: token2 })).status, 200);
	const code3 = e.sentCodes.get(email)!;
	// two concurrent acceptances with the right code: exactly one account
	const res = await Promise.all([1, 2, 3].map(() => e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'Strong#Pass1', code: code3 })));
	assert.equal(res.filter(r => r.status === 200).length, 1, JSON.stringify(res.map(r => r.status)));
	assert.equal(await e.prisma.user.count({ where: { email } }), 1);
	const u = await e.prisma.user.findUniqueOrThrow({ where: { email }, include: { adminStaff: true } });
	assert.equal(u.accountType, 'ADMIN'); assert.equal(u.adminStaff?.roleId, role.id); assert.equal(u.adminStaff?.status, 'ACTIVE');
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: token2, password: 'Strong#Pass1', code: code3 })).status, 400); // used twice
	// cancelled and expired tokens never work (even with a code that had been issued); an existing account's e-mail is refused
	const e2 = `inv2-${randomUUID().slice(0, 8)}@pg.test`; const c2 = await e.call('POST', '/admin/team/invites', e.sa.id, { email: e2, fullName: 'ملغاة', roleId: role.id });
	const t2 = tokenOf(c2.json.data.link); await e.call('POST', '/admin-invite/request-code', null, { token: t2 }); const code4 = e.sentCodes.get(e2)!;
	await e.call('POST', `/admin/team/invites/${c2.json.data.id}/cancel`, e.sa.id);
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: t2, password: 'Strong#Pass1', code: code4 })).status, 400);
	const e3 = `inv3-${randomUUID().slice(0, 8)}@pg.test`; const c3 = await e.call('POST', '/admin/team/invites', e.sa.id, { email: e3, fullName: 'منتهية', roleId: role.id });
	const t3 = tokenOf(c3.json.data.link); await e.call('POST', '/admin-invite/request-code', null, { token: t3 }); const code5 = e.sentCodes.get(e3)!;
	await e.prisma.adminInvite.update({ where: { id: c3.json.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
	assert.equal((await e.call('POST', '/admin-invite/accept', null, { token: t3, password: 'Strong#Pass1', code: code5 })).status, 400);
	assert.equal((await e.call('POST', '/admin/team/invites', e.sa.id, { email: u.email, fullName: 'موجود', roleId: role.id })).status, 409);
	assert.ok(await e.prisma.adminAccessAudit.findFirst({ where: { action: 'INVITE_ACCEPTED', subjectUserId: u.id } }));
	// no token / code / full link in the audit trail
	const audit = JSON.stringify(await e.prisma.adminAccessAudit.findMany({ where: { OR: [{ inviteId: c.json.data.id }, { inviteId: c2.json.data.id }] } }));
	assert.equal(audit.includes(token2), false); assert.equal(audit.includes(code3), false); assert.equal(audit.includes('admin-invite#'), false);
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

after(closeEnv);
