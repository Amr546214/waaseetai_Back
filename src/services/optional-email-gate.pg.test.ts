import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
process.env.FRONTEND_URL = 'https://dev.example.test';
process.env.SMTP_HOST = 'sink.invalid'; // not the "simulation" branch of email.service; the transporter below is replaced, nothing leaves the process
process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';

/**
 * The platform switch of OPTIONAL e-mail (`channelEmail`) on REAL PostgreSQL (isolated local DB only): zero optional mail while OFF - including a digest that was due before the
 * switch-off and one switched off between the claim and the send - code mail (login / activation / reset) keeps working, the stored choice is never touched, a refused attempt
 * to turn the option ON is a 409 with a stable code, ON again = the earlier choices apply again. The SMTP transport is replaced by an in-memory sink.
 */
const URL_ = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL_ && URL_ === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL_);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
const CODE = 'EMAIL_CHANNEL_DISABLED_BY_PLATFORM';

const sink: any[] = [];
let server: http.Server | null = null; let base = '';
const MIN = 60_000;
const id = () => randomUUID();
const sentTo = (email: string) => sink.filter(m => m.to === email);

async function boot() {
	const { prisma } = await import('../config/db');
	const { mailTransporter } = await import('../utils/mail.transporter');
	(mailTransporter as any).sendMail = async (m: any) => { sink.push(m); return { messageId: 'sink', accepted: [m.to], rejected: [] }; };
	if (!server) {
		mock.module('../middlewares/auth.middleware', { namedExports: {
			authenticate: async (req: any, res: any, next: any) => {
				const u = req.headers['x-test-user'] ? await prisma.user.findUnique({ where: { id: String(req.headers['x-test-user']) } }) : null;
				if (!u) return res.status(401).json({ success: false });
				req.user = { id: u.id, userId: u.id, email: u.email, accountType: u.accountType, status: u.status, activeRole: u.activeRole, roles: u.roles, sessionId: 's' };
				next();
			},
			requireActiveUser: (_q: any, _r: any, n: any) => n(), authorize: () => (_q: any, _r: any, n: any) => n(), authorizeAdminActing: (_q: any, _r: any, n: any) => n(),
		} });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express(); app.use(express.json());
		app.use('/admin/system-settings', (await import('../routes/admin-system-settings.routes')).default);
		app.use('/notifications', (await import('../routes/notifications.routes')).default);
		app.use(globalErrorHandler as any);
		server = http.createServer(app);
		await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}
	return prisma;
}
const call = async (method: string, url: string, who: string, body?: any) => {
	const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', connection: 'close', 'x-test-user': who }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: res.status, json: await res.json().catch(() => null) as any };
};
const mkUser = async (prisma: any, accountType: string, tag: string) => prisma.user.create({ data: { id: id(), accountType, status: 'ACTIVE', firstName: 'QA', lastName: tag, email: `gate-${tag}-${id().slice(0, 6)}@pg.test`, roles: [accountType === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : accountType === 'ADMIN' ? 'ADMIN' : accountType.startsWith('PROVIDER') ? 'PROVIDER' : 'CLIENT'], activeRole: accountType === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : accountType === 'ADMIN' ? 'ADMIN' : accountType.startsWith('PROVIDER') ? 'PROVIDER' : 'CLIENT' } });
const mkProvider = async (prisma: any, email: boolean) => {
	const u = await mkUser(prisma, 'PROVIDER_INDIVIDUAL', 'prov');
	await prisma.providerProfile.create({ data: { id: id(), userId: u.id, kycStatus: 'VERIFIED', preferences: { notifChannels: email ? ['push', 'email'] : ['push'] } } });
	return u;
};
let sa: any;
const setPlatform = async (prisma: any, on: boolean) => {
	const cur = await prisma.platformSetting.findUnique({ where: { key: 'channelEmail' } });
	const r = await call('PUT', '/admin/system-settings', sa.id, { changes: { channelEmail: on }, expected: { channelEmail: cur?.version ?? 0 } });
	assert.equal(r.status, 200, JSON.stringify(r.json));
};
const notify = async (userId: string, actionUrl = '/provider-overview/offers') => (await import('./notification.service')).notificationService.createAndEmit({ userId, title: 'عرض جديد', message: 'وصلك عرض جديد على مشروعك', type: 'GENERAL', actionUrl });
const settle = () => new Promise(r => setTimeout(r, 60));

after(async () => { if (server) { server.closeAllConnections?.(); await new Promise(r => server!.close(r)); } const { prisma } = await import('../config/db'); await prisma.$disconnect(); });

test('pg gate: only SUPER_ADMIN writes the switch; default is ON; it is published (public) and the registry row is enforced', opts, async () => {
	const prisma = await boot(); sa = await mkUser(prisma, 'SUPER_ADMIN', 'sa');
	await prisma.platformSetting.deleteMany({ where: { key: 'channelEmail' } });
	const { systemSettingsService } = await import('./system-settings.service'); systemSettingsService.invalidate();
	const { optionalEmailEnabled } = await import('./optional-email-gate');
	assert.equal(await optionalEmailEnabled(), true);
	const admin = await mkUser(prisma, 'ADMIN', 'adm');
	const denied = await call('PUT', '/admin/system-settings', admin.id, { changes: { channelEmail: false }, expected: { channelEmail: 0 } });
	assert.ok([401, 403].includes(denied.status), String(denied.status));
	assert.equal(await optionalEmailEnabled(), true);
	await setPlatform(prisma, false); assert.equal(await optionalEmailEnabled(), false);
	assert.equal((await systemSettingsService.publicValues() as any).channelEmail, false);
	await setPlatform(prisma, true); assert.equal(await optionalEmailEnabled(), true);
});

test('pg gate: notification copy - ON mails the opted-in provider, OFF sends NOTHING (still stored), ON again follows the earlier choice; the preference row is never touched', opts, async () => {
	const prisma = await boot(); sink.length = 0;
	const p = await mkProvider(prisma, true); const before = JSON.stringify((await prisma.providerProfile.findUnique({ where: { userId: p.id } }))!.preferences);
	await setPlatform(prisma, true); await notify(p.id); await settle(); assert.equal(sentTo(p.email).length, 1);
	await setPlatform(prisma, false); const dto = await notify(p.id); await settle();
	assert.equal(sentTo(p.email).length, 1, 'no new mail while OFF');
	assert.ok(await prisma.notification.findUnique({ where: { id: dto.id } }), 'the in-app notification is still stored');
	assert.equal(JSON.stringify((await prisma.providerProfile.findUnique({ where: { userId: p.id } }))!.preferences), before);
	await setPlatform(prisma, true); await notify(p.id); await settle(); assert.equal(sentTo(p.email).length, 2);
});

test('pg gate: a user who did NOT opt in gets no optional mail even when the platform is ON (platform AND user must agree)', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, true);
	const p = await mkProvider(prisma, false); await notify(p.id); await settle(); assert.equal(sentTo(p.email).length, 0);
});

test('pg gate: the last check happens at send time - a copy prepared while ON is dropped when the switch is OFF at execution', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, false);
	const { notificationService } = await import('./notification.service');
	await (notificationService as any).sendNotificationMail('late@pg.test', 'QA', { title: 't', message: 'm', actionUrl: null, actionText: null }, 'ar');
	assert.equal(sink.length, 0);
	await setPlatform(prisma, true);
	await (notificationService as any).sendNotificationMail('late@pg.test', 'QA', { title: 't', message: 'm', actionUrl: null, actionText: null }, 'ar');
	assert.equal(sink.length, 1);
});

test('pg gate: code mail is an INDEPENDENT channel - login, activation and reset mail are sent while optional mail is OFF', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, false);
	const { notificationService } = await import('./notification.service');
	await notificationService.sendLoginOtpEmail('otp@pg.test', '123456', 10);
	await notificationService.sendEmailOtp('otp@pg.test', '654321', 10);
	await notificationService.sendPasswordResetEmail('otp@pg.test', 'سارة', '111222', 10);
	await notificationService.sendPaymentOtpEmail('otp@pg.test', '333444');
	assert.equal(sentTo('otp@pg.test').length, 4);
	assert.match(sink[0].html, /123456/);
	await setPlatform(prisma, true);
});

test('pg gate: the e-mail option cannot be turned ON through the API while OFF (409 + stable code), the stored choice survives, turning it OFF or repeating it is allowed, GET shows the platform state', opts, async () => {
	const prisma = await boot();
	const c = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'cli');
	await prisma.notificationPreference.create({ data: { userId: c.id, settings: { channel_email: false, channel_in_app: true } } });
	const stored = async () => JSON.stringify((await prisma.notificationPreference.findUnique({ where: { userId: c.id } }))!.settings);
	await setPlatform(prisma, false);
	const was = await stored();
	const refused = await call('PATCH', '/notifications/preferences', c.id, { settings: { channel_email: true } });
	assert.equal(refused.status, 409); assert.equal(refused.json.code, CODE); assert.equal(refused.json.message, 'معطّل بواسطة إدارة المنصة');
	assert.equal(await stored(), was, 'a refused attempt writes nothing');
	const refusedAlt = await call('PATCH', '/notifications/preferences', c.id, { settings: { email: true, channel_in_app: false } });
	assert.equal(refusedAlt.status, 409); assert.equal(await stored(), was, 'not even the other keys of a refused request are saved');
	const g = await call('GET', '/notifications/preferences', c.id); assert.equal(g.json.data.platform.emailEnabled, false); assert.equal(g.json.data.settings.channel_email, false);
	await setPlatform(prisma, true);
	assert.equal((await call('PATCH', '/notifications/preferences', c.id, { settings: { channel_email: true } })).status, 200);
	await setPlatform(prisma, false);
	assert.equal(JSON.parse(await stored()).channel_email, true, 'the stored opt-in is NOT erased by the switch');
	assert.equal((await call('PATCH', '/notifications/preferences', c.id, { settings: { channel_email: true, channel_in_app: false } })).status, 200, 'repeating the stored choice (a page that sends back what it loaded) is not an error');
	assert.equal((await call('PATCH', '/notifications/preferences', c.id, { settings: { channel_email: false } })).status, 200, 'withdrawing consent is never blocked');
	await setPlatform(prisma, true);
});

test('pg gate: a client who opted in (stored) gets mail again after OFF -> ON without any data change', opts, async () => {
	const prisma = await boot(); sink.length = 0;
	const c = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'cli2');
	await prisma.notificationPreference.create({ data: { userId: c.id, settings: { email: true } } });
	await setPlatform(prisma, false); await notify(c.id, '/client-overview/requests'); await settle(); assert.equal(sentTo(c.email).length, 0);
	await setPlatform(prisma, true); await notify(c.id, '/client-overview/requests'); await settle(); assert.equal(sentTo(c.email).length, 1);
	assert.equal(sentTo(c.email)[0].to, c.email, 'the recipient is the account owner');
});

test('pg gate: marketer and provider preference services refuse to switch e-mail ON while OFF and write nothing', opts, async () => {
	const prisma = await boot();
	const m = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'mkt');
	await prisma.notificationPreference.create({ data: { userId: m.id, settings: { channel_in_app: true } } });
	const p = await mkProvider(prisma, false);
	await setPlatform(prisma, false);
	const { marketerSettingsService } = await import('./marketer-settings.service');
	await assert.rejects(() => marketerSettingsService.update(m.id, { email: true } as any), (e: any) => e.code === CODE && e.statusCode === 409);
	assert.equal((await marketerSettingsService.get(m.id)).email, false);
	await marketerSettingsService.update(m.id, { newReferral: false } as any); // other settings still save
	const { providerProfileService } = await import('./provider-profile.service');
	await assert.rejects(() => providerProfileService.updatePreferences(p.id, { notifChannels: ['push', 'email'] }), (e: any) => e.code === CODE && e.statusCode === 409);
	assert.deepEqual(((await prisma.providerProfile.findUnique({ where: { userId: p.id } }))!.preferences as any).notifChannels, ['push']);
	await providerProfileService.updatePreferences(p.id, { notifChannels: ['push'] }); // unchanged / no e-mail: fine
	await setPlatform(prisma, true);
	await marketerSettingsService.update(m.id, { email: true } as any); assert.equal((await marketerSettingsService.get(m.id)).email, true);
	await providerProfileService.updatePreferences(p.id, { notifChannels: ['push', 'email'] });
});

test('pg gate: project completion reward mail - needs platform ON and the provider opted in', opts, async () => {
	const prisma = await boot(); sink.length = 0;
	const yes = await mkProvider(prisma, true), no = await mkProvider(prisma, false);
	const { emailService } = await import('./email.service');
	const args = (u: any) => ({ email: u.email, userId: u.id, providerName: 'سارة <b>x</b>', projectTitle: 'متجر "إلكتروني"', pointsAwarded: 50, projectUrl: '/provider-overview/projects/active/progress/p1' });
	await setPlatform(prisma, false); await emailService.sendProjectCompletionRewardEmail(args(yes)); assert.equal(sink.length, 0);
	await setPlatform(prisma, true);
	await emailService.sendProjectCompletionRewardEmail(args(no)); assert.equal(sink.length, 0, 'not opted in: no mail (was sent to everyone before)');
	await emailService.sendProjectCompletionRewardEmail(args(yes)); assert.equal(sink.length, 1);
	const m = sink[0];
	assert.equal(m.to, yes.email); assert.match(m.html, /dir="rtl"/); assert.match(m.html, /Waseet AI|وسيط/); assert.doesNotMatch(m.html, /<b>x<\/b>/); assert.match(m.html, /https:\/\/dev\.example\.test\/provider-overview\/projects\/active\/progress\/p1/);
	assert.doesNotMatch(m.html, /localhost|\{\{|undefined|null/);
	assert.ok(m.text && m.headers['Auto-Submitted']);
});

test('pg gate: admin mailbox alert is a different channel (setting adminNotificationEmail) and is NOT stopped by the optional-mail switch', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, false);
	const cur = await prisma.platformSetting.findUnique({ where: { key: 'adminNotificationEmail' } });
	const r = await call('PUT', '/admin/system-settings', sa.id, { changes: { adminNotificationEmail: 'ops@pg.test' }, expected: { adminNotificationEmail: cur?.version ?? 0 } }); assert.equal(r.status, 200, JSON.stringify(r.json));
	const { sendAdminMailboxAlert, resetMailboxThrottle } = await import('./admin-mailbox-alert.service'); resetMailboxThrottle();
	assert.equal(await sendAdminMailboxAlert('NEW_TICKET', '/admin/tickets', 't1'), 'sent');
	assert.equal(sentTo('ops@pg.test').length, 1);
	await setPlatform(prisma, true);
});

// ───────────────────────────── deferred: the chat digest ─────────────────────────────
async function chatWorld(prisma: any) {
	const tag = id().slice(0, 8);
	const client = await mkUser(prisma, 'CLIENT_INDIVIDUAL', `dc${tag}`); const provider = await mkProvider(prisma, true);
	const project = await prisma.project.create({ data: { id: id(), title: `QA ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const room = await prisma.conversation.create({ data: { projectId: project.id, clientId: client.id, providerId: provider.id } });
	const { ChatGateway } = await import('../sockets/chat.gateway');
	const handlers: any = {}; const socket: any = { id: `s-${client.id}`, userId: client.id, on: (e: string, h: any) => { handlers[e] = h; }, join: () => undefined, leave: () => undefined, emit: () => undefined, to: () => ({ emit: () => undefined }) };
	new ChatGateway().register(socket, null);
	await prisma.$executeRaw`DELETE FROM chat_digest_activation`; await prisma.$executeRaw`INSERT INTO chat_digest_activation (id, enabled_at) VALUES ('default', ${new Date(Date.now() - 60 * MIN)})`;
	for (let i = 1; i <= 3; i++) await handlers.send_message({ data: { conversationId: room.id, content: `msg ${i}`, type: 'TEXT' } });
	return { client, provider, room };
}

test('pg gate: a digest that is DUE before the switch-off is not sent after it; nothing is consumed; ON again sends it once', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, true);
	const w = await chatWorld(prisma); const { runChatDigestOnce } = await import('./chat-digest.service');
	assert.equal(sentTo(w.provider.email).length, 0, 'never one mail per message');
	await setPlatform(prisma, false);
	const off = await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) });
	assert.equal(sentTo(w.provider.email).length, 0); assert.equal(off.sent, 0);
	assert.equal(await prisma.chatDigestState.count({ where: { userId: w.provider.id } }), 0, 'no slot was claimed while OFF');
	await setPlatform(prisma, true);
	const on = await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) });
	assert.equal(on.sent >= 1, true); assert.equal(sentTo(w.provider.email).length, 1);
	assert.match(sentTo(w.provider.email)[0].html, /dir="rtl"/); assert.match(sentTo(w.provider.email)[0].html, /conversationId=/);
});

test('pg gate: switched OFF between the claim and the send (retry/in-flight) - nothing is sent and the claimed slot is given back', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, true);
	const w = await chatWorld(prisma); const { runChatDigestOnce } = await import('./chat-digest.service');
	const { notificationService } = await import('./notification.service');
	const original = notificationService.resolveDelivery.bind(notificationService);
	(notificationService as any).resolveDelivery = async (...a: any[]) => { const r = await (original as any)(...a); await setPlatform(prisma, false); return { ...r, channels: { push: true, email: true } }; }; // the platform flips right after the channels were read
	try {
		const res = await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) });
		assert.equal(res.sent, 0); assert.equal(sentTo(w.provider.email).length, 0);
		assert.equal(await prisma.chatDigestState.count({ where: { userId: w.provider.id } }), 0, 'the slot is restored so the digest is still owed when the channel reopens');
	} finally { (notificationService as any).resolveDelivery = original; await setPlatform(prisma, true); }
	const again = await runChatDigestOnce({ now: new Date(Date.now() + 12 * MIN) });
	assert.equal(again.sent >= 1, true); assert.equal(sentTo(w.provider.email).length, 1);
});
