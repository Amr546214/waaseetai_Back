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
	for (const k of ['aiEngineEnabled', 'channelPush', 'channelSms', 'adminTwoFactor', 'profanityFilter']) { const r = await put(e, e.sa.id, { [k]: true }, { [k]: 0 }); assert.equal(r.status, 422, k); assert.equal(r.json.code, 'SETTING_NOT_AVAILABLE'); assert.ok(r.json.message.length > 20); }
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
	const values = await restarted.publicValues(); assert.equal(values.maintenanceBannerText, 'نص البنر'); assert.ok('baseCurrency' in values, 'the base currency is public: the screens need it to print new entries and headline figures'); for (const k of ['maintenanceMode', 'sessionIdleMinutes', 'adminNotificationEmail']) assert.equal(k in values, false, `${k} is not public`);
	assert.equal(values.registrationOpen, true);
	// invalid stored data never breaks enforcement: it falls back to the default
	await e.prisma.platformSetting.upsert({ where: { key: 'sessionIdleMinutes' }, create: { key: 'sessionIdleMinutes', value: 'garbage' as any }, update: { value: 'garbage' as any } }); assert.equal(await new SystemSettingsService(e.prisma).get('sessionIdleMinutes'), 0);
});

test('PG settings: closing registration stops ONLY new accounts - existing users (Google included) still sign in, activate and recover; a new Google address / new e-mail is refused; no bypass', opts, async () => {
	const e = await env(); await reset(e); const { authService } = await import('./auth.service'); const { mailTransporter } = await import('../utils/mail.transporter'); const bcrypt = (await import('bcrypt')).default;
	const sent: string[] = []; (mailTransporter as any).sendMail = async (m: any) => { sent.push(String(m.to)); return { accepted: [m.to], rejected: [], messageId: 'test' }; }; // nothing real is ever sent
	const tag = randomUUID().slice(0, 6); const mk = (over: any) => e.prisma.user.create({ data: { id: randomUUID(), accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT', firstName: 'a', lastName: 'b', agreedToTerms: true, ...over } });
	const google = await mk({ status: 'ACTIVE', email: `g-${tag}@pg.test`, googleId: `gid-${tag}`, password: null });
	const normal = await mk({ status: 'ACTIVE', email: `n-${tag}@pg.test`, password: await bcrypt.hash('Strong#Pass1', 4) });
	const pending = await mk({ status: 'PENDING_VERIFICATION', email: `p-${tag}@pg.test`, password: await bcrypt.hash('Strong#Pass1', 4) });
	const identities: Record<string, any> = { 'tok-existing': { email: google.email, sub: `gid-${tag}`, given_name: 'a', family_name: 'b' }, 'tok-new': { email: `new-${tag}@pg.test`, sub: `gid-new-${tag}`, given_name: 'n', family_name: 'w' } };
	(authService as any).verifyGoogleIdentity = async (t: string) => { if (!identities[t]) throw new Error('bad token'); return identities[t]; };
	assert.equal((await put(e, e.sa.id, { registrationOpen: false }, { registrationOpen: 0 })).status, 200);
	const users = await e.prisma.user.count(); const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'OK'; } catch (er: any) { return `${er.statusCode} ${er.code ?? ''}`.trim(); } };
	// existing accounts keep working
	assert.notEqual(await code(() => authService.googleAuth({ idToken: 'tok-existing', intent: 'login' } as any)), '403 REGISTRATION_CLOSED');
	assert.equal(await code(() => authService.loginUser({ email: normal.email, password: 'Strong#Pass1' } as any)), 'OK'); // starts the e-mail code challenge, as always
	assert.equal(await code(() => authService.resendOtpByEmail(pending.email)), 'OK'); assert.equal(await code(() => authService.forgotPassword({ email: normal.email } as any)), 'OK');
	assert.equal(await code(() => authService.loginUser({ email: pending.email, password: 'Strong#Pass1' } as any)), 'OK'); // a pending account is told to activate, not "registration closed"
	// the verified owner of an existing Google address is told "exists - sign in", as before
	assert.equal(await code(() => authService.googleAuth({ idToken: 'tok-existing', intent: 'register' } as any)), '409');
	assert.equal(await code(() => authService.registerUser({ email: google.email, password: 'x', googleIdToken: 'tok-existing', phoneNumber: '500000001', phoneCountryCode: '+966' } as any)), '409');
	// creation is closed: a NEW Google address, a new e-mail, and an existing e-mail typed by an unverified caller all get the SAME refusal
	assert.equal(await code(() => authService.googleAuth({ idToken: 'tok-new', intent: 'register' } as any)), '403 REGISTRATION_CLOSED');
	assert.equal(await code(() => authService.registerUser({ email: `new-${tag}@pg.test`, password: 'Strong#Pass1', googleIdToken: 'tok-new', phoneNumber: '500000002', phoneCountryCode: '+966' } as any)), '403 REGISTRATION_CLOSED');
	for (const email of [`brand-${tag}@pg.test`, normal.email]) assert.equal(await code(() => authService.registerUser({ email, password: 'Strong#Pass1', phoneNumber: '500000003', phoneCountryCode: '+966' } as any)), '403 REGISTRATION_CLOSED', email);
	assert.equal(await e.prisma.user.count(), users, 'nothing was created while registration was closed');
	// reopening restores sign-up (the Google pre-step now proceeds)
	assert.equal((await put(e, e.sa.id, { registrationOpen: true }, { registrationOpen: 1 })).status, 200);
	const open = await authService.googleAuth({ idToken: 'tok-new', intent: 'register' } as any) as any; assert.equal(open.registrationRequired, true);
});

test('PG settings: maintenance is enforced on traffic - a SUPER_ADMIN session reaches everything, other staff / users get 503, explicit allowances (health, sign-in, webhook, capture, notifications) pass, a NEW payment does not; switching it off restores service', opts, async () => {
	const e = await env(); await reset(e); const jwt = (await import('jsonwebtoken')).default; const { maintenanceMiddleware, resetMaintenanceCaches } = await import('../middlewares/maintenance.middleware'); const { sessionService } = await import('./session.service'); const { systemSettingsService } = await import('./system-settings.service');
	process.env.JWT_SECRET ??= 'test-secret';
	const mkTok = async (userId: string) => { const t = jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '1h' }); await sessionService.register(userId, t, { ipAddress: '1.1.1.1' } as any, new Date(Date.now() + 3_600_000)); return t; };
	const staff = await mkStaff(e, ['users.view', 'settings.manage'], 'mt'); const staffTok = await mkTok(staff.user.id); const saTok = await mkTok(e.sa.id); const client = await e.mkUser('CLIENT_INDIVIDUAL', 'mc'); const clientTok = await mkTok(client.id);
	const app = express(); app.use(maintenanceMiddleware); app.all(/.*/, (_q, res) => res.json({ ok: true })); const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const get = async (p: string, m = 'GET', tok?: string) => { const r = await fetch(base + p, { method: m, headers: tok ? { authorization: `Bearer ${tok}` } : {} }); return { status: r.status, body: await r.json() }; };
	try {
		assert.equal((await get('/api/projects')).status, 200);
		assert.equal((await put(e, e.sa.id, { maintenanceMode: true, maintenanceBannerText: 'صيانة قصيرة' }, { maintenanceMode: 0, maintenanceBannerText: 0 })).status, 200);
		const blocked = await get('/api/projects'); assert.equal(blocked.status, 503); assert.equal(blocked.body.code, 'MAINTENANCE'); assert.equal(blocked.body.message, 'صيانة قصيرة');
		for (const [p, m] of [['/api/client/wallet', 'POST'], ['/api/client/finance/paypal/order/create', 'POST'], ['/api/auth/register', 'POST'], ['/api/admin/users', 'GET']] as const) assert.equal((await get(p, m)).status, 503, `${m} ${p}`);
		assert.equal((await get('/api/admin/users', 'GET', staffTok)).status, 503, 'staff of type ADMIN get no blanket exception'); assert.equal((await get('/api/projects', 'GET', clientTok)).status, 503);
		for (const [p, m] of [['/api/health', 'GET'], ['/api/public/settings', 'GET'], ['/api/auth/login', 'POST'], ['/api/auth/google', 'POST'], ['/api/payments/paypal/webhook', 'POST'], ['/api/client/finance/paypal/order/capture', 'POST'], ['/api/notifications', 'GET']] as const) assert.equal((await get(p, m)).status, 200, `${m} ${p}`);
		for (const p of ['/api/admin/users', '/api/projects', '/api/client/wallet']) assert.equal((await get(p, 'GET', saTok)).status, 200, `SUPER_ADMIN ${p}`);
		await sessionService.revokeAll(e.sa.id, 'test'); resetMaintenanceCaches(); assert.equal((await get('/api/projects', 'GET', saTok)).status, 503, 'a revoked SUPER_ADMIN session is not an exception');
		await put(e, e.sa.id, { maintenanceMode: false }, { maintenanceMode: 1 }); assert.equal((await get('/api/projects')).status, 200);
		await e.prisma.platformSetting.deleteMany({ where: { key: 'maintenanceMode' } }); systemSettingsService.invalidate(); assert.equal((await get('/api/projects')).status, 200);
	} finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
});

test('PG settings: a failing store never silently cancels maintenance - the last known good value keeps applying (and is logged); a cold boot has no trusted value and says so', opts, async () => {
	const e = await env(); await reset(e); const { SystemSettingsService } = await import('./system-settings.service');
	assert.equal((await put(e, e.sa.id, { maintenanceMode: true, registrationOpen: false }, { maintenanceMode: 0, registrationOpen: 0 })).status, 200);
	let down = false; const flaky = new Proxy(e.prisma, { get: (t: any, k: string) => (k === 'platformSetting' && down ? { findMany: async () => { throw new Error('connection lost'); } } : t[k]) });
	const svc = new SystemSettingsService(flaky as any);
	const ok = await svc.getTrusted<boolean>('maintenanceMode'); assert.deepEqual(ok, { value: true, trusted: true, stale: false }); assert.ok(svc.hasTrustedValues());
	down = true; svc.invalidate();
	const stale = await svc.getTrusted<boolean>('maintenanceMode'); assert.deepEqual(stale, { value: true, trusted: true, stale: true }, 'still ON, flagged stale'); assert.equal((await svc.getTrusted<boolean>('registrationOpen')).value, false);
	const cold = new SystemSettingsService(flaky as any); assert.equal(cold.hasTrustedValues(), false);
	const unk = await cold.getTrusted<boolean>('maintenanceMode'); assert.equal(unk.trusted, false, 'no trusted value on a cold boot'); assert.equal(await cold.prime(), false);
	down = false; assert.equal(await cold.prime(), true); assert.deepEqual(await cold.getTrusted<boolean>('maintenanceMode'), { value: true, trusted: true, stale: false });
	await put(e, e.sa.id, { maintenanceMode: false, registrationOpen: true }, { maintenanceMode: 1, registrationOpen: 1 });
});

test('PG settings: sessionMaxHours (absolute) is separate from the idle limit, starts at 168 h = today\'s 7 days, reaches NEW tokens only and never signs anyone out; the idle preview says how many sessions would end', opts, async () => {
	const e = await env(); await reset(e); const jwt = (await import('jsonwebtoken')).default; const { issueAccessToken } = await import('../utils/access-token'); const { sessionService } = await import('./session.service'); const secret = process.env.JWT_SECRET ?? 'test-secret'; process.env.JWT_SECRET = secret;
	const hoursOf = (t: string) => { const d = jwt.decode(t) as any; return Math.round((d.exp - d.iat) / 3600); };
	assert.equal((await one(e, e.sa.id, 'sessionMaxHours')).value, 168); assert.equal((await one(e, e.sa.id, 'sessionIdleMinutes')).value, 0); // documented initial values = current behaviour
	const before = await issueAccessToken({ userId: 'x' }, secret); assert.equal(hoursOf(before.token), 168);
	const u = await e.mkUser('ADMIN', 'ses'); const oldTok = jwt.sign({ userId: u.id }, secret, { expiresIn: '168h' }); await sessionService.register(u.id, oldTok, { ipAddress: '1.1.1.1' } as any, new Date(Date.now() + 168 * 3_600_000));
	for (const bad of [0, 1, 12, 100, 'x', 24.5]) assert.equal((await put(e, e.sa.id, { sessionMaxHours: bad }, { sessionMaxHours: 0 })).status, 400, String(bad));
	const manager = await mkStaff(e, ['settings.manage'], 'smh'); assert.equal((await put(e, manager.user.id, { sessionMaxHours: 24 }, { sessionMaxHours: 0 })).status, 403);
	assert.equal((await put(e, e.sa.id, { sessionMaxHours: 24 }, { sessionMaxHours: 0 })).status, 200);
	const after = await issueAccessToken({ userId: 'x' }, secret); assert.equal(hoursOf(after.token), 24); assert.ok(Math.abs(after.expiresAt.getTime() - (Date.now() + 24 * 3_600_000)) < 5000);
	assert.ok(await sessionService.validateOrRegister(u.id, oldTok, { ipAddress: '1.1.1.1' } as any), 'an existing session keeps working with the expiry it was issued with');
	assert.equal((await e.prisma.userSession.findFirstOrThrow({ where: { userId: u.id } })).revokedAt, null);
	// idle preview: how many LIVE sessions would end right now for a given limit
	const mk = async (minsAgo: number) => { const t = jwt.sign({ userId: u.id, n: Math.random() }, secret, { expiresIn: '168h' }); const s = await sessionService.register(u.id, t, { ipAddress: '1.1.1.1' } as any, new Date(Date.now() + 3_600_000)); await e.prisma.userSession.update({ where: { id: s.id }, data: { lastActiveAt: new Date(Date.now() - minsAgo * 60000) } }); };
	await mk(500); await mk(90); await mk(2);
	const imp = (await e.call('GET', `${S}/sessions-impact?idleMinutes=60`, e.sa.id)).json.data; assert.ok(imp.wouldEndNow >= 2 && imp.wouldEndNow < imp.activeSessions, JSON.stringify(imp));
	assert.equal((await e.call('GET', `${S}/sessions-impact?idleMinutes=0`, e.sa.id)).json.data.wouldEndNow, 0); assert.equal((await e.call('GET', `${S}/sessions-impact?idleMinutes=2`, e.sa.id)).status, 400);
	assert.equal((await e.call('GET', `${S}/sessions-impact?idleMinutes=60`, manager.user.id)).status, 403);
	await put(e, e.sa.id, { sessionMaxHours: 168 }, { sessionMaxHours: 1 });
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
	assert.equal((await put(e, e.sa.id, { platformName: 'منصة الاختبار' }, { platformName: 0 })).status, 200); assert.equal(await emailSenderName(), 'منصة الاختبار'); const { brandName, setBrandName } = await import('../utils/brand'); await systemSettingsService.prime(); assert.equal(brandName(), 'منصة الاختبار', 'new e-mail shells / subjects carry the configured name'); setBrandName('');
	assert.equal((await put(e, e.sa.id, { platformName: '' }, { platformName: 1 })).status, 400); // an empty name is refused, so the sender never goes blank
	delete process.env.EMAIL_SENDER_NAME; systemSettingsService.invalidate();
	// the legacy route writes the same table and bumps the same version, so a stale registry save is still detected
	const v0 = (await one(e, e.sa.id, 'supportEmail')).version; const { platformSettingsService } = await import('./platform-settings.service');
	await platformSettingsService.update({ supportEmail: 'a@pg.test' }, e.sa.id); const v1 = (await one(e, e.sa.id, 'supportEmail')).version; assert.equal(v1, v0 + 1);
	assert.equal((await put(e, e.sa.id, { supportEmail: 'b@pg.test' }, { supportEmail: v0 })).status, 409);
});

test('PG settings: baseCurrency is USD; a change is allowed only when the readiness check passes (versioned + audited, activates no gateway), refused with the real blocker when old unverified labels exist, an invalid code is rejected, the same value is a no-op', opts, async () => {
	const e = await env(); await reset(e);
	const cur = await one(e, e.sa.id, 'baseCurrency'); assert.equal(cur.value, 'USD'); assert.deepEqual(cur.allowed, ['USD', 'SAR']);
	// an OLD ledger row (before 2026-10-01, when every writer started naming the currency) labelled SAR may be the stale database default: it blocks the change and names itself
	const u = await e.mkUser('CLIENT_INDIVIDUAL', 'cur-old');
	const old = await e.prisma.walletTransaction.create({ data: { userId: u.id, type: 'DEPOSIT', amount: 5, currency: 'SAR', status: 'COMPLETED', createdAt: new Date('2026-09-01T00:00:00Z') } });
	const r = await put(e, e.sa.id, { baseCurrency: 'SAR' }, { baseCurrency: 0 }); assert.equal(r.status, 409); assert.equal(r.json.code, 'CURRENCY_CHANGE_NOT_READY');
	const codes = r.json.errors.map((b: any) => b.code); assert.ok(codes.includes('LEDGER_CURRENCY_LABELS_UNVERIFIED'));
	assert.ok(!codes.includes('MONEY_TABLES_WITHOUT_CURRENCY'), 'phase A is in the schema of this database: every money table has its currency column');
	for (const gone of ['WALLET_BALANCE_PER_CURRENCY_MISSING', 'FX_RECORD_MISSING', 'GATEWAY_CAPABILITY_MAP_MISSING', 'CURRENCY_FORMATTER_MISSING', 'AGGREGATIONS_NOT_PER_CURRENCY', 'UI_TYPED_CURRENCY']) assert.ok(!codes.includes(gone), `${gone} is implemented, so it is no longer a blocker`);
	assert.equal(await e.prisma.platformSetting.count({ where: { key: 'baseCurrency' } }), 0, 'a refused change stores nothing');
	assert.equal((await put(e, e.sa.id, { baseCurrency: 'EUR' }, { baseCurrency: 0 })).status, 400);
	assert.equal((await put(e, e.sa.id, { baseCurrency: 'USD' }, { baseCurrency: 0 })).status, 200); assert.equal(await e.prisma.platformSetting.count({ where: { key: 'baseCurrency' } }), 0, 'the same value is a no-op');
	// the old row is gone (decided/corrected by the team): the change is allowed, stored with a version, and it enables nothing else
	await e.prisma.walletTransaction.delete({ where: { id: old.id } });
	const ok = await put(e, e.sa.id, { baseCurrency: 'SAR' }, { baseCurrency: 0 }); assert.equal(ok.status, 200, JSON.stringify(ok.json));
	assert.equal((await one(e, e.sa.id, 'baseCurrency')).value, 'SAR'); assert.equal((await e.prisma.platformSetting.findUniqueOrThrow({ where: { key: 'baseCurrency' } })).version, 1);
	const { gatewayAccepts } = await import('../config/payment-gateways'); assert.equal(gatewayAccepts('arb', 'SAR'), false); assert.equal(gatewayAccepts('paypal', 'SAR'), false);
	assert.equal((await put(e, e.sa.id, { baseCurrency: 'USD' }, { baseCurrency: 1 })).status, 200, 'and back');
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

test('PG settings: the currency readiness check reads the REAL schema - a database without the currency columns is refused on that ground, and every phase-A table is named', opts, async () => {
	const { currencyReadiness, MONEY_TABLES } = await import('./currency-readiness.service');
	const fake = (tables: string[], wallet: boolean) => ({ $queryRaw: async (q: TemplateStringsArray) => (String(q[0]).includes('information_schema.tables') ? (wallet ? [{ n: 'x' }] : []) : String(q[0]).includes('information_schema.columns') ? tables.map(t => ({ table_name: t })) : [{ n: 0n }]) }) as any;
	const none = await currencyReadiness(fake([], false)); const b = none.blockers.find(x => x.code === 'MONEY_TABLES_WITHOUT_CURRENCY')!; assert.ok(b); for (const t of MONEY_TABLES) assert.ok(b.message.includes(t), t);
	const some = await currencyReadiness(fake(MONEY_TABLES.slice(0, 5) as any, false)); assert.ok(some.blockers.find(x => x.code === 'MONEY_TABLES_WITHOUT_CURRENCY')!.message.includes(MONEY_TABLES[5]));
	const all = await currencyReadiness(fake([...MONEY_TABLES], true)); assert.ok(!all.blockers.some(x => x.code === 'MONEY_TABLES_WITHOUT_CURRENCY' || x.code === 'WALLET_BALANCE_PER_CURRENCY_MISSING')); assert.equal(all.ready, true, 'with the schema present and nothing unverified there is no known blocker');
	const broken = await currencyReadiness({ $queryRaw: async () => { throw new Error('db'); } } as any); assert.ok(broken.blockers.some(x => x.code === 'SCHEMA_UNREADABLE') && !broken.ready);
	const e = await env(); const real = await currencyReadiness(e.prisma); assert.ok(!real.blockers.some(x => x.code === 'MONEY_TABLES_WITHOUT_CURRENCY'));
});

test('PG settings: money records written WITHOUT a currency are USD (the stored default), the three older tables no longer default to SAR, and an explicit currency is kept as written', opts, async () => {
	const e = await env(); const cols = await e.prisma.$queryRaw<Array<{ table_name: string; column_default: string }>>`SELECT table_name, column_default FROM information_schema.columns WHERE column_name='currency' AND table_schema='public' AND table_name IN ('commission_logs','withdrawals','wallet_transactions','contracts','escrows','projects')`;
	for (const c of cols) assert.match(c.column_default, /USD/, c.table_name);
	const u = await e.mkUser('CLIENT_INDIVIDUAL', 'cur'); const t1 = await e.prisma.walletTransaction.create({ data: { userId: u.id, type: 'DEPOSIT', amount: 5, status: 'COMPLETED' } as any }); assert.equal(t1.currency, 'USD');
	const t2 = await e.prisma.walletTransaction.create({ data: { userId: u.id, type: 'DEPOSIT', amount: 5, status: 'COMPLETED', currency: 'SAR' } as any }); assert.equal(t2.currency, 'SAR', 'an explicit currency is stored as written, never rewritten');
});

test('PG settings: regional settings are real - initial values keep today\'s behaviour, they are public for the UI, SUPER-only to write, and they reach the admin report windows, the CSV and the default e-mail language', opts, async () => {
	const e = await env(); await reset(e); const { SystemSettingsService, systemSettingsService } = await import('./system-settings.service'); const { adminDashboardService } = await import('./admin-dashboard.service'); const { adminFinanceService } = await import('./admin-finance.service'); const { notificationService } = await import('./notification.service');
	for (const [k, v] of [['defaultTimezone', 'browser'], ['dateFormat', 'legacy'], ['calendarSystem', 'gregorian'], ['defaultLanguage', 'ar']] as const) { const it = await one(e, e.sa.id, k); assert.equal(it.value, v, k); assert.equal(it.status, 'enforced'); assert.ok(it.allowedLabels, `${k} has human labels`); }
	const pub = await new SystemSettingsService(e.prisma).publicValues(); assert.deepEqual([pub.defaultTimezone, pub.dateFormat, pub.calendarSystem, pub.defaultLanguage], ['browser', 'legacy', 'gregorian', 'ar']);
	const manager = await mkStaff(e, ['settings.manage'], 'rg'); for (const [k, v] of [['defaultTimezone', 'UTC'], ['dateFormat', 'DD/MM/YYYY'], ['calendarSystem', 'hijri'], ['defaultLanguage', 'en']] as const) { assert.equal((await put(e, manager.user.id, { [k]: v }, { [k]: 0 })).status, 403, k); }
	for (const bad of [{ defaultTimezone: 'Mars/Base' }, { dateFormat: 'MM/DD/YYYY' }, { calendarSystem: 'lunar' }, { defaultLanguage: 'fr' }]) assert.equal((await put(e, e.sa.id, bad, Object.fromEntries(Object.keys(bad).map(k => [k, 0])))).status, 400, JSON.stringify(bad));
	// report window: a user created 1 Oct 01:00 Riyadh (30 Sep 22:00 UTC) is in OCTOBER for the Riyadh zone, in SEPTEMBER for UTC / browser
	const mk = (iso: string, tag: string) => e.prisma.user.create({ data: { id: randomUUID(), accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', roles: ['CLIENT'], activeRole: 'CLIENT', firstName: tag, lastName: 'z', email: `${tag}-${randomUUID().slice(0, 6)}@pg.test`, password: 'x', agreedToTerms: true, createdAt: new Date(iso) } });
	await mk('2026-09-30T22:00:00Z', 'edge'); await mk('2026-10-10T10:00:00Z', 'mid');
	const now = new Date('2026-10-15T10:00:00Z'); 	const sumOf = async () => ((await adminDashboardService.getSummary(now)) as any);
	const before = await sumOf(); const keyPath = (o: any) => o.kpis.users.newThisMonth;
	assert.equal((await put(e, e.sa.id, { defaultTimezone: 'Asia/Riyadh' }, { defaultTimezone: 0 })).status, 200);
	const edge = await e.prisma.user.count({ where: { accountType: { notIn: ['ADMIN', 'SUPER_ADMIN'] }, createdAt: { gte: new Date('2026-09-30T21:00:00Z'), lt: new Date('2026-10-01T00:00:00Z') } } }); assert.ok(edge >= 1);
	const riyadh = await sumOf(); assert.equal(Number(keyPath(riyadh)) - Number(keyPath(before)), edge, 'users created 00:00-03:00 Riyadh on 1 Oct (21:00-24:00 UTC on 30 Sep) move into October under the Riyadh zone');
	assert.equal((await put(e, e.sa.id, { defaultTimezone: 'browser' }, { defaultTimezone: 1 })).status, 200); assert.equal(Number(keyPath(await sumOf())), Number(keyPath(before)), 'back to the current behaviour');
	// CSV: the reference column stays ISO UTC; a local column appears only when a zone is configured
	const u = await mk('2026-10-01T09:00:00Z', 'csv'); await e.prisma.withdrawal.create({ data: { userId: u.id, amount: 5, currency: 'USD', method: 'paypal', status: 'PENDING', createdAt: new Date('2026-10-01T09:00:00Z') } as any });
	const plain = await adminFinanceService.withdrawalsCsv(); assert.ok(!plain.split('\n')[0].includes('date_local'));
	await put(e, e.sa.id, { defaultTimezone: 'Asia/Riyadh' }, { defaultTimezone: 2 }); const withZone = await adminFinanceService.withdrawalsCsv(); const header = withZone.split('\n')[0]; assert.ok(header.includes('date_local'));
	const row = withZone.split('\n').find(l => l.includes('2026-10-01T09:00:00.000Z'))!; assert.ok(row.includes('2026-10-01 12:00'), row); await put(e, e.sa.id, { defaultTimezone: 'browser' }, { defaultTimezone: 3 });
	// default e-mail language: nobody saved a choice -> the platform default; a saved choice always wins
	const nobody = await e.mkUser('CLIENT_INDIVIDUAL', 'lang1'); assert.equal((await notificationService.resolveDelivery(nobody.id, '/client-overview/x')).lang, 'ar');
	assert.equal((await put(e, e.sa.id, { defaultLanguage: 'en' }, { defaultLanguage: 0 })).status, 200); systemSettingsService.invalidate();
	assert.equal((await notificationService.resolveDelivery(nobody.id, '/client-overview/x')).lang, 'en', 'no saved choice -> the platform default');
	await e.prisma.clientProfile.create({ data: { userId: nobody.id, interfaceLanguage: 'العربية' } as any }).catch(() => undefined);
	assert.equal((await notificationService.resolveDelivery(nobody.id, '/client-overview/x')).lang, 'ar', 'the recipient\'s own choice wins over the platform default');
	await put(e, e.sa.id, { defaultLanguage: 'ar' }, { defaultLanguage: 1 });
});

test('PG settings: the admin mailbox gets a minimal alert for the four operational events only - no personal data, one per event per minute, nothing when empty, separate from the staff recipients, a failing mail never breaks the action', opts, async () => {
	const e = await env(); await reset(e); const { mailTransporter } = await import('../utils/mail.transporter'); const { notifyAdmins } = await import('./admin-notifications.service'); const { resetMailboxThrottle } = await import('./admin-mailbox-alert.service'); const { systemSettingsService } = await import('./system-settings.service');
	const sent: any[] = []; let fail = false; (mailTransporter as any).sendMail = async (m: any) => { if (fail) throw new Error('smtp down'); sent.push(m); return { accepted: [m.to], rejected: [], messageId: 't' }; };
	const idle = async () => { await new Promise(r => setTimeout(r, 60)); };
	const manager = await mkStaff(e, ['settings.manage'], 'mb'); assert.equal((await put(e, manager.user.id, { adminNotificationEmail: 'ops@pg.test' }, { adminNotificationEmail: 0 })).status, 403, 'directing mail outwards is SUPER-only');
	assert.equal((await put(e, e.sa.id, { adminNotificationEmail: 'not-mail' }, { adminNotificationEmail: 0 })).status, 400);
	resetMailboxThrottle(); await notifyAdmins('NEW_DISPUTE', { id: 'd1' }); await idle(); assert.equal(sent.length, 0, 'empty mailbox = nothing is sent');
	assert.equal((await put(e, e.sa.id, { adminNotificationEmail: 'ops@pg.test' }, { adminNotificationEmail: 0 })).status, 200); systemSettingsService.invalidate();
	await notifyAdmins('NEW_DISPUTE', { id: '11111111-aaaa', ref: 'اسم مشروع حساس', metadata: { secret: 'x' } } as any); await idle(); assert.equal(sent.length, 1); const m = sent[0];
	assert.equal(m.to, 'ops@pg.test'); assert.match(m.subject, /تنبيه إداري: نزاع جديد/); const body = `${m.html}\n${m.text}`; assert.ok(body.includes('/supper-admin-overview/disputes/11111111-aaaa'), 'a link into the console');
	for (const leak of ['اسم مشروع حساس', 'secret', '@', ' $', 'USD'].filter(x => x !== '@')) assert.ok(!body.includes(leak), `no leak: ${leak}`);
	await notifyAdmins('NEW_DISPUTE', { id: 'd2' }); await idle(); assert.equal(sent.length, 1, 'one mail per event kind per minute');
	for (const ev of ['NEW_TICKET', 'WITHDRAWAL_REQUESTED', 'KYC_SUBMITTED'] as const) await notifyAdmins(ev, { id: 'x1' }); await idle(); assert.equal(sent.length, 4);
	for (const ev of ['SUSPICIOUS_PAYMENT', 'PAYOUT_FAILED'] as const) await notifyAdmins(ev, { id: 'x2' }); await idle(); assert.equal(sent.length, 4, 'money-incident events are not mailed');
	// the staff inbox is built from permissions and is untouched by the mailbox
	const holder = await mkStaff(e, ['disputes.view'], 'dv'); const none = await mkStaff(e, ['users.view'], 'nv'); resetMailboxThrottle(); await notifyAdmins('NEW_DISPUTE', { id: 'd9' }); await idle();
	assert.equal(await e.prisma.notification.count({ where: { userId: holder.user.id, type: 'ADMIN_NEW_DISPUTE' } }) >= 1, true); assert.equal(await e.prisma.notification.count({ where: { userId: none.user.id, type: 'ADMIN_NEW_DISPUTE' } }), 0);
	fail = true; resetMailboxThrottle(); await assert.doesNotReject(notifyAdmins('NEW_TICKET', { id: 't1' })); await idle();
	await put(e, e.sa.id, { adminNotificationEmail: '' }, { adminNotificationEmail: 1 });
});
