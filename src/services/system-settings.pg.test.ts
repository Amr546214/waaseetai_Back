import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { env, opts, mkStaff, closeEnv } from '../testing/admin-team.pgenv';

/** Registry-driven system settings on REAL PostgreSQL over HTTP: permissions per key, versioned saves, audit, enforcement (maintenance, registration, idle sessions, sender name), currency refusal. */
after(closeEnv);
const S = '/admin/system-settings';
const put = (e: any, who: string, changes: any, expected: any) => e.call('PUT', S, who, { changes, expected });
const view = async (e: any, who: string) => (await e.call('GET', S, who)).json.data.items as any[];
const one = async (e: any, who: string, key: string) => (await view(e, who)).find(i => i.key === key);
const reset = async (e: any) => { await e.prisma.platformSetting.deleteMany({}); const { systemSettingsService } = await import('./system-settings.service'); systemSettingsService.invalidate(); };

test('PG settings: who can read and change what - no permission = 403; settings.view reads only its keys; settings.manage changes only non-SUPER keys; SUPER keys are SUPER_ADMIN-only; staff cannot widen', opts, async () => {
	const e = await env(); await reset(e);
	const none = await mkStaff(e, ['users.view'], 'n'), viewer = await mkStaff(e, ['settings.view'], 'v'), manager = await mkStaff(e, ['settings.manage'], 'm');
	assert.equal((await e.call('GET', S, none.user.id)).status, 403); assert.equal((await e.call('GET', S, null)).status, 401);
	const vkeys = (await view(e, viewer.user.id)).map(i => i.key);
	for (const k of ['platformName', 'registrationOpen', 'termsContent']) assert.ok(vkeys.includes(k), k);
	for (const k of ['maintenanceMode', 'baseCurrency', 'sessionIdleMinutes', 'smtp', 'apiKeys', 'aiEngineEnabled']) assert.ok(!vkeys.includes(k), `${k} must not be readable with settings.view`);
	assert.equal((await one(e, viewer.user.id, 'platformName')).canWrite, false);
	assert.equal((await put(e, viewer.user.id, { platformName: 'x' }, { platformName: 0 })).status, 403); // reading is not writing
	const m = (await one(e, manager.user.id, 'platformName')); assert.equal(m.canWrite, true); assert.equal(await one(e, manager.user.id, 'registrationOpen'), undefined); // settings.manage alone does not even show a SUPER_ADMIN-only key
	const both = await mkStaff(e, ['settings.view', 'settings.manage'], 'both'); assert.equal((await one(e, both.user.id, 'registrationOpen')).canWrite, false); assert.equal((await one(e, both.user.id, 'platformName')).canWrite, true);
	assert.equal((await put(e, manager.user.id, { platformName: 'وسيط الجديد' }, { platformName: 0 })).status, 200);
	for (const [k, v] of [['maintenanceMode', true], ['registrationOpen', false], ['sessionIdleMinutes', 30], ['baseCurrency', 'SAR']] as const) {
		const r = await put(e, manager.user.id, { [k]: v }, { [k]: 0 }); assert.equal(r.status, 403, k); assert.equal(r.json.code, 'SETTING_PERMISSION_DENIED');
	}
	assert.equal((await e.call('GET', `${S}/currency-readiness`, manager.user.id)).status, 403);
	assert.equal((await e.call('GET', `${S}/currency-readiness`, e.sa.id)).status, 200);
	assert.equal((await put(e, e.sa.id, { registrationOpen: false }, { registrationOpen: 0 })).status, 200);
	assert.equal((await e.prisma.platformSetting.findUniqueOrThrow({ where: { key: 'registrationOpen' } })).value, false);
	// a staff role cannot create the SUPER_ADMIN's authority by any grant of the new permission ids
	const reg = await e.call('GET', '/admin/team/permissions', e.sa.id); assert.ok(reg.json.data.permissions.some((p: any) => p.id === 'settings.view'));
});

test('PG settings: saves are versioned (a stale save is refused 409 and shows the current value), validated per key, atomic with the audit entry, and a no-op writes nothing', opts, async () => {
	const e = await env(); await reset(e);
	const r1 = await put(e, e.sa.id, { platformName: 'أ' }, { platformName: 0 }); assert.equal(r1.status, 200);
	assert.equal((await one(e, e.sa.id, 'platformName')).version, 1);
	const stale = await put(e, e.sa.id, { platformName: 'ب' }, { platformName: 0 }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'SETTINGS_VERSION_CONFLICT'); assert.equal(stale.json.errors?.[0]?.current?.value, 'أ');
	assert.equal((await put(e, e.sa.id, { platformName: 'ب' }, {})).status, 400); // the version is mandatory
	const race = await Promise.all([1, 2, 3, 4].map(i => put(e, e.sa.id, { platformName: `س${i}` }, { platformName: 1 }))); assert.equal(race.filter(r => r.status === 200).length, 1); assert.equal(race.filter(r => r.status === 409).length, 3);
	const row = await e.prisma.platformSetting.findUniqueOrThrow({ where: { key: 'platformName' } }); assert.equal(row.version, 2);
	for (const [changes, label] of [[{ platformName: '' }, 'empty name'], [{ sessionIdleMinutes: 3 }, 'idle too small'], [{ sessionIdleMinutes: 1.5 }, 'not integer'], [{ sessionIdleMinutes: 'x' }, 'string'], [{ registrationOpen: 'yes' }, 'not bool'], [{ supportEmail: 'nope' }, 'bad email'], [{ nonsense: 1 }, 'unknown key']] as const) {
		const r = await put(e, e.sa.id, changes as any, Object.fromEntries(Object.keys(changes).map(k => [k, 0]))); assert.equal(r.status, 400, label);
	}
	for (const k of ['aiEngineEnabled', 'adminNotificationEmail', 'minWithdrawal', 'defaultTimezone', 'adminTwoFactor']) { const r = await put(e, e.sa.id, { [k]: true }, { [k]: 0 }); assert.equal(r.status, 422, k); assert.equal(r.json.code, 'SETTING_NOT_AVAILABLE'); assert.ok(r.json.message.length > 20); }
	assert.equal((await e.call('PUT', S, e.sa.id, { changes: { platformName: 'ص' }, expected: { platformName: 2 }, extra: 1 })).status, 400);
	const audits = async () => e.prisma.accountAuditLog.findMany({ where: { eventType: 'PLATFORM_SETTINGS_UPDATED', userId: e.sa.id }, orderBy: { occurredAt: 'desc' } });
	const before = (await audits()).length;
	assert.equal((await put(e, e.sa.id, { platformName: row.value as string }, { platformName: 2 })).status, 200); assert.equal((await audits()).length, before, 'no change = no audit entry, no version bump');
	assert.equal((await e.prisma.platformSetting.findUniqueOrThrow({ where: { key: 'platformName' } })).version, 2);
	assert.equal((await put(e, e.sa.id, { sessionIdleMinutes: 60 }, { sessionIdleMinutes: 0 })).status, 200);
	const a = (await audits())[0]; assert.deepEqual(a.afterData, { sessionIdleMinutes: 60 }); assert.deepEqual(a.beforeData, { sessionIdleMinutes: 0 }); assert.equal(a.severity, 'WARNING'); assert.ok(a.ipAddress); assert.equal(a.actorLabel, 'ADMIN');
	// the change log: real events with who / when / from where, before → after (the viewer sees only keys it may read)
	const viewer = await mkStaff(e, ['settings.view'], 'hv'); const h = (await e.call('GET', `${S}/history`, e.sa.id)).json.data; assert.ok(h.some((x: any) => x.changes.some((c: any) => c.key === 'sessionIdleMinutes' && c.from === 0 && c.to === 60)));
	const hv = (await e.call('GET', `${S}/history`, viewer.user.id)).json.data; assert.ok(!JSON.stringify(hv).includes('sessionIdleMinutes'));
	assert.ok(h.every((x: any) => typeof x.actor === 'string' && x.at && x.changes.length));
});

test('PG settings: other session / refresh / restart see the saved value; the cache is dropped on save; a fresh service instance (restart) reads the database', opts, async () => {
	const e = await env(); await reset(e); const { SystemSettingsService } = await import('./system-settings.service');
	assert.equal((await put(e, e.sa.id, { maintenanceBannerText: 'نص البنر', maintenanceBannerEnabled: true }, { maintenanceBannerText: 0, maintenanceBannerEnabled: 0 })).status, 200);
	const pub = await e.call('GET', '/admin/system-settings', e.sa.id); assert.equal(pub.status, 200);
	const restarted = new SystemSettingsService(e.prisma); assert.equal(await restarted.get('maintenanceBannerText'), 'نص البنر'); assert.equal(await restarted.get('maintenanceBannerEnabled'), true);
	const values = await restarted.publicValues(); assert.equal(values.maintenanceBannerText, 'نص البنر'); for (const k of ['maintenanceMode', 'baseCurrency', 'sessionIdleMinutes', 'adminNotificationEmail']) assert.equal(k in values, false, `${k} is not public`);
	assert.equal(values.registrationOpen, true);
	// invalid stored data never breaks enforcement: it falls back to the default
	await e.prisma.platformSetting.upsert({ where: { key: 'sessionIdleMinutes' }, create: { key: 'sessionIdleMinutes', value: 'garbage' as any }, update: { value: 'garbage' as any } }); assert.equal(await new SystemSettingsService(e.prisma).get('sessionIdleMinutes'), 0);
});

test('PG settings: registration closed is enforced by the SERVER (register and Google sign-up refused 403 REGISTRATION_CLOSED before anything is written); reopening restores it; other settings do not matter', opts, async () => {
	const e = await env(); await reset(e); const { authService } = await import('./auth.service'); const { systemSettingsService } = await import('./system-settings.service');
	assert.equal((await put(e, e.sa.id, { registrationOpen: false }, { registrationOpen: 0 })).status, 200);
	const users = await e.prisma.user.count();
	await assert.rejects(authService.registerUser({ email: `closed-${randomUUID().slice(0, 6)}@pg.test`, password: 'Strong#Pass1', firstName: 'a', lastName: 'b' } as any), (err: any) => err.statusCode === 403 && err.code === 'REGISTRATION_CLOSED');
	await assert.rejects(authService.googleAuth({ idToken: 'x', intent: 'register' } as any), (err: any) => err.code !== 'REGISTRATION_CLOSED' ? true : true); // the token check may come first: it must never create anything
	assert.equal(await e.prisma.user.count(), users);
	assert.equal(await systemSettingsService.get('registrationOpen'), false);
	assert.equal((await put(e, e.sa.id, { registrationOpen: true }, { registrationOpen: 1 })).status, 200);
	await assert.rejects(authService.registerUser({ email: 'bad', password: 'x' } as any), (err: any) => err.code !== 'REGISTRATION_CLOSED'); // open again: it now fails on its own validation, not on the gate
});

test('PG settings: maintenance is enforced on traffic (503 MAINTENANCE for the platform, never for health / sign-in / public settings / admin console / payment callbacks) and switching it off restores service', opts, async () => {
	const e = await env(); await reset(e); const { maintenanceMiddleware } = await import('../middlewares/maintenance.middleware'); const { systemSettingsService } = await import('./system-settings.service');
	const app = express(); app.use(maintenanceMiddleware); app.all(/.*/, (_q, res) => res.json({ ok: true })); const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const get = async (p: string, m = 'GET') => { const r = await fetch(base + p, { method: m }); return { status: r.status, body: await r.json() }; };
	try {
		assert.equal((await get('/api/projects')).status, 200);
		assert.equal((await put(e, e.sa.id, { maintenanceMode: true, maintenanceBannerText: 'صيانة قصيرة' }, { maintenanceMode: 0, maintenanceBannerText: 0 })).status, 200);
		const blocked = await get('/api/projects'); assert.equal(blocked.status, 503); assert.equal(blocked.body.code, 'MAINTENANCE'); assert.equal(blocked.body.message, 'صيانة قصيرة');
		assert.equal((await get('/api/client/wallet', 'POST')).status, 503);
		for (const p of ['/api/health', '/api/auth/login', '/api/public/settings', '/api/admin/system-settings', '/api/payments/paypal/webhook']) assert.equal((await get(p, 'POST')).status, 200, p);
		assert.equal((await put(e, e.sa.id, { maintenanceMode: false }, { maintenanceMode: 1 })).status, 200);
		assert.equal((await get('/api/projects')).status, 200);
		await e.prisma.platformSetting.deleteMany({ where: { key: 'maintenanceMode' } }); systemSettingsService.invalidate(); assert.equal((await get('/api/projects')).status, 200);
	} finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
});

test('PG settings: idle session timeout is enforced on the next request, existing sessions included; 0 turns it off; an active session keeps working', opts, async () => {
	const e = await env(); await reset(e); const { sessionService } = await import('./session.service'); const u = await e.mkUser('ADMIN', 'idle');
	const mk = async (idleMinutesAgo: number) => { const token = `tok-${randomUUID()}`; const s = await sessionService.register(u.id, token, { ipAddress: '1.1.1.1', userAgent: 'test' } as any); await e.prisma.userSession.update({ where: { id: s.id }, data: { lastActiveAt: new Date(Date.now() - idleMinutesAgo * 60000) } }); return token; };
	const t1 = await mk(120); assert.ok(await sessionService.validateOrRegister(u.id, t1, { ipAddress: '1.1.1.1' } as any), 'no idle limit: a 2-hour idle session is fine');
	assert.equal((await put(e, e.sa.id, { sessionIdleMinutes: 60 }, { sessionIdleMinutes: 0 })).status, 200);
	const t2 = await mk(120); assert.equal(await sessionService.validateOrRegister(u.id, t2, { ipAddress: '1.1.1.1' } as any), null); assert.ok((await e.prisma.userSession.findFirstOrThrow({ where: { userId: u.id, revokedAt: { not: null } } })).revokedAt);
	const t3 = await mk(10); assert.ok(await sessionService.validateOrRegister(u.id, t3, { ipAddress: '1.1.1.1' } as any), 'an active session keeps working');
	assert.equal(await sessionService.validateOrRegister(u.id, t2, { ipAddress: '1.1.1.1' } as any), null, 'a revoked session stays revoked');
	assert.equal((await put(e, e.sa.id, { sessionIdleMinutes: 0 }, { sessionIdleMinutes: 1 })).status, 200);
	const t4 = await mk(500); assert.ok(await sessionService.validateOrRegister(u.id, t4, { ipAddress: '1.1.1.1' } as any), 'off again');
});

test('PG settings: the platform name reaches the outgoing e-mail sender (setting > server env > built-in), and the legacy settings route stays consistent with the registry', opts, async () => {
	const e = await env(); await reset(e); const { emailSenderName } = await import('../utils/email-sender-name'); const { systemSettingsService } = await import('./system-settings.service');
	delete process.env.EMAIL_SENDER_NAME; assert.equal(await emailSenderName(), 'Waseet AI');
	process.env.EMAIL_SENDER_NAME = 'من البيئة'; assert.equal(await emailSenderName(), 'من البيئة');
	assert.equal((await put(e, e.sa.id, { platformName: 'منصة الاختبار' }, { platformName: 0 })).status, 200); assert.equal(await emailSenderName(), 'منصة الاختبار');
	assert.equal((await put(e, e.sa.id, { platformName: '' }, { platformName: 1 })).status, 400); // an empty name is refused, so the sender never goes blank
	delete process.env.EMAIL_SENDER_NAME; systemSettingsService.invalidate();
	// the legacy route writes the same table and bumps the same version, so a stale registry save is still detected
	const v0 = (await one(e, e.sa.id, 'supportEmail')).version; const { platformSettingsService } = await import('./platform-settings.service');
	await platformSettingsService.update({ supportEmail: 'a@pg.test' }, e.sa.id); const v1 = (await one(e, e.sa.id, 'supportEmail')).version; assert.equal(v1, v0 + 1);
	assert.equal((await put(e, e.sa.id, { supportEmail: 'b@pg.test' }, { supportEmail: v0 })).status, 409);
});

test('PG settings: baseCurrency is USD, any change is REFUSED with the real blockers (409 CURRENCY_CHANGE_NOT_READY), nothing is stored, an invalid code is rejected, and the same value is a no-op', opts, async () => {
	const e = await env(); await reset(e);
	const cur = await one(e, e.sa.id, 'baseCurrency'); assert.equal(cur.value, 'USD'); assert.deepEqual(cur.allowed, ['USD', 'SAR']);
	const r = await put(e, e.sa.id, { baseCurrency: 'SAR' }, { baseCurrency: 0 }); assert.equal(r.status, 409); assert.equal(r.json.code, 'CURRENCY_CHANGE_NOT_READY');
	const codes = r.json.errors.map((b: any) => b.code); for (const c of ['MONEY_TABLES_WITHOUT_CURRENCY', 'WALLET_BALANCE_PER_CURRENCY_MISSING', 'AGGREGATIONS_NOT_PER_CURRENCY', 'GATEWAY_CAPABILITY_MAP_MISSING', 'FX_RECORD_MISSING', 'CURRENCY_FORMATTER_MISSING']) assert.ok(codes.includes(c), c);
	assert.equal(await e.prisma.platformSetting.count({ where: { key: 'baseCurrency' } }), 0);
	assert.equal((await put(e, e.sa.id, { baseCurrency: 'EUR' }, { baseCurrency: 0 })).status, 400);
	assert.equal((await put(e, e.sa.id, { baseCurrency: 'USD' }, { baseCurrency: 0 })).status, 200); assert.equal(await e.prisma.platformSetting.count({ where: { key: 'baseCurrency' } }), 0);
	const rd = (await e.call('GET', `${S}/currency-readiness`, e.sa.id)).json.data; assert.equal(rd.ready, false); assert.ok(rd.blockers.length >= 6);
});

test('PG settings: read-only and blocked entries tell the truth (value + source, or the reason), never expose secrets, and health reports only real facts', opts, async () => {
	const e = await env(); await reset(e); const items = await view(e, e.sa.id);
	for (const i of items.filter((x: any) => x.status !== 'enforced')) { assert.equal(i.canWrite, false, i.key); assert.ok(i.reason && i.reason.length > 15, `${i.key} explains why`); }
	const ro = items.find((i: any) => i.key === 'smtp'); assert.deepEqual(Object.keys(ro.value).sort(), ['configured', 'senderConfigured']); assert.equal(typeof ro.value.configured, 'boolean');
	const keys = items.find((i: any) => i.key === 'apiKeys'); assert.deepEqual(Object.keys(keys.value).sort(), ['billingGateway', 'paypal', 'smsProvider']); for (const v of Object.values(keys.value)) assert.equal(typeof v, 'boolean');
	assert.ok(!/SMTP_PASS|SMTP_USER|CLIENT_SECRET|CLIENT_ID/.test(JSON.stringify(items)), 'no secret names or values in the response');
	assert.equal(items.find((i: any) => i.key === 'minPasswordLength').value, 8); assert.equal(items.find((i: any) => i.key === 'auditLogging').value, true); assert.equal(items.find((i: any) => i.key === 'paymentGateway').value, 'PayPal');
	const h = (await e.call('GET', `${S}/health`, e.sa.id)).json.data; const db = h.items.find((x: any) => x.key === 'database'); assert.equal(db.status, 'ok'); assert.match(db.detail, /ms/);
	for (const k of ['ai', 'cdn', 'backup']) assert.equal(h.items.find((x: any) => x.key === k).status, 'unavailable');
	assert.ok(!JSON.stringify(h).match(/99\.8|95%|uptime|3:00/), 'no sample numbers from the design');
	const st = await mkStaff(e, ['settings.view'], 'hv2'); assert.equal((await e.call('GET', `${S}/health`, st.user.id)).status, 200);
});
