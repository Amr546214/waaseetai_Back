import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { env, opts, mkRole, mkStaff, closeEnv } from '../testing/admin-team.pgenv';

/**
 * The admin audit trail on REAL PostgreSQL. Events of many different kinds are produced through the real routes/services (role, staff, settings, fee policy)
 * and the writers (adminAuditData, adminAudit.record, accountAuditLogService, session). The list must show each event's OWN identity (code, Arabic name,
 * actor, target, detail) - a regression to «every row looks like a login» fails here.
 */
after(async () => { await new Promise(r => { trail?.server.closeAllConnections?.(); trail ? trail.server.close(r) : r(null); }); await closeEnv(); });
let trail: { server: http.Server; get: (qs: string, who: string) => Promise<any> } | null = null;
async function mount(e: any) {
	if (trail) return trail;
	const express = (await import('express')).default;
	const { globalErrorHandler } = await import('../middlewares/error.middleware');
	const account = (await import('../routes/admin-account.routes')).default;
	const app = express(); app.use(express.json()); app.use('/admin/console', account); app.use(globalErrorHandler as any);
	const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	const port = (server.address() as AddressInfo).port;
	trail = { server, get: async (qs, who) => { const res = await fetch(`http://127.0.0.1:${port}/admin/console/audit-log?${qs}`, { headers: { 'x-test-user': who, connection: 'close' } }); return { status: res.status, json: await res.json() }; } };
	return trail;
}

async function produce(e: any) {
	const { adminAuditData } = await import('./admin-audit');
	const { adminAudit } = await import('./admin-audit.service');
	const { accountAuditLogService } = await import('./account-logs.service');
	const tag = randomUUID().slice(0, 6);
	// two staff members with real roles
	const roleA = await mkRole(e, ['users.view'], `دور أ ${tag}`); const roleB = await mkRole(e, ['users.view', 'audit.view'], `دور ب ${tag}`);
	const staff = await e.mkUser('ADMIN', `st${tag}`); await e.prisma.adminStaff.create({ data: { userId: staff.id, roleId: roleA.id } });
	const other = await e.mkUser('ADMIN', `ot${tag}`);
	assert.equal((await e.call('PATCH', `/admin/team/staff/${staff.id}/role`, e.sa.id, { roleId: roleB.id, expectedVersion: 1 })).status, 200);
	assert.equal((await e.call('POST', `/admin/team/staff/${staff.id}/suspend`, e.sa.id)).status, 200);
	assert.equal((await e.call('PATCH', `/admin/team/roles/${roleB.id}`, e.sa.id, { name: roleB.name, permissions: ['users.view'], expectedVersion: 1, confirmSensitive: true })).status, 200);
	const cur = await e.prisma.platformSetting.findUnique({ where: { key: 'channelEmail' } });
	const st = await e.call('PUT', '/admin/system-settings', e.sa.id, { changes: { channelEmail: !(cur?.value ?? true) }, expected: { channelEmail: cur?.version ?? 0 } }); assert.equal(st.status, 200, JSON.stringify(st.json));
	await e.prisma.feePolicyVersion.deleteMany({}); (await import('./fee-policy.service')).feePolicyService.invalidate();
	const fp = await e.call('POST', '/admin/fee-policy', e.sa.id, { changes: { minProviderPayout: 25 }, effectiveFrom: new Date(Date.now() + 3600_000).toISOString(), note: 'سبب', baseVersion: 1, confirmSensitive: true }); assert.equal(fp.status, 201, JSON.stringify(fp.json));
	// a back-office action written against the affected user (the actor is the admin), an entity action, and an own-account event
	const client = await e.mkUser('CLIENT_INDIVIDUAL', `cl${tag}`);
	await e.prisma.accountAuditLog.create({ data: adminAuditData({ actor: { id: staff.id, accountType: 'ADMIN' }, userId: client.id, eventType: 'KYC_APPROVED_BY_ADMIN', title: 'اعتماد توثيق الهوية', summary: 'اعتمدت الإدارة مستندات هوية العميل', details: { party: 'CLIENT' } }) });
	await adminAudit.record({ adminId: other.id, entity: 'DISPUTE', entityId: 'disp-123', eventType: 'DISPUTE_ASSIGNED', title: 'إسناد نزاع', summary: 'أُسند النزاع إلى مسؤول', severity: 'INFO' });
	await accountAuditLogService.record({ userId: other.id, eventType: 'SESSION_STARTED', category: 'SECURITY_CHANGE', title: 'تسجيل دخول جديد', summary: 'بدأت جلسة جديدة عبر Chrome على macOS', source: 'USER', context: { ipAddress: '10.1.2.3' } });
	await accountAuditLogService.record({ userId: other.id, eventType: 'LOGIN_REJECTED', category: 'SECURITY_CHANGE', title: 'محاولة تسجيل دخول مرفوضة', summary: 'رُفضت محاولة', source: 'USER', severity: 'WARNING' });
	await accountAuditLogService.record({ userId: other.id, eventType: 'BRAND_NEW_UNMAPPED_EVENT', category: 'SYSTEM_AUDIT', title: 'حدث جديد', summary: 'حدث غير معروف للواجهة', source: 'ADMIN' });
	return { staff, other, client, roleA, roleB, tag };
}

test('PG audit trail: every event shows its OWN code, Arabic name, actor, target and detail (not «every row is a login»)', opts, async () => {
	const e = await env(); const t = await mount(e); const p = await produce(e);
	const r = await t.get('limit=100', e.sa.id); assert.equal(r.status, 200, JSON.stringify(r.json));
	const items: any[] = r.json.data.items; const by = (c: string) => items.filter(i => i.eventType === c);
	const distinct = new Set(items.map(i => i.actionLabel)); assert.ok(distinct.size >= 9, `distinct labels: ${[...distinct].join(' | ')}`);
	assert.ok(by('SESSION_STARTED').length >= 1);
	// role / staff events come from the access trail with real actor + target + detail
	const roleSet = by('STAFF_ROLE_SET').find(i => i.target?.id === p.staff.id)!;
	assert.equal(roleSet.actionLabel, 'تغيير دور موظف'); assert.equal(roleSet.actor.id, e.sa.id); assert.equal(roleSet.actor.accountType, 'SUPER_ADMIN');
	assert.equal(roleSet.target.type, 'USER'); assert.ok(roleSet.target.label); assert.match(roleSet.detail, new RegExp(p.roleA.name)); assert.match(roleSet.detail, new RegExp(p.roleB.name)); assert.equal(roleSet.origin, 'ACCESS');
	const susp = by('STAFF_SUSPENDED').find(i => i.target?.id === p.staff.id)!; assert.equal(susp.severity, 'WARNING'); assert.match(susp.detail, /نشط.*موقوف/);
	const roleUp = by('ROLE_UPDATED').find(i => i.target?.id === p.roleB.id)!; assert.equal(roleUp.target.type, 'ROLE'); assert.equal(roleUp.target.label, p.roleB.name); assert.match(roleUp.detail, /أُزيلت 1/);
	assert.ok(by('ROLE_CREATED').some(i => i.target?.id === p.roleA.id));
	// settings / fee policy: actor is the SUPER_ADMIN, target is the settings / fee policy, detail from metadata, effective date separate
	const set = by('PLATFORM_SETTINGS_UPDATED')[0]; assert.equal(set.actor.id, e.sa.id); assert.equal(set.target.type, 'SETTINGS'); assert.match(set.detail, /^الإعدادات: /); assert.ok(!/channelEmail/.test(set.detail), 'key shown by its label');
	const fee = by('FEE_POLICY_SCHEDULED')[0]; assert.equal(fee.target.type, 'FEE_POLICY'); assert.match(fee.detail, /^نسخة 2/); assert.ok(fee.detailDate && !Number.isNaN(Date.parse(fee.detailDate))); assert.equal(fee.severity, 'WARNING');
	// a back-office action lives on the AFFECTED account: the actor is the admin, the target is the user
	const kyc = by('KYC_APPROVED_BY_ADMIN').find(i => i.target?.id === p.client.id)!; assert.equal(kyc.actor.id, p.staff.id); assert.equal(kyc.actionLabel, 'اعتماد توثيق الهوية'); assert.equal(kyc.target.type, 'USER'); assert.equal(kyc.account.id, p.client.id);
	// entity actions: target is the entity with its id
	const dis = by('DISPUTE_ASSIGNED')[0]; assert.equal(dis.actor.id, p.other.id); assert.equal(dis.target.type, 'DISPUTE'); assert.equal(dis.target.id, 'disp-123'); assert.equal(dis.target.typeLabel, 'نزاع');
	// own-account events have no target; IP is the real one; an unknown code is shown as the code
	const login = by('SESSION_STARTED').find(i => i.actor.id === p.other.id)!; assert.equal(login.target, null); assert.equal(login.ipAddress, '10.1.2.3'); assert.equal(login.actionLabel, 'تسجيل دخول جديد');
	assert.equal(by('LOGIN_REJECTED')[0].severity, 'WARNING');
	const unk = by('BRAND_NEW_UNMAPPED_EVENT')[0]; assert.equal(unk.actionLabel, 'BRAND_NEW_UNMAPPED_EVENT');
	// only the login rows carry the login name
	for (const i of items) if (i.eventType !== 'SESSION_STARTED') assert.notEqual(i.actionLabel, 'تسجيل دخول جديد', i.eventType);
	// filter options carry labels of the real codes
	const opt = r.json.data.eventTypeOptions.find((o: any) => o.value === 'STAFF_ROLE_SET'); assert.equal(opt.label, 'تغيير دور موظف');
});

test('PG audit trail: identity is the real row id (prefixed by its table); no event number; display order is deterministic under identical timestamps and pages never overlap', opts, async () => {
	const e = await env(); const t = await mount(e); await produce(e);
	const all = (await t.get('limit=100', e.sa.id)).json.data.items as any[];
	assert.ok(all.every(i => /^(LOG|ACCESS):[0-9a-f-]{36}$/.test(i.id) && i.eventId === i.id && !('seq' in i)));
	assert.equal(new Set(all.map(i => i.id)).size, all.length, 'ids are unique');
	// force ties: ten rows of both tables share ONE timestamp
	const when = new Date(); const staff = await e.mkUser('ADMIN', 'tie');
	for (let i = 0; i < 5; i++) await e.prisma.accountAuditLog.create({ data: { userId: staff.id, category: 'SYSTEM_AUDIT', title: 't', actionText: 'a', summary: `tie ${i}`, eventType: 'SESSION_STARTED', source: 'USER', createdAt: new Date(when.getTime() + 60_000), occurredAt: new Date(when.getTime() + 60_000) } });
	for (let i = 0; i < 5; i++) await e.prisma.adminAccessAudit.create({ data: { actorId: e.sa.id, action: 'INVITE_RESENT', at: new Date(when.getTime() + 60_000) } });
	const full = (await t.get('limit=100', e.sa.id)).json.data.items as any[];
	const tied = full.filter(i => +new Date(i.createdAt) === when.getTime() + 60_000);
	assert.equal(tied.length, 10);
	assert.deepEqual(tied.map(i => i.origin), [...Array(5).fill('ACCESS'), ...Array(5).fill('LOG')], 'ties: ACCESS before LOG');
	const ids = (rows: any[]) => rows.map(r => r.id);
	// walking the list page by page (size 3) gives exactly the unpaged order, no repeat, no gap
	const walked: string[] = []; for (let p = 1; p <= Math.ceil(full.length / 3); p++) walked.push(...ids((await t.get(`limit=3&page=${p}`, e.sa.id)).json.data.items));
	assert.deepEqual(walked.slice(0, full.length), ids(full)); assert.equal(new Set(walked).size, walked.length, "no repeat across pages");
	assert.deepEqual(ids((await t.get('limit=100', e.sa.id)).json.data.items), ids(full), 'repeatable');
});

test('PG audit trail: the same action recorded in BOTH tables is listed once (the access trail is the system of record); a real pair', opts, async () => {
	const e = await env(); const t = await mount(e); const p = await produce(e);
	const before = (await t.get('eventType=STAFF_SUSPENDED&limit=100', e.sa.id)).json.data;
	const n = before.items.filter((i: any) => i.target?.id === p.staff.id).length; assert.ok(n >= 1);
	// a mirror of the real suspension written into account_audit_logs with the access-trail code
	await e.prisma.accountAuditLog.create({ data: { userId: p.staff.id, category: 'SYSTEM_AUDIT', title: 'إيقاف موظف', actionText: 'mirror', summary: 'mirror', eventType: 'STAFF_SUSPENDED', source: 'ADMIN', actorLabel: `SUPER_ADMIN:${e.sa.id}`, metaData: { adminId: e.sa.id } } });
	const after = (await t.get('eventType=STAFF_SUSPENDED&limit=100', e.sa.id)).json.data;
	assert.equal(after.items.filter((i: any) => i.target?.id === p.staff.id).length, n, 'listed once');
	assert.ok(after.items.every((i: any) => i.origin === 'ACCESS'));
	assert.equal(after.pagination.total, before.pagination.total, 'the count does not double');
	const everything = (await t.get('limit=100', e.sa.id)).json.data; assert.equal(everything.pagination.total, everything.items.length < 100 ? everything.items.length : everything.pagination.total);
});

test('PG audit trail: severity = class table; stored WARNING honoured; an unclassified code is «UNCLASSIFIED»; the filter agrees; actors that nothing proves are «غير معروف»', opts, async () => {
	const e = await env(); const t = await mount(e); const p = await produce(e);
	const items = (await t.get('limit=100', e.sa.id)).json.data.items as any[]; const by = (c: string) => items.filter(i => i.eventType === c);
	assert.equal(by('SESSION_STARTED')[0].severity, 'INFO'); assert.equal(by('STAFF_SUSPENDED')[0].severity, 'WARNING'); assert.equal(by('ROLE_CREATED')[0].severity, 'WARNING');
	assert.equal(by('PLATFORM_SETTINGS_UPDATED')[0].severity, 'WARNING'); assert.equal(by('LOGIN_REJECTED')[0].severity, 'WARNING');
	const unk = by('BRAND_NEW_UNMAPPED_EVENT')[0]; assert.equal(unk.severity, 'UNCLASSIFIED'); assert.equal(unk.severitySource, 'none');
	// no proof of the actor: failed login and the unmapped ADMIN row
	assert.deepEqual([by('LOGIN_REJECTED')[0].actor.kind, by('LOGIN_REJECTED')[0].actor.name, by('LOGIN_REJECTED')[0].actor.id], ['UNKNOWN', 'غير معروف', null]);
	assert.equal(unk.actor.name, 'غير معروف');
	assert.equal(by('LOGIN_REJECTED')[0].target.type, 'USER');
	for (const sev of ['INFO', 'WARNING', 'CRITICAL', 'UNCLASSIFIED']) {
		const f = (await t.get(`severity=${sev}&limit=100`, e.sa.id)).json.data.items as any[];
		assert.ok(f.every(i => i.severity === sev), `${sev}: ${f.map(i => i.severity)}`);
	}
	// the four severities partition the list
	const totals = await Promise.all(['INFO', 'WARNING', 'CRITICAL', 'UNCLASSIFIED'].map(async sev => (await t.get(`severity=${sev}&limit=1`, e.sa.id)).json.data.pagination.total));
	assert.equal(totals.reduce((a: number, b: number) => a + b, 0), (await t.get('limit=1', e.sa.id)).json.data.pagination.total);
	await e.prisma.accountAuditLog.create({ data: { userId: p.other.id, category: 'SYSTEM_AUDIT', title: 't', actionText: 'a', summary: 'stored', eventType: 'SESSION_STARTED', source: 'USER', severity: 'CRITICAL' } });
	assert.ok((await t.get('severity=CRITICAL&limit=100', e.sa.id)).json.data.items.some((i: any) => i.eventType === 'SESSION_STARTED' && i.severitySource === 'stored'));
});

test('PG audit trail: details never expose secrets, whatever the stored summary / metadata holds', opts, async () => {
	const e = await env(); const t = await mount(e); const p = await produce(e);
	await e.prisma.accountAuditLog.create({ data: { userId: p.other.id, category: 'SYSTEM_AUDIT', title: 'x', actionText: 'x', summary: 'token=abcdef123456 password: Hunter2! https://x.test/reset?token=zzz 4111 1111 1111 1111 رقم عملية PayPal: 5TY05013RG002845M', eventType: 'PROFILE_UPDATED', source: 'USER', metaData: { otp: '123456', passwordHash: '$2b$10$abcdefghijklmnopqrstuv', sessionId: 'sess-secret-777', reason: 'سبب عادي' } } });
	await e.prisma.accountAuditLog.create({ data: { userId: p.other.id, category: 'SYSTEM_AUDIT', title: 'x', actionText: '', summary: '', eventType: 'SPECIALTY_ADMIN_DECISION', source: 'ADMIN', metaData: { adminId: p.staff.id, otp: '123456', apiKey: 'sk_live_abcdefghijklmnop', reason: 'مطابق للشروط' } } });
	const body = JSON.stringify((await t.get('limit=100', e.sa.id)).json.data.items);
	for (const leak of ['abcdef123456', 'Hunter2', 'token=zzz', '4111 1111', '5TY05013RG002845M', '$2b$10$', 'sess-secret-777', 'sk_live_abcdefghijklmnop', '"123456"']) assert.ok(!body.includes(leak), `leaked ${leak}`);
	assert.ok(body.includes('مطابق للشروط'));
});

test('PG audit trail: filters work on the real data - event type (also access actions), actor (both row layouts), severity, text (code, Arabic name, person) and pagination', opts, async () => {
	const e = await env(); const t = await mount(e); const p = await produce(e);
	const all = (await t.get('limit=100', e.sa.id)).json.data;
	// event type
	const ty = (await t.get('eventType=ROLE_CREATED&limit=100', e.sa.id)).json.data; assert.ok(ty.items.length >= 2); assert.ok(ty.items.every((i: any) => i.eventType === 'ROLE_CREATED'));
	// actor: the admin who DID it, also when the row lives on the affected account
	const byStaff = (await t.get(`actorId=${p.staff.id}&limit=100`, e.sa.id)).json.data.items as any[];
	assert.ok(byStaff.some(i => i.eventType === 'KYC_APPROVED_BY_ADMIN' && i.target.id === p.client.id), 'KYC done by staff, written on the client');
	assert.ok(byStaff.every(i => i.actor.id === p.staff.id), 'only rows whose actor is staff'); assert.ok(!byStaff.some(i => i.eventType === 'STAFF_SUSPENDED'), 'staff was the SUBJECT of those, not the actor');
	const bySa = (await t.get(`actorId=${e.sa.id}&limit=100`, e.sa.id)).json.data.items as any[]; assert.ok(bySa.some(i => i.eventType === 'STAFF_SUSPENDED') && bySa.some(i => i.eventType === 'PLATFORM_SETTINGS_UPDATED') && bySa.every(i => i.actor.id === e.sa.id));
	const byClient = (await t.get(`actorId=${p.client.id}&limit=100`, e.sa.id)).json.data.items as any[]; assert.equal(byClient.length, 0, 'the client was only affected, never the actor');
	// severity
	const warn = (await t.get('severity=WARNING&limit=100', e.sa.id)).json.data.items as any[]; assert.ok(warn.length >= 3 && warn.every(i => i.severity === 'WARNING'));
	assert.ok(warn.some(i => i.eventType === 'STAFF_SUSPENDED') && warn.some(i => i.eventType === 'LOGIN_REJECTED'));
	assert.equal((await t.get('severity=CRITICAL&limit=100', e.sa.id)).json.data.items.filter((i: any) => i.origin === 'ACCESS').length, 0);
	// text: Arabic action name, code and person name
	assert.ok((await t.get(`q=${encodeURIComponent('إيقاف موظف')}&limit=100`, e.sa.id)).json.data.items.some((i: any) => i.eventType === 'STAFF_SUSPENDED'));
	assert.ok((await t.get('q=staff_role&limit=100', e.sa.id)).json.data.items.every((i: any) => /STAFF_ROLE/.test(i.eventType)));
	const u = await e.prisma.user.findUniqueOrThrow({ where: { id: p.staff.id } });
	assert.ok((await t.get(`q=${encodeURIComponent(u.firstName)}&limit=100`, e.sa.id)).json.data.items.some((i: any) => i.actor.id === p.staff.id || i.target?.id === p.staff.id));
	// pagination: pages are disjoint, ordered newest first, and the total covers both tables
	const total = all.pagination.total; const a = (await t.get('limit=5&page=1', e.sa.id)).json.data, b = (await t.get('limit=5&page=2', e.sa.id)).json.data;
	assert.equal(a.pagination.total, total); assert.ok(a.pagination.pages >= 2); assert.equal(a.items.length, 5);
	assert.equal(new Set([...a.items, ...b.items].map((i: any) => i.id)).size, 10);
	assert.ok(+new Date(a.items[4].occurredAt) >= +new Date(b.items[0].occurredAt));
	assert.deepEqual([...a.items, ...b.items].map((i: any) => i.id), all.items.slice(0, 10).map((i: any) => i.id), 'same order as the unpaged list');
});

test('PG audit trail: the audit permission still gates the list (no audit.view -> 403)', opts, async () => {
	const e = await env(); const t = await mount(e); const { user: nope } = await mkStaff(e, ['users.view'], 'noaudit'); const { user: yes } = await mkStaff(e, ['audit.view'], 'audit');
	assert.equal((await t.get('limit=5', nope.id)).status, 403); assert.equal((await t.get('limit=5', yes.id)).status, 200);
});
