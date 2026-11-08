import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * Permissions matrix for REPORTS / SUPPORT / DISPUTES / NOTIFICATIONS (docs/admin-permissions-matrix.md), proven over HTTP against the REAL routers, the REAL permission guard and a REAL
 * PostgreSQL (isolated local :55432). Only `authenticate` is replaced (user id from a header). For EVERY execute action: a staff member who holds the VIEW permission only, a staff member
 * whose section (departments scope) excludes the area, a suspended member, an ADMIN with no staff row, a client account and an anonymous caller are refused (403 / 401) and NOTHING changes.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\/qa_iso_perm_/.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL = DATABASE_URL (isolated local PostgreSQL :55432, database qa_iso_perm_*) to run' };
process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x'; process.env.FRONTEND_URL ??= 'https://front.test';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';

let envP: Promise<any> | null = null;
async function env() {
	if (envP) return envP;
	envP = (async () => {
		const { prisma } = await import('../config/db');
		mock.module('../middlewares/auth.middleware', { namedExports: {
			authenticate: async (req: any, res: any, next: any) => {
				const id = req.headers['x-test-user'];
				const u = id ? await prisma.user.findUnique({ where: { id: String(id) } }) : null;
				if (!u) return res.status(401).json({ success: false, message: 'غير مصرح' });
				req.user = { id: u.id, userId: u.id, email: u.email, accountType: u.accountType, status: u.status, activeRole: u.activeRole, roles: u.roles, sessionId: 's' };
				next();
			},
			requireActiveUser: (req: any, res: any, next: any) => (req.user?.status === 'ACTIVE' ? next() : res.status(403).json({ success: false, message: 'الحساب غير نشط' })),
			authorize: () => (_q: any, _r: any, n: any) => n(), authorizeAdminActing: (_q: any, _r: any, n: any) => n(),
		} });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express(); app.use(express.json());
		app.use('/admin/reports', (await import('./platform-reports.routes')).adminPlatformReports);
		app.use('/admin/tickets', (await import('./admin-tickets.routes')).default);
		app.use('/admin/disputes', (await import('./admin-disputes.routes')).default);
		app.use('/admin/notification-history', (await import('./admin-notification-history.routes')).default);
		app.use('/admin/notification-templates', (await import('./admin-notification-templates.routes')).default);
		app.use(globalErrorHandler as any);
		const server = http.createServer(app);
		await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as AddressInfo).port;
		const call = async (method: string, url: string, who?: string | null, body?: any) => {
			const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json', connection: 'close', ...(who ? { 'x-test-user': who } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
			const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
			return { status: res.status, json, text };
		};
		const tag = randomUUID().slice(0, 6);
		const mkUser = (accountType: string, t: string) => prisma.user.create({ data: { id: randomUUID(), accountType: accountType as any, status: 'ACTIVE', roles: [accountType === 'ADMIN' ? 'ADMIN' : accountType === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'CLIENT'] as any, activeRole: (accountType === 'ADMIN' ? 'ADMIN' : accountType === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'CLIENT') as any, firstName: t, lastName: 'pm', email: `${t}-${tag}-${randomUUID().slice(0, 4)}@pg.test`, password: 'x', agreedToTerms: true } as any });
		const staff = async (perms: string[], t: string, extra: { scoped?: boolean; departments?: string[]; status?: 'ACTIVE' | 'SUSPENDED' } = {}) => {
			const sa0 = await mkUser('SUPER_ADMIN', 'sa0');
			const role = await prisma.adminRole.create({ data: { name: `${t} ${tag} ${randomUUID().slice(0, 4)}`, nameKey: `${t}-${tag}-${randomUUID()}`.toLowerCase(), permissions: perms, createdById: sa0.id } });
			const u = await mkUser('ADMIN', t);
			await prisma.adminStaff.create({ data: { userId: u.id, roleId: role.id, ...extra } as any });
			return u;
		};
		return { prisma, call, mkUser, staff, server };
	})();
	return envP;
}
after(async () => { const e = await envP; if (e) { e.server.closeAllConnections?.(); await new Promise(r => e.server.close(r)); await e.prisma.$disconnect(); } });

type Probe = { area: string; label: string; m: string; path: (ids: Ids) => string; body?: (ids: Ids, who: { self: string; other: string }) => any; needs: string[] | 'SUPER' };
type Ids = { ticket: string; dispute: string; report: string; template: string };
// every EXECUTE action of the four areas. The expectation is written by hand (what the endpoint needs), not read back from the implementation.
const EXECUTE: Probe[] = [
	{ area: 'reports', label: 'البلاغات: قرار', m: 'PATCH', path: i => `/admin/reports/${i.report}`, body: () => ({ status: 'RESOLVED', resolution: 'تمت المعالجة' }), needs: ['reports.view', 'reports.manage'] },
	{ area: 'support', label: 'الدعم: رد', m: 'POST', path: i => `/admin/tickets/${i.ticket}/reply`, body: () => ({ body: 'رد من الدعم الفني' }), needs: ['support.review', 'support.reply'] },
	{ area: 'support', label: 'الدعم: حالة', m: 'PATCH', path: i => `/admin/tickets/${i.ticket}/status`, body: () => ({ status: 'RESOLVED' }), needs: ['support.review', 'support.reply'] },
	{ area: 'support', label: 'الدعم: أولوية', m: 'PATCH', path: i => `/admin/tickets/${i.ticket}/priority`, body: () => ({ priority: 'عالية' }), needs: ['support.review', 'support.reply'] },
	{ area: 'support', label: 'الدعم: ملاحظة داخلية', m: 'POST', path: i => `/admin/tickets/${i.ticket}/notes`, body: () => ({ body: 'ملاحظة داخلية للمعالجة' }), needs: ['support.review', 'support.reply'] },
	{ area: 'support', label: 'الدعم: تكليف لنفسه', m: 'POST', path: i => `/admin/tickets/${i.ticket}/assign`, body: (_i, w) => ({ assigneeId: w.self }), needs: ['support.review', 'support.reply'] },
	{ area: 'support', label: 'الدعم: تكليف/تصعيد لموظف آخر', m: 'POST', path: i => `/admin/tickets/${i.ticket}/assign`, body: (_i, w) => ({ assigneeId: w.other, escalationReason: 'سبب التصعيد' }), needs: ['support.review', 'support.reply', 'tasks.manage'] },
	{ area: 'disputes', label: 'النزاعات: حل/رفض', m: 'POST', path: i => `/admin/disputes/${i.dispute}/resolve`, body: () => ({ resolution: 'RESOLVED' }), needs: ['disputes.view', 'disputes.resolve'] },
	{ area: 'disputes', label: 'النزاعات: قرار مالي', m: 'POST', path: i => `/admin/disputes/${i.dispute}/resolve-financial`, body: () => ({}), needs: ['disputes.view', 'disputes.resolve', 'payouts.send'] },
	{ area: 'disputes', label: 'النزاعات: إسناد', m: 'POST', path: i => `/admin/disputes/${i.dispute}/assign`, body: (_i, w) => ({ assigneeId: w.other }), needs: ['disputes.view', 'disputes.assign'] },
	{ area: 'disputes', label: 'النزاعات: ملاحظة', m: 'POST', path: i => `/admin/disputes/${i.dispute}/notes`, body: () => ({ body: 'ملاحظة داخلية' }), needs: ['disputes.view', 'disputes.note'] },
	{ area: 'disputes', label: 'النزاعات: حالة المراجعة', m: 'PATCH', path: i => `/admin/disputes/${i.dispute}/status`, body: () => ({ status: 'UNDER_REVIEW' }), needs: ['disputes.view', 'disputes.resolve'] },
	{ area: 'disputes', label: 'النزاعات: رسالة للطرفين', m: 'POST', path: i => `/admin/disputes/${i.dispute}/messages`, body: () => ({ body: 'رسالة من الإدارة' }), needs: ['disputes.view', 'messages.use'] },
	{ area: 'notifications', label: 'الإشعارات: إنشاء قالب', m: 'POST', path: () => '/admin/notification-templates', body: () => ({ name: `قالب ${randomUUID().slice(0, 6)}`, title: 'عنوان', message: 'نص' }), needs: 'SUPER' },
	{ area: 'notifications', label: 'الإشعارات: تعديل قالب', m: 'PATCH', path: i => `/admin/notification-templates/${i.template}`, body: () => ({ name: 'اسم جديد', title: 'x', message: 'y', version: 1 }), needs: 'SUPER' },
];
const VIEW: Array<{ label: string; url: (i: Ids) => string; needs: string[] | 'SUPER' }> = [
	{ label: 'البلاغات: قائمة', url: () => '/admin/reports', needs: ['reports.view'] },
	{ label: 'البلاغات: تفصيل', url: i => `/admin/reports/${i.report}`, needs: ['reports.view'] },
	{ label: 'الدعم: قائمة', url: () => '/admin/tickets', needs: ['support.review'] },
	{ label: 'الدعم: تفصيل', url: i => `/admin/tickets/${i.ticket}`, needs: ['support.review'] },
	{ label: 'النزاعات: قائمة', url: () => '/admin/disputes', needs: ['disputes.view'] },
	{ label: 'النزاعات: تفصيل', url: i => `/admin/disputes/${i.dispute}`, needs: ['disputes.view'] },
	{ label: 'النزاعات: الرسائل (قراءة)', url: i => `/admin/disputes/${i.dispute}/messages`, needs: ['disputes.view'] },
	{ label: 'سجل الإشعارات', url: () => '/admin/notification-history', needs: 'SUPER' },
	{ label: 'القوالب: قائمة', url: () => '/admin/notification-templates', needs: 'SUPER' },
];
const has = (needs: string[] | 'SUPER', perms: string[]) => needs !== 'SUPER' && needs.every(n => perms.includes(n));
const refused = (s: number) => s === 401 || s === 403;

async function fixtures(e: any): Promise<Ids> {
	const { prisma } = e; const owner = await e.mkUser('CLIENT_INDIVIDUAL', 'own'); const against = await e.mkUser('CLIENT_INDIVIDUAL', 'agn');
	const ticket = await prisma.supportTicket.create({ data: { id: randomUUID(), ticketNumber: `T-${randomUUID().slice(0, 8)}`, userId: owner.id, subject: 's', category: 'c', description: 'd' } });
	const dispute = await prisma.dispute.create({ data: { id: randomUUID(), openedById: owner.id, againstUserId: against.id, reason: 'r', description: 'd' } });
	const report = await prisma.platformReport.create({ data: { id: randomUUID(), reporterId: owner.id, targetType: 'ACCOUNT', targetId: against.id, targetLabel: 'x', reason: 'سبب البلاغ الطويل' } });
	const template = await prisma.notificationTemplate.create({ data: { id: randomUUID(), name: `t-${randomUUID().slice(0, 8)}`, title: 't', message: 'm' } });
	return { ticket: ticket.id, dispute: dispute.id, report: report.id, template: template.id };
}
async function snapshot(e: any, i: Ids) {
	const { prisma } = e;
	const [t, d, r, tpl, tm, dm, audit, notif, tasks] = await Promise.all([
		prisma.supportTicket.findUnique({ where: { id: i.ticket } }), prisma.dispute.findUnique({ where: { id: i.dispute } }), prisma.platformReport.findUnique({ where: { id: i.report } }),
		prisma.notificationTemplate.findMany({ orderBy: { id: 'asc' } }), prisma.supportTicketMessage.count({ where: { ticketId: i.ticket } }), prisma.disputeMessage.count({ where: { disputeId: i.dispute } }),
		prisma.accountAuditLog.count(), prisma.notification.count(), prisma.adminTask.count(),
	]);
	return JSON.stringify({ t, d, r, tpl, tm, dm, audit, notif, tasks });
}

test('PG: every EXECUTE action of reports / support / disputes / notifications refuses a VIEW-only member, an out-of-section member, a suspended member, a bare ADMIN, a client and an anonymous caller - and changes nothing', opts, async () => {
	const e = await env(); const ids = await fixtures(e);
	const viewOnly = (area: string) => ({ reports: ['reports.view'], support: ['support.review'], disputes: ['disputes.view'], notifications: [] as string[] })[area]!;
	const sa = await e.mkUser('SUPER_ADMIN', 'sa'); const other = await e.staff(['support.review', 'disputes.view'], 'peer');
	const client = await e.mkUser('CLIENT_INDIVIDUAL', 'cli'); const bare = await e.mkUser('ADMIN', 'bare');
	const suspended = await e.staff(['reports.view', 'reports.manage', 'support.review', 'support.reply', 'tasks.manage', 'disputes.view', 'disputes.resolve', 'disputes.assign', 'disputes.note', 'payouts.send', 'messages.use'], 'susp', { status: 'SUSPENDED' });
	const sectionOff = await e.staff(['reports.view', 'reports.manage', 'support.review', 'support.reply', 'tasks.manage', 'disputes.view', 'disputes.resolve', 'disputes.assign', 'disputes.note', 'payouts.send', 'messages.use'], 'scoped', { scoped: true, departments: ['users'] });
	const viewers: Record<string, any> = {};
	for (const area of ['reports', 'support', 'disputes', 'notifications']) viewers[area] = await e.staff(viewOnly(area), `v-${area}`);
	// a manager of every area EXCEPT the one permission under test would be the finer probe; here: the strongest NON-super holder of everything in the area still cannot do SUPER actions
	const everything = await e.staff(['reports.view', 'reports.manage', 'support.review', 'support.reply', 'tasks.manage', 'disputes.view', 'disputes.resolve', 'disputes.assign', 'disputes.note', 'payouts.send', 'messages.use', 'users.view', 'team.view', 'audit.view', 'settings.manage', 'settings.view'], 'allbutsuper');
	let probes = 0;
	for (const p of EXECUTE) {
		const body = p.body!(ids, { self: viewers[p.area].id, other: other.id });
		const before = await snapshot(e, ids);
		const url = p.path(ids);
		const callers: Array<[string, string | null]> = [['anonymous', null], ['client', client.id], ['bare ADMIN', bare.id], ['suspended staff', suspended.id], ['section-off staff', sectionOff.id], ['view-only', viewers[p.area].id]];
		// the member who holds the strongest NON-super set must still be refused SUPER-only actions
		if (p.needs === 'SUPER') callers.push(['strongest non-super staff', everything.id]);
		// a member who holds all-but-ONE of the required ids is refused as well
		if (p.needs !== 'SUPER') for (const miss of p.needs) {
			const perms = p.needs.filter(n => n !== miss); if (perms.length < p.needs.length) callers.push([`holds all but ${miss}`, (await e.staff(perms, `miss-${miss}`)).id]);
		}
		for (const [who, id] of callers) {
			const r = await e.call(p.m, url, id, body);
			assert.ok(refused(r.status), `${p.label} as ${who}: expected 401/403, got ${r.status} ${r.text.slice(0, 160)}`);
			assert.ok(!/"data"/.test(r.text), `${p.label} as ${who}: a refusal carries no data`); probes++;
		}
		assert.equal(await snapshot(e, ids), before, `${p.label}: a refused request changed data`);
		// positive control: the exact holder passes the permission guard (anything but 401/403), SUPER_ADMIN always does for non-SUPER_ONLY rows
		if (p.needs !== 'SUPER') {
			const holder = await e.staff(p.needs, 'holder');
			// an EMPTY body: the holder passes the guard and is stopped by validation (400) - nothing real is sent or changed by the control
			const r = await e.call(p.m, url, holder.id, {}); assert.ok(!refused(r.status), `${p.label}: the holder is refused (${r.status} ${r.text.slice(0, 120)})`);
		}
	}
	// staff have NO upload route on a ticket / dispute (attachments are read + download only for them): a POST never succeeds
	for (const [who, id] of [['view-only support', viewers.support.id], ['everything', everything.id], ['SUPER_ADMIN', sa.id]] as const) {
		const r = await e.call('POST', `/admin/tickets/${ids.ticket}/attachments`, id, {}); assert.ok(r.status >= 400, `ticket attachment upload as ${who}: ${r.status}`);
		const d = await e.call('POST', `/admin/disputes/${ids.dispute}/attachments`, id, {}); assert.ok(d.status >= 400, `dispute attachment upload as ${who}: ${d.status}`);
	}
	assert.ok(probes >= 100, `probes: ${probes}`);
});

test('PG: VIEW endpoints - a member without the view permission (and a bare ADMIN, a client, anonymous) is refused; the exact holder is let in; SUPER-only reads refuse every non-super staff', opts, async () => {
	const e = await env(); const ids = await fixtures(e);
	const client = await e.mkUser('CLIENT_INDIVIDUAL', 'cli'); const bare = await e.mkUser('ADMIN', 'bare'); const sa = await e.mkUser('SUPER_ADMIN', 'sa');
	const strongest = await e.staff(['reports.view', 'reports.manage', 'support.review', 'support.reply', 'tasks.manage', 'disputes.view', 'disputes.resolve', 'disputes.assign', 'disputes.note', 'payouts.send', 'messages.use', 'audit.view'], 'strong');
	for (const v of VIEW) {
		assert.equal((await e.call('GET', v.url(ids), null)).status, 401, `${v.label} anonymous`);
		for (const [who, id] of [['client', client.id], ['bare ADMIN', bare.id]] as const) assert.ok(refused((await e.call('GET', v.url(ids), id)).status), `${v.label} ${who}`);
		if (v.needs === 'SUPER') {
			assert.equal((await e.call('GET', v.url(ids), strongest.id)).status, 403, `${v.label} strongest non-super`);
			assert.ok(!refused((await e.call('GET', v.url(ids), sa.id)).status), `${v.label} SUPER_ADMIN`);
		} else {
			const none = await e.staff(['team.view'], 'noview'); assert.equal((await e.call('GET', v.url(ids), none.id)).status, 403, `${v.label} without the view permission`);
			const holder = await e.staff(v.needs, 'holder'); assert.ok(!refused((await e.call('GET', v.url(ids), holder.id)).status), `${v.label} holder`);
		}
	}
});

test('PG: no assignee scope exists - a view-only member reads ANY ticket / dispute / report, and a member whose section is excluded reads none (the only scope is the departments narrowing)', opts, async () => {
	const e = await env(); const a = await fixtures(e); const b = await fixtures(e);
	const reader = await e.staff(['support.review', 'disputes.view', 'reports.view'], 'reader');
	for (const i of [a, b]) for (const u of [`/admin/tickets/${i.ticket}`, `/admin/disputes/${i.dispute}`, `/admin/reports/${i.report}`]) assert.equal((await e.call('GET', u, reader.id)).status, 200, u);
	const off = await e.staff(['support.review', 'disputes.view', 'reports.view'], 'off', { scoped: true, departments: ['users'] });
	for (const u of [`/admin/tickets/${a.ticket}`, `/admin/disputes/${a.dispute}`, `/admin/reports/${a.report}`, '/admin/tickets', '/admin/disputes', '/admin/reports']) assert.equal((await e.call('GET', u, off.id)).status, 403, u);
	const supportOnly = await e.staff(['support.review', 'support.reply', 'disputes.view', 'reports.view'], 'sup', { scoped: true, departments: ['support'] });
	assert.equal((await e.call('GET', `/admin/tickets/${a.ticket}`, supportOnly.id)).status, 200);
	assert.equal((await e.call('GET', `/admin/disputes/${a.dispute}`, supportOnly.id)).status, 403);
	assert.equal((await e.call('GET', `/admin/reports/${a.report}`, supportOnly.id)).status, 403);
});
