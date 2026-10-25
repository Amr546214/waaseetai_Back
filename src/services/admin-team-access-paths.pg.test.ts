import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env, opts, mkRole, mkStaff, closeEnv } from '../testing/admin-team.pgenv';

/**
 * The access paths OUTSIDE the permission-guarded /admin routes: operations records, notifications, the assistant socket, open connections, role / invitation contents and presence.
 * Real isolated PostgreSQL (:55432, qa_team); nothing touches money. Protection of super-admin accounts: admin-team.pg.test.ts. Personal access and sections: admin-team-personal-access.pg.test.ts.
 */
const tag = () => randomUUID().slice(0, 8);

async function world(e: any) {
	const { prisma } = e; const t = tag();
	const mk = (type: string, n: string) => prisma.user.create({ data: { id: randomUUID(), accountType: type, status: 'ACTIVE', roles: [type === 'CLIENT_INDIVIDUAL' ? 'CLIENT' : 'PROVIDER'], activeRole: type === 'CLIENT_INDIVIDUAL' ? 'CLIENT' : 'PROVIDER', firstName: n, lastName: t, email: `${n}-${t}@pg.test`, password: 'x', agreedToTerms: true } });
	const client = await mk('CLIENT_INDIVIDUAL', 'client'), provider = await mk('PROVIDER_INDIVIDUAL', 'prov');
	const project = (title: string) => prisma.project.create({ data: { id: randomUUID(), title, description: 'synthetic', specialty: 'x', deliveryDays: 5, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contractOf = (p: any) => prisma.contract.create({ data: { id: randomUUID(), projectId: p.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 4, phasesCount: 1, status: 'ACTIVE', signedAt: new Date() } });
	const offerOf = (p: any) => prisma.projectProposal.create({ data: { id: randomUUID(), projectId: p.id, providerId: provider.id, title: 'عرض', message: 'synthetic', totalPrice: 20, deliveryDays: 4 } });
	const inDispute = await project(`نزاع ${t}`), inTicket = await project(`تذكرة ${t}`), plain = await project(`عادي ${t}`);
	await prisma.dispute.create({ data: { id: randomUUID(), projectId: inDispute.id, openedById: client.id, againstUserId: provider.id, reason: 'x', description: 'synthetic' } });
	await prisma.supportTicket.create({ data: { id: randomUUID(), ticketNumber: `T-${t}`, userId: client.id, subject: 's', category: 'c', description: 'd', relatedProject: inTicket.id } });
	const cases: Record<string, any> = {};
	for (const [k, p] of Object.entries({ inDispute, inTicket, plain })) cases[k] = { project: p, contract: await contractOf(p), offer: await offerOf(p) };
	return cases;
}

after(closeEnv);

test('PG: one permission opens only its own data - with a single permission every endpoint of another permission answers 403 (no leak across permissions)', opts, async () => {
	const e = await env();
	const endpoints: Array<[string, string, string]> = [
		['users.view', 'GET', '/admin/users'], ['withdrawals.review', 'GET', '/admin/withdrawals'], ['disputes.view', 'GET', '/admin/disputes'], ['support.review', 'GET', '/admin/tickets'],
		['finance.read', 'GET', '/admin/finance/overview'], ['finance.read', 'GET', '/admin/finance/transactions.csv'], ['settings.manage', 'GET', '/admin/settings'], ['audit.view', 'GET', '/admin/team/access-audit'],
		['team.view', 'GET', '/admin/team/staff'], ['performance.view', 'GET', '/admin/team/performance'],
	];
	const perms = [...new Set(endpoints.map(x => x[0]))];
	for (const p of perms) {
		const who = (await mkStaff(e, [p], `one-${p.replace('.', '-')}`)).user;
		for (const [need, m, url] of endpoints) {
			const r = await e.call(m, url, who.id);
			if (need === p) assert.notEqual(r.status, 403, `${p} should open ${url}`); else { assert.equal(r.status, 403, `${p} must NOT open ${url} (needs ${need})`); assert.equal(r.json?.code, 'ADMIN_PERMISSION_DENIED'); assert.ok(!/"data"/.test(r.text), 'no data in a refusal'); }
		}
	}
});

test('PG: operations records - the LISTS are SUPER_ADMIN-only; a DETAIL opens only through a held case (dispute / ticket); users.view and finance.read open nothing; unknown ids are the same 403', opts, async () => {
	const e = await env(); const w = await world(e);
	const dispute = (await mkStaff(e, ['disputes.view'], 'od')).user, ticket = (await mkStaff(e, ['support.review'], 'os')).user, users = (await mkStaff(e, ['users.view'], 'ou')).user, fin = (await mkStaff(e, ['finance.read'], 'of')).user;
	const bare = await e.mkUser('ADMIN', 'ob'); const sa = await e.mkUser('SUPER_ADMIN', 'osa');
	for (const list of ['/admin/projects', '/admin/contracts', '/admin/requests', '/admin/offers']) {
		for (const who of [dispute, ticket, users, fin, bare]) assert.equal((await e.call('GET', list, who.id)).status, 403, `${list} for staff`);
		for (const who of [e.sa, sa]) assert.notEqual((await e.call('GET', list, who.id)).status, 403, `${list} for a SUPER_ADMIN`);
	}
	const url = (k: string, kind: 'project' | 'contract' | 'offer') => ({ project: `/admin/projects/${w[k].project.id}`, contract: `/admin/contracts/${w[k].contract.id}`, offer: `/admin/offers/${w[k].offer.id}` }[kind]);
	for (const kind of ['project', 'contract', 'offer'] as const) {
		assert.notEqual((await e.call('GET', url('inDispute', kind), dispute.id)).status, 403, `dispute holder sees the disputed ${kind}`);
		assert.equal((await e.call('GET', url('inTicket', kind), dispute.id)).status, 403);
		assert.equal((await e.call('GET', url('plain', kind), dispute.id)).status, 403);
		assert.notEqual((await e.call('GET', url('inTicket', kind), ticket.id)).status, 403, `ticket holder sees the ticketed ${kind}`);
		assert.equal((await e.call('GET', url('inDispute', kind), ticket.id)).status, 403);
		assert.equal((await e.call('GET', url('plain', kind), ticket.id)).status, 403);
		for (const who of [users, fin, bare]) for (const k of ['inDispute', 'inTicket', 'plain']) assert.equal((await e.call('GET', url(k, kind), who.id)).status, 403, `${kind} ${k}`);
		for (const k of ['inDispute', 'inTicket', 'plain']) assert.notEqual((await e.call('GET', url(k, kind), sa.id)).status, 403, `SUPER_ADMIN sees every ${kind}`);
	}
	const gone = await e.call('GET', `/admin/projects/${randomUUID()}`, dispute.id); const real = await e.call('GET', url('plain', 'project'), dispute.id);
	assert.equal(gone.status, 403); assert.equal(gone.text, real.text); // an unknown id and a forbidden one are indistinguishable
	// the operations records are read-only: there is no write route to open
	for (const m of ['POST', 'PATCH', 'DELETE']) assert.equal((await e.call(m, url('plain', 'project'), e.sa.id, {})).status, 404);
});

test('PG: admin notifications reach only people who hold the permission NOW, and what was delivered is hidden once the permission is withdrawn', opts, async () => {
	const e = await env(); const { notificationService } = await import('../services/notification.service'); const { notifyAdmins } = await import('../services/admin-notifications.service');
	(notificationService as any).createAndEmit = async (i: any) => e.prisma.notification.create({ data: { id: randomUUID(), userId: i.userId, title: i.title, message: i.message, category: i.category, type: i.type, actionUrl: i.actionUrl, metadata: i.metadata } });
	const disp = await mkStaff(e, ['disputes.view'], 'nd'), sup = await mkStaff(e, ['support.review'], 'ns'), none = await e.mkUser('ADMIN', 'nn'), sa = await e.mkUser('SUPER_ADMIN', 'nsa');
	const suspended = await mkStaff(e, ['disputes.view'], 'nsu'); await e.prisma.adminStaff.update({ where: { userId: suspended.user.id }, data: { status: 'SUSPENDED' } });
	await notifyAdmins('NEW_DISPUTE', { id: 'd1', ref: 'نزاع اختبار' });
	const got = async (id: string, type: string) => e.prisma.notification.count({ where: { userId: id, type } });
	assert.equal(await got(e.sa.id, 'ADMIN_NEW_DISPUTE') > 0, true); assert.equal(await got(sa.id, 'ADMIN_NEW_DISPUTE'), 1); // SUPER_ADMIN accounts are always recipients
	assert.equal(await got(disp.user.id, 'ADMIN_NEW_DISPUTE'), 1);
	for (const id of [sup.user.id, none.id, suspended.user.id]) assert.equal(await got(id, 'ADMIN_NEW_DISPUTE'), 0, 'not a recipient');
	await notifyAdmins('NEW_TICKET', { id: 't1', ref: 'T-1' }); await notifyAdmins('WITHDRAWAL_REQUESTED', { id: 'w1', ref: '10 $' });
	assert.equal(await got(sup.user.id, 'ADMIN_NEW_TICKET'), 1); assert.equal(await got(disp.user.id, 'ADMIN_NEW_TICKET'), 0);
	assert.equal(await got(disp.user.id, 'ADMIN_WITHDRAWAL_REQUESTED'), 0); assert.equal(await got(sup.user.id, 'ADMIN_WITHDRAWAL_REQUESTED'), 0);
	// the inbox shows it while the permission is held ...
	assert.equal((await notificationService.getUserNotifications(disp.user.id)).filter((n: any) => n.type === 'ADMIN_NEW_DISPUTE').length, 1);
	assert.equal(await notificationService.countUnread(disp.user.id), 1);
	// ... and hides it as soon as the permission is withdrawn (the row stays for the audit, the viewer no longer gets it)
	await e.prisma.adminRole.update({ where: { id: disp.role.id }, data: { permissions: ['users.view'] } });
	assert.equal((await notificationService.getUserNotifications(disp.user.id)).filter((n: any) => n.type === 'ADMIN_NEW_DISPUTE').length, 0);
	assert.equal(await notificationService.countUnread(disp.user.id), 0);
	// regaining it shows it again (it is a visibility rule, not a deletion)
	await e.prisma.adminRole.update({ where: { id: disp.role.id }, data: { permissions: ['disputes.view'] } });
	assert.equal(await notificationService.countUnread(disp.user.id), 1);
});

test('PG: the assistant socket - an admin is privileged only while it holds access; the check runs on EVERY question, so withdrawal / suspension cuts an already-open connection', opts, async () => {
	const e = await env(); const { resolveHelpAssistantUser } = await import('../sockets/help-assistant-auth');
	const socketFor = (u: any) => { const token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET!, { expiresIn: '1h' }); return { userId: u.id, handshake: { auth: { token }, address: '127.0.0.1', headers: {} } } as any; };
	const superSock = socketFor(e.sa), st = await mkStaff(e, ['users.view'], 'as'), stSock = socketFor(st.user), bare = await e.mkUser('ADMIN', 'ab'), bareSock = socketFor(bare), sa = await e.mkUser('SUPER_ADMIN', 'asa'), saSock = socketFor(sa);
	const ask = (s: any) => resolveHelpAssistantUser(s);
	assert.deepEqual(await ask(superSock), { ok: true, userId: e.sa.id, role: 'admin' });
	assert.equal((await ask(stSock) as any).ok, true);
	assert.deepEqual(await ask(bareSock), { ok: false, reason: 'FORBIDDEN' });   // ADMIN account with no placement
	assert.deepEqual(await ask(saSock), { ok: true, userId: sa.id, role: 'admin' }); // every SUPER_ADMIN account, with no staff row
	// the same open connection (same socket object) after the permission is withdrawn / the member suspended / the role removed
	await e.prisma.adminRole.update({ where: { id: st.role.id }, data: { permissions: [] } });
	assert.deepEqual(await ask(stSock), { ok: false, reason: 'FORBIDDEN' });
	await e.prisma.adminRole.update({ where: { id: st.role.id }, data: { permissions: ['users.view'] } });
	assert.equal((await ask(stSock) as any).ok, true);
	await e.prisma.adminStaff.update({ where: { userId: st.user.id }, data: { status: 'SUSPENDED' } });
	assert.deepEqual(await ask(stSock), { ok: false, reason: 'FORBIDDEN' });
	// a project in the assistant's page context follows the same scope as the admin API
	const { resolveAssistantOptions } = await import('../services/ai/assistant-request');
	const w = await world(e); const disp = await mkStaff(e, ['disputes.view'], 'ad');
	const ctx = (id: string) => ({ pageContext: { path: '/x', projectId: id } });
	await assert.doesNotReject(() => resolveAssistantOptions(ctx(w.inDispute.project.id), disp.user.id, 'admin'));
	await assert.rejects(() => resolveAssistantOptions(ctx(w.plain.project.id), disp.user.id, 'admin'), (x: any) => x.code === 'FORBIDDEN');
	await assert.rejects(() => resolveAssistantOptions(ctx(w.inDispute.project.id), bare.id, 'admin'), (x: any) => x.code === 'FORBIDDEN');
	await assert.doesNotReject(() => resolveAssistantOptions(ctx(w.plain.project.id), e.sa.id, 'admin'));
});

test('PG: open connections are cut when access is suspended, re-roled or reduced (and only then)', opts, async () => {
	const e = await env(); const { setSocketServer } = await import('../utils/socket-registry');
	const cut: string[] = []; const msgs: string[] = [];
	const fake = (uid: string) => ({ data: { userId: uid }, emit: (ev: string) => msgs.push(ev), disconnect: () => cut.push(uid) });
	const st = await mkStaff(e, ['users.view', 'tasks.manage'], 'cs'), other = await mkStaff(e, ['users.view'], 'co');
	const all = [fake(st.user.id), fake(other.user.id)];
	setSocketServer({ of: () => ({ fetchSockets: async () => all }) } as any);
	const r1 = await e.call('PATCH', `/admin/team/roles/${st.role.id}`, e.sa.id, { expectedVersion: st.role.version, permissions: ['users.view', 'tasks.manage', 'support.review'] });
	assert.equal(r1.status, 200); await new Promise(r => setTimeout(r, 30)); assert.deepEqual(cut, [], 'adding a permission cuts nothing');
	const r2 = await e.call('PATCH', `/admin/team/roles/${st.role.id}`, e.sa.id, { expectedVersion: r1.json.data.version, permissions: ['users.view'] });
	assert.equal(r2.status, 200); await new Promise(r => setTimeout(r, 30)); assert.deepEqual([...new Set(cut)], [st.user.id], 'withdrawing one cuts that role members only');
	cut.length = 0;
	const sus = await e.call('POST', `/admin/team/staff/${other.user.id}/suspend`, e.sa.id); assert.equal(sus.status, 200);
	await new Promise(r => setTimeout(r, 30)); assert.deepEqual([...new Set(cut)], [other.user.id]); assert.ok(msgs.includes('admin_access_changed'));
	setSocketServer(null);
});

test('PG: unknown permissions are refused everywhere (role create / edit, templates), SUPER_ADMIN-only powers are not grantable, an invitation needs an existing role, and a stale unknown id stored in a role is ignored', opts, async () => {
	const e = await env();
	for (const bad of ['bogus.perm', 'staff.invite', 'roles.manage', 'permissions.grant', 'super_admin.create', '*', 'users.*', '']) {
		const r = await e.call('POST', '/admin/team/roles', e.sa.id, { name: `سيئ ${tag()}`, permissions: ['users.view', bad] }); assert.equal(r.status, 400, `create with ${bad}`);
	}
	const role = await mkRole(e, ['users.view']);
	const upd = await e.call('PATCH', `/admin/team/roles/${role.id}`, e.sa.id, { expectedVersion: role.version, permissions: ['users.view', 'nope.nope'] }); assert.equal(upd.status, 400);
	assert.deepEqual((await e.prisma.adminRole.findUniqueOrThrow({ where: { id: role.id } })).permissions, ['users.view']);
	assert.equal((await e.call('POST', '/admin/team/invites', e.sa.id, { email: `x-${tag()}@pg.test`, fullName: 'مدعو اختبار', roleId: randomUUID() })).status, 400);
	assert.equal((await e.call('POST', '/admin/team/invites', e.sa.id, { email: `y-${tag()}@pg.test`, fullName: 'مدعو اختبار', roleId: role.id, permissions: ['users.delete'] })).status, 400); // no permissions can ride on an invitation
	const raw = await e.prisma.adminRole.create({ data: { name: `خام ${tag()}`, nameKey: `raw-${tag()}`, permissions: ['users.view', 'legacy.gone', 'staff.invite'], createdById: e.sa.id } });
	const u = await e.mkUser('ADMIN', 'raw'); await e.prisma.adminStaff.create({ data: { userId: u.id, roleId: raw.id } });
	const me = await e.call('GET', '/admin/team/access/me', u.id); assert.equal(me.status, 200); assert.deepEqual(me.json.data.permissions, ['users.view']);
	assert.equal((await e.call('POST', '/admin/team/roles', u.id, { name: 'ترقية', permissions: [] })).status, 403);
});

test('PG: a custom role given to one member changes nobody else; editing a role is visible on its members; per-person exceptions do not exist', opts, async () => {
	const e = await env();
	const a = await mkStaff(e, ['users.view'], 'ca'), b = await mkStaff(e, ['users.view'], 'cb');
	const custom = await mkRole(e, ['users.view', 'support.review'], `مخصص ${tag()}`);
	const staffA = await e.prisma.adminStaff.findUniqueOrThrow({ where: { userId: a.user.id } });
	const set = await e.call('PATCH', `/admin/team/staff/${a.user.id}/role`, e.sa.id, { roleId: custom.id, expectedVersion: staffA.version }); assert.equal(set.status, 200);
	const perms = async (id: string) => (await e.call('GET', '/admin/team/access/me', id)).json.data.permissions.slice().sort();
	assert.deepEqual(await perms(a.user.id), ['support.review', 'users.view']); assert.deepEqual(await perms(b.user.id), ['users.view']);
	// the member cannot touch their own or a colleague's access
	for (const [m, url, body] of [['PATCH', `/admin/team/staff/${a.user.id}/role`, { roleId: b.role.id, expectedVersion: 99 }], ['PATCH', `/admin/team/staff/${b.user.id}/role`, { roleId: custom.id, expectedVersion: 1 }], ['PATCH', `/admin/team/roles/${custom.id}`, { expectedVersion: 1, permissions: ['users.delete'] }]] as any[]) assert.equal((await e.call(m, url, a.user.id, body)).status, 403, url);
	// the role edit reaches the member at once and is listed with its member count
	const edit = await e.call('PATCH', `/admin/team/roles/${custom.id}`, e.sa.id, { expectedVersion: custom.version, permissions: ['users.view'] }); assert.equal(edit.status, 200);
	assert.deepEqual(await perms(a.user.id), ['users.view']);
	const list = await e.call('GET', '/admin/team/roles', e.sa.id); assert.equal(list.json.data.find((r: any) => r.id === custom.id).memberCount, 1);
});

test('PG: presence is real - «active now» only for a live session with activity in the last 5 minutes (revoked / expired / stale / suspended = not); departments are derived from the role; the activity feed is for the owner, the member, or tasks.manage', opts, async () => {
	const e = await env(); const { prisma } = e;
	const live = await mkStaff(e, ['disputes.view', 'users.view'], 'pl'), stale = await mkStaff(e, ['users.view'], 'ps'), revoked = await mkStaff(e, ['users.view'], 'pr'), none = await mkStaff(e, ['users.view'], 'pn'), suspended = await mkStaff(e, ['users.view'], 'pu');
	const sess = (userId: string, over: any = {}) => prisma.userSession.create({ data: { userId, tokenHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), expiresAt: new Date(Date.now() + 3600_000), lastActiveAt: new Date(), ...over } });
	await sess(live.user.id); await sess(stale.user.id, { lastActiveAt: new Date(Date.now() - 10 * 60_000) }); await sess(revoked.user.id, { revokedAt: new Date() }); await sess(suspended.user.id);
	await prisma.adminStaff.update({ where: { userId: suspended.user.id }, data: { status: 'SUSPENDED' } });
	const viewer = (await mkStaff(e, ['team.view'], 'pv')).user;
	const r = await e.call('GET', '/admin/team/staff', viewer.id); assert.equal(r.status, 200);
	const by = (id: string) => r.json.data.members.find((m: any) => m.userId === id);
	assert.equal(by(live.user.id).activeNow, true); for (const x of [stale, revoked, none, suspended]) assert.equal(by(x.user.id).activeNow, false, x.user.id);
	assert.equal(by(none.user.id).lastActiveAt, null); // no session = no claim, never a made-up time
	assert.ok(by(stale.user.id).lastActiveAt); assert.deepEqual(by(live.user.id).departments, ['المستخدمون', 'النزاعات']);
	assert.ok(r.json.data.counts.activeNow >= 1);
	// the activity feed: own, a SUPER_ADMIN, tasks.manage - not a colleague with only team.view
	const mgr = (await mkStaff(e, ['tasks.manage', 'team.view'], 'pm2')).user;
	assert.equal((await e.call('GET', `/admin/team/staff/${live.user.id}/activity`, live.user.id)).status, 200);
	assert.equal((await e.call('GET', `/admin/team/staff/${live.user.id}/activity`, e.sa.id)).status, 200);
	assert.equal((await e.call('GET', `/admin/team/staff/${live.user.id}/activity`, mgr.id)).status, 200);
	const denied = await e.call('GET', `/admin/team/staff/${live.user.id}/activity`, viewer.id); assert.equal(denied.status, 403); assert.equal(denied.json.code, 'ADMIN_PERMISSION_DENIED');
	assert.equal((await e.call('GET', `/admin/team/staff/${live.user.id}/activity`, (await e.mkUser('ADMIN', 'pbare')).id)).status, 403);
});
