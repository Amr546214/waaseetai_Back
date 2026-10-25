import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { env, opts, closeEnv } from '../testing/admin-team.pgenv';
import { ADMIN_ROLE_TEMPLATES } from '../config/admin-permissions';
import { ADMIN_NOTIFY_EVENT_PERMISSION } from '../config/admin-notification-permissions';

/**
 * Each job role of the design, created from its template, probed over HTTP against the real routers and the real database: it may do what its permissions say and nothing else.
 * The expectation of every probe is written by hand (what the endpoint needs), not read back from the implementation. Set ADMIN_MATRIX_OUT=<file> to write the result as Markdown.
 */
after(closeEnv);
type Probe = { label: string; m: string; url: string; needs: string[] | 'SUPER' };
const PROBES: Probe[] = [
	{ label: 'المستخدمون: عرض', m: 'GET', url: '/admin/users', needs: ['users.view'] },
	{ label: 'المستخدمون: تعليق', m: 'PATCH', url: '/admin/users/x/status', needs: ['users.suspend'] },
	{ label: 'المستخدمون: حذف', m: 'DELETE', url: '/admin/users/x', needs: ['users.delete'] },
	{ label: 'المستخدمون: تعديل الأدوار', m: 'PATCH', url: '/admin/users/x/roles', needs: 'SUPER' },
	{ label: 'النزاعات: عرض', m: 'GET', url: '/admin/disputes', needs: ['disputes.view'] },
	{ label: 'النزاعات: حل', m: 'POST', url: '/admin/disputes/x/resolve', needs: ['disputes.view', 'disputes.resolve'] },
	{ label: 'النزاعات: قرار مالي', m: 'POST', url: '/admin/disputes/x/resolve-financial', needs: ['disputes.view', 'disputes.resolve', 'payouts.send'] },
	{ label: 'النزاعات: إسناد', m: 'POST', url: '/admin/disputes/x/assign', needs: ['disputes.view', 'disputes.assign'] },
	{ label: 'الدعم: عرض التذاكر', m: 'GET', url: '/admin/tickets', needs: ['support.review'] },
	{ label: 'الدعم: رد', m: 'POST', url: '/admin/tickets/x/reply', needs: ['support.review', 'support.reply'] },
	{ label: 'السحوبات: عرض', m: 'GET', url: '/admin/withdrawals', needs: ['withdrawals.review'] },
	{ label: 'السحوبات: موافقة', m: 'POST', url: '/admin/withdrawals/x/approve', needs: ['withdrawals.review', 'withdrawals.approve'] },
	{ label: 'السحوبات: رفض', m: 'POST', url: '/admin/withdrawals/x/reject', needs: ['withdrawals.review', 'withdrawals.reject'] },
	{ label: 'السحوبات: صرف', m: 'POST', url: '/admin/withdrawals/x/send-payout', needs: ['withdrawals.review', 'payouts.send'] },
	{ label: 'المالية: التقارير', m: 'GET', url: '/admin/finance/overview', needs: ['finance.read'] },
	{ label: 'الإعدادات', m: 'GET', url: '/admin/settings', needs: ['settings.manage'] },
	{ label: 'الفريق: القائمة', m: 'GET', url: '/admin/team/staff', needs: ['team.view'] },
	{ label: 'المهام: إنشاء', m: 'POST', url: '/admin/team/tasks', needs: ['tasks.manage'] },
	{ label: 'الأداء: عرض', m: 'GET', url: '/admin/team/performance', needs: ['performance.view'] },
	{ label: 'الأداء: تصدير', m: 'GET', url: '/admin/team/performance/export', needs: ['performance.view', 'performance.export'] },
	{ label: 'الرسائل: دليل الموظفين', m: 'GET', url: '/admin/messages/directory', needs: ['messages.use'] },
	{ label: 'الرسائل: قائمة محادثاتي', m: 'GET', url: '/admin/messages/conversations', needs: ['messages.use'] },
	{ label: 'الرسائل: بدء محادثة', m: 'POST', url: '/admin/messages/conversations', needs: ['messages.use'] },
	{ label: 'Audit Trail', m: 'GET', url: '/admin/team/access-audit', needs: ['audit.view'] },
	{ label: 'العمليات: قائمة المشاريع', m: 'GET', url: '/admin/projects', needs: 'SUPER' },
	{ label: 'الأدوار: إنشاء/تعديل', m: 'POST', url: '/admin/team/roles', needs: 'SUPER' },
	{ label: 'الفريق: دعوة موظف', m: 'POST', url: '/admin/team/invites', needs: 'SUPER' },
	{ label: 'الفريق: ضم/تغيير دور', m: 'POST', url: '/admin/team/staff/attach', needs: 'SUPER' },
	{ label: 'الفريق: صلاحيات فردية', m: 'PUT', url: '/admin/team/staff/x/access', needs: 'SUPER' },
	{ label: 'الفريق: إيقاف موظف', m: 'POST', url: '/admin/team/staff/x/suspend', needs: 'SUPER' },
];
const allowed = (p: Probe, perms: string[]) => p.needs !== 'SUPER' && p.needs.every(n => perms.includes(n));
const rows: string[] = []; const header = ['الفحص', 'Super Admin', ...ADMIN_ROLE_TEMPLATES.map(t => t.name), 'ADMIN بلا منح', 'حساب مزود/عميل عادي (مثل amr250010@gmail.com)'];
const cells = new Map<string, string[]>(PROBES.map(p => [p.label, []]));

test('PG: every job role of the design - allowed probes pass the guard, every other probe is 403; SUPER_ADMIN passes all; an ADMIN with no grant and a client account get 403 everywhere', opts, async () => {
	const e = await env();
	const mk = async (perms: string[], name: string) => { const r = await e.call('POST', '/admin/team/roles', e.sa.id, { name: `${name} ${randomUUID().slice(0, 5)}`, permissions: perms }); assert.equal(r.status, 201, r.text); const u = await e.mkUser('ADMIN', 'm'); await e.prisma.adminStaff.create({ data: { userId: u.id, roleId: r.json.data.id } }); return u; };
	const actors: Array<{ who: string; id: string; perms: string[] | 'ALL' | 'NONE' }> = [{ who: 'sa', id: e.sa.id, perms: 'ALL' }];
	for (const t of ADMIN_ROLE_TEMPLATES) actors.push({ who: t.name, id: (await mk([...t.permissions], t.name)).id, perms: [...t.permissions] });
	actors.push({ who: 'bare', id: (await e.mkUser('ADMIN', 'bare')).id, perms: 'NONE' });
	const client = await e.prisma.user.create({ data: { id: randomUUID(), accountType: 'PROVIDER_INDIVIDUAL', status: 'ACTIVE', roles: ['PROVIDER', 'CLIENT', 'AFFILIATE'], activeRole: 'CLIENT', firstName: 'a', lastName: 'b', email: 'amr250010@gmail.com'.replace('@', `-${randomUUID().slice(0, 5)}@`), password: 'x', agreedToTerms: true } });
	actors.push({ who: 'client', id: client.id, perms: 'NONE' });
	for (const p of PROBES) {
		for (const a of actors) {
			const r = await e.call(p.m, p.url, a.id, p.m === 'GET' ? undefined : {});
			const expected = a.perms === 'ALL' ? true : a.perms === 'NONE' ? false : allowed(p, a.perms);
			assert.equal(r.status !== 403 && r.status !== 401, expected, `${a.who} ${p.m} ${p.url} -> ${r.status} (expected ${expected ? 'through the guard' : '403'})`);
			if (!expected) assert.ok(!/"data"/.test(r.text), 'a refusal carries no data');
			cells.get(p.label)!.push(expected ? '✅' : '—');
		}
	}
	for (const p of PROBES) rows.push(`| ${p.label} | ${cells.get(p.label)!.join(' | ')} |`);
	if (process.env.ADMIN_MATRIX_OUT) fs.writeFileSync(process.env.ADMIN_MATRIX_OUT, `| ${header.join(' | ')} |\n|${header.map(() => '---').join('|')}|\n${rows.join('\n')}\n`);
});

test('PG: notifications and the team pages follow each role as well - an event reaches only the roles that hold its permission (and every SUPER_ADMIN); a team manager cannot hand out anything', opts, async () => {
	const e = await env(); const { notificationService } = await import('../services/notification.service'); const { notifyAdmins } = await import('../services/admin-notifications.service');
	(notificationService as any).createAndEmit = async (i: any) => e.prisma.notification.create({ data: { id: randomUUID(), userId: i.userId, title: i.title, message: i.message, category: i.category, type: i.type, actionUrl: i.actionUrl, metadata: i.metadata } });
	const users = new Map<string, string>();
	for (const t of ADMIN_ROLE_TEMPLATES) { const r = await e.call('POST', '/admin/team/roles', e.sa.id, { name: `n-${t.name} ${randomUUID().slice(0, 5)}`, permissions: [...t.permissions] }); const u = await e.mkUser('ADMIN', 'n'); await e.prisma.adminStaff.create({ data: { userId: u.id, roleId: r.json.data.id } }); users.set(t.name, u.id); }
	const events = Object.keys(ADMIN_NOTIFY_EVENT_PERMISSION) as Array<keyof typeof ADMIN_NOTIFY_EVENT_PERMISSION>;
	for (const ev of events) await notifyAdmins(ev, { id: `id-${ev}`, ref: ev });
	for (const t of ADMIN_ROLE_TEMPLATES) for (const ev of events) {
		const got = await e.prisma.notification.count({ where: { userId: users.get(t.name)!, type: `ADMIN_${ev}` } });
		assert.equal(got, t.permissions.includes(ADMIN_NOTIFY_EVENT_PERMISSION[ev]) ? 1 : 0, `${t.name} / ${ev}`);
	}
	for (const ev of events) assert.ok(await e.prisma.notification.count({ where: { userId: e.sa.id, type: `ADMIN_${ev}` } }) >= 1, `SUPER_ADMIN gets ${ev}`);
	// the team manager: sees the team and distributes tasks, but every grant / role / invite / suspend is refused and the roles of colleagues do not move
	const tm = users.get('مدير فريق')!; const colleague = users.get('مشرف دعم')!;
	assert.notEqual((await e.call('GET', '/admin/team/staff', tm)).status, 403);
	const before = (await e.call('GET', '/admin/team/access/me', colleague)).json.data.permissions;
	for (const [m, url, body] of [['PUT', `/admin/team/staff/${colleague}/access`, { overrides: [{ permission: 'users.delete', effect: 'GRANT' }], expectedVersion: 1, confirmSensitive: true }], ['PATCH', `/admin/team/staff/${colleague}/role`, { roleId: null, expectedVersion: 1 }], ['POST', '/admin/team/roles', { name: 'x', permissions: ['users.delete'] }], ['POST', `/admin/team/staff/${colleague}/suspend`, undefined], ['POST', '/admin/team/invites', { email: 'q@pg.test', fullName: 'اسم ثلاثي', roleId: randomUUID() }]] as const) assert.equal((await e.call(m, url, tm, body as any)).status, 403, `${m} ${url}`);
	assert.deepEqual((await e.call('GET', '/admin/team/access/me', colleague)).json.data.permissions, before);
});

test('PG: the support supervisor processes tickets within his scope - read, reply, status, priority, notes, taking a ticket for himself; handing one to somebody else needs tasks.manage; no people management, money or dispute resolution', opts, async () => {
	const e = await env(); const { prisma } = e;
	const mkRole = async (perms: string[], n: string) => (await e.call('POST', '/admin/team/roles', e.sa.id, { name: `${n} ${randomUUID().slice(0, 5)}`, permissions: perms })).json.data;
	const support = ADMIN_ROLE_TEMPLATES.find(t => t.name === 'مشرف دعم')!;
	const role = await mkRole([...support.permissions], 'ds'); const me = await e.mkUser('ADMIN', 'sup'); const colleague = await e.mkUser('ADMIN', 'sup2');
	await prisma.adminStaff.create({ data: { userId: me.id, roleId: role.id } }); await prisma.adminStaff.create({ data: { userId: colleague.id, roleId: role.id } });
	const owner = await prisma.user.create({ data: { id: randomUUID(), accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', roles: ['CLIENT'], activeRole: 'CLIENT', firstName: 'c', lastName: 'c', email: `t-${randomUUID().slice(0, 6)}@pg.test`, password: 'x', agreedToTerms: true } });
	const ticket = await prisma.supportTicket.create({ data: { id: randomUUID(), ticketNumber: `T-${randomUUID().slice(0, 6)}`, userId: owner.id, subject: 's', category: 'c', description: 'd' } });
	const t = (m: string, p: string, body?: any, who = me.id) => e.call(m, `/admin/tickets/${ticket.id}${p}`, who, body);
	assert.equal((await e.call('GET', '/admin/tickets', me.id)).status, 200);                                                  // read
	assert.equal((await t('GET', '')).status, 200);
	assert.equal((await t('POST', '/reply', { body: 'تم استلام طلبك وسنعالجه' })).status, 201);                              // reply
	assert.equal((await t('PATCH', '/status', { status: 'RESOLVED' })).status, 200);                                            // the status the handling needs
	assert.equal((await t('PATCH', '/priority', { priority: 'عالية' })).status, 200);
	assert.ok([200, 201].includes((await t('POST', '/notes', { body: 'ملاحظة داخلية للمعالجة' })).status));
	assert.equal((await t('POST', '/assign', { assigneeId: me.id })).status, 200);                                              // for himself: yes
	const others = await t('POST', '/assign', { assigneeId: colleague.id }); assert.equal(others.status, 403); assert.equal(others.json.code, 'ADMIN_PERMISSION_DENIED'); // for another: no
	// a lead who does hold tasks.manage may hand it over (and the assignee must hold support.review)
	const lead = await e.mkUser('ADMIN', 'lead'); await prisma.adminStaff.create({ data: { userId: lead.id, roleId: (await mkRole([...support.permissions, 'tasks.manage'], 'dl')).id } });
	assert.equal((await t('POST', '/assign', { assigneeId: colleague.id }, lead.id)).status, 200);
	assert.equal((await e.call('GET', '/admin/withdrawals', me.id)).status, 403);
	// the same member still cannot manage people, move money or resolve a financial dispute
	for (const [m, url, body] of [['POST', '/admin/team/roles', { name: 'x', permissions: [] }], ['PUT', `/admin/team/staff/${colleague.id}/access`, { overrides: [], expectedVersion: 1 }], ['POST', `/admin/team/staff/${colleague.id}/suspend`, undefined], ['POST', '/admin/withdrawals/x/approve', {}], ['POST', '/admin/withdrawals/x/send-payout', {}], ['POST', '/admin/disputes/x/resolve-financial', {}], ['POST', '/admin/disputes/x/resolve', {}], ['POST', '/admin/team/tasks', { title: 'x' }]] as const) assert.equal((await e.call(m, url, me.id, body as any)).status, 403, `${m} ${url}`);
});
