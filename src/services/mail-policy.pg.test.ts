import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
process.env.FRONTEND_URL = 'https://dev.example.test';
process.env.SMTP_HOST = 'sink.invalid'; process.env.SMTP_USER = 'qa-sink'; // not the "simulation" branch of email.service; the transporter below is replaced, nothing leaves the process
process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';

/**
 * Mail policy of owner decision 3 on REAL PostgreSQL (isolated local DB only), SMTP replaced by an in-memory sink:
 *  (a) platform OFF + user opted in  => ZERO optional mail (copies, reward, model result, digest, retries)
 *  (b) platform ON  + user opted OUT => ZERO optional mail
 *  (c) AUTH codes and TRANSACTIONAL mails (receipt, contract invitation) are unaffected in BOTH states
 *  (d) no duplicate per event / recipient / purpose: covered notifications are not mailed again, a retried or concurrent send is one mail, a restart does not forget it,
 *      a failed send stays retryable. Nothing here writes a user preference.
 */
const URL_ = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL_ && URL_ === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL_);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

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


const tx = async (n: number, to: string) => {
	const { dispatchMail } = await import('./mail-dispatch');
	await dispatchMail({ purpose: 'escrow-deposit-receipt', to, recipientKey: `c-${to}`, eventKey: `contract-${n}-${to}`, subject: 'receipt', html: '<p>r</p>', text: 'r' });
	await dispatchMail({ purpose: 'provider-contract-invitation', to, recipientKey: `p-${to}`, eventKey: `contract-${n}-${to}`, subject: 'invite', html: '<p>i</p>', text: 'i' });
};
const auth = async (to: string) => {
	const { notificationService } = await import('./notification.service');
	await notificationService.sendLoginOtpEmail(to, '123456', 10); await notificationService.sendPasswordResetEmail(to, 'سارة', '654321', 10);
};

for (const platform of [true, false]) for (const optedIn of [true, false]) {
	test(`pg policy matrix: platform ${platform ? 'ON' : 'OFF'} + user ${optedIn ? 'opted in' : 'opted OUT'} => optional mail ${platform && optedIn ? 'sent' : 'ZERO'}; AUTH + TRANSACTIONAL always sent`, opts, async () => {
		const prisma = await boot(); sa = sa ?? await mkUser(prisma, 'SUPER_ADMIN', 'sa'); sink.length = 0;
		const { resetMailLedger } = await import('./mail-dispatch'); resetMailLedger();
		await setPlatform(prisma, platform);
		const p = await mkProvider(prisma, optedIn);
		const { notificationService } = await import('./notification.service'); const { emailService } = await import('./email.service');
		const before = await prisma.providerProfile.findUnique({ where: { userId: p.id } });
		// OPTIONAL: a notification copy, the completion reward, the model-audit result
		await notify(p.id); await settle();
		await emailService.sendProjectCompletionRewardEmail({ email: p.email, userId: p.id, providerName: 'سارة', projectTitle: 'متجر', pointsAwarded: 50, projectUrl: '/provider-overview/projects/active/progress/p1', projectId: `proj-${id()}` });
		await emailService.sendModelApprovalEmail(p.email, 'سارة', 'نموذج', 80, true, 'ممتاز', p.id);
		const optional = sentTo(p.email).length;
		assert.equal(optional, platform && optedIn ? 3 : 0, `optional mails: ${sentTo(p.email).map(m => m.subject).join(' | ')}`);
		// the same through the CLIENT and MARKETER preference families
		const c = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'cl'); await prisma.notificationPreference.create({ data: { userId: c.id, settings: { inApp: true, email: optedIn } } });
		await notificationService.createAndEmit({ userId: c.id, title: 'تحديث', message: 'رسالة', type: 'GENERAL', actionUrl: '/client-overview/projects' }); await settle();
		assert.equal(sentTo(c.email).length, platform && optedIn ? 1 : 0);
		const m = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'mk'); await prisma.notificationPreference.create({ data: { userId: m.id, settings: { channel_in_app: true, channel_email: optedIn } } });
		await notificationService.createAndEmit({ userId: m.id, title: 'إحالة', message: 'رسالة', type: 'GENERAL', actionUrl: '/marketer-overview/home' }); await settle();
		assert.equal(sentTo(m.email).length, platform && optedIn ? 1 : 0);
		// AUTH + TRANSACTIONAL: identical in every cell
		const to = `fixed-${id().slice(0, 6)}@pg.test`;
		await auth(to); await tx(1, to);
		assert.equal(sentTo(to).length, 4, sentTo(to).map(x => x.subject).join(' | '));
		for (const x of sentTo(to)) { assert.ok(x.text && x.headers['Auto-Submitted']); }
		// no preference was written by any of this
		const after = await prisma.providerProfile.findUnique({ where: { userId: p.id } });
		assert.deepEqual(after?.preferences, before?.preferences);
		await setPlatform(prisma, true);
	});
}

test('pg policy: platform OFF + opted-in user - a retried / re-delivered notification sends nothing while OFF (the due chat digest is covered in optional-email-gate.pg.test); ON again sends exactly once', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, true);
	const p = await mkProvider(prisma, true);
	const { notificationService } = await import('./notification.service');
	const dto = await notify(p.id); await settle(); assert.equal(sentTo(p.email).length, 1);
	const n2 = await prisma.notification.create({ data: { userId: p.id, title: 'مخزّن', message: 'm', type: 'GENERAL', actionUrl: '/provider-overview/offers' } });
	await setPlatform(prisma, false);
	await notificationService.emitStored(n2.id); await notificationService.emitStored(n2.id); await settle(); // retries while OFF
	assert.equal(sentTo(p.email).length, 1);
	await setPlatform(prisma, true);
	await notificationService.emitStored(n2.id); await settle();
	assert.equal(sentTo(p.email).length, 2, 'the first delivery after ON mails it');
	await notificationService.emitStored(n2.id); await notificationService.emitStored(n2.id); await settle();
	assert.equal(sentTo(p.email).length, 2, 're-delivery of the same notification never mails twice');
	assert.ok(dto.id);
});

test('pg policy: one mail per event - covered notifications (ESCROW_FUNDED, OFFER_ACCEPTED, PROJECT_COMPLETION_REWARD) are stored but never mailed as a copy; the dedicated mail is the one', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, true);
	const { notificationService } = await import('./notification.service'); const { emailService } = await import('./email.service');
	const { resetMailLedger } = await import('./mail-dispatch');
	// client (ESCROW_FUNDED) and provider (OFFER_ACCEPTED + PROJECT_COMPLETION_REWARD) both opted in
	const c = await mkUser(prisma, 'CLIENT_INDIVIDUAL', 'cl'); await prisma.notificationPreference.create({ data: { userId: c.id, settings: { inApp: true, email: true } } });
	await notificationService.createAndEmit({ userId: c.id, title: 'تم إيداع الضمان', message: 'حُجز', type: 'ESCROW_FUNDED', actionUrl: '/client-overview/projects/active' });
	const p = await mkProvider(prisma, true);
	await notificationService.createAndEmit({ userId: p.id, title: 'تم قبول عرضك', message: 'وقّع', type: 'OFFER_ACCEPTED', actionUrl: '/provider-overview/offers/o1/sign-contract' });
	const reward = await notificationService.createAndEmit({ userId: p.id, title: 'اكتمل المشروع', message: 'نقاط', type: 'PROJECT_COMPLETION_REWARD', actionUrl: '/provider-overview/projects/active/progress/p1' });
	await settle();
	assert.equal(sink.length, 0, 'no copy for an event that has its dedicated mail');
	assert.equal(await prisma.notification.count({ where: { userId: { in: [c.id, p.id] } } }), 3, 'the in-app notifications are all stored');
	const data = { email: p.email, userId: p.id, providerName: 'سارة', projectTitle: 'متجر', pointsAwarded: 50, projectUrl: '/provider-overview/projects/active/progress/p1', projectId: 'proj-1', notificationId: reward.id };
	await emailService.sendProjectCompletionRewardEmail(data);
	assert.equal(sentTo(p.email).length, 1);
	assert.match(sentTo(p.email)[0].html, /\+50/); assert.match(sentTo(p.email)[0].html, /متجر/); assert.match(sentTo(p.email)[0].html, /progress\/p1/);
	// retried approval, duplicate delivery, concurrent calls, and a process restart (memory forgotten) - still one
	await emailService.sendProjectCompletionRewardEmail(data);
	resetMailLedger(); await emailService.sendProjectCompletionRewardEmail(data);
	await Promise.all([1, 2, 3, 4].map(() => emailService.sendProjectCompletionRewardEmail(data)));
	assert.equal(sentTo(p.email).length, 1);
	const row = await prisma.notification.findUnique({ where: { id: reward.id } });
	assert.ok((row?.metadata as any)?.['mailClaim:project-completion-reward'], 'the claim is stored in the notification row');
});

test('pg policy: a reward mail whose send failed releases its claim - the retry delivers once', opts, async () => {
	const prisma = await boot(); sink.length = 0; await setPlatform(prisma, true);
	const { notificationService } = await import('./notification.service'); const { emailService } = await import('./email.service'); const { mailTransporter } = await import('../utils/mail.transporter');
	const p = await mkProvider(prisma, true);
	const n = await prisma.notification.create({ data: { userId: p.id, title: 'اكتمل', message: 'm', type: 'PROJECT_COMPLETION_REWARD', actionUrl: '/provider-overview/projects/active/progress/p2' } });
	const data = { email: p.email, userId: p.id, providerName: 'سارة', projectTitle: 'م', pointsAwarded: 50, projectUrl: '/provider-overview/projects/active/progress/p2', projectId: 'proj-2', notificationId: n.id };
	const ok = (mailTransporter as any).sendMail;
	(mailTransporter as any).sendMail = async () => { throw new Error('smtp down'); };
	try { await emailService.sendProjectCompletionRewardEmail(data); } finally { (mailTransporter as any).sendMail = ok; }
	assert.equal(sentTo(p.email).length, 0);
	assert.equal(((await prisma.notification.findUnique({ where: { id: n.id } }))?.metadata as any)?.['mailClaim:project-completion-reward'], undefined, 'claim released');
	await emailService.sendProjectCompletionRewardEmail(data); await emailService.sendProjectCompletionRewardEmail(data);
	assert.equal(sentTo(p.email).length, 1);
	void notificationService;
});

test('pg policy: the registry text states the exception and the pairing rule (settings tab consumers are truthful)', opts, async () => {
	const { SETTING_BY_KEY } = await import('../config/system-settings.registry') as any;
	const row = SETTING_BY_KEY.get('channelEmail');
	assert.ok(row, 'channelEmail row');
	assert.match(row.description, /ولا يتجاوزه تفضيل أي مستخدم/); assert.match(row.description, /إيصال إيداع الضمان/); assert.match(row.description, /دعوة المزوّد لتوقيع العقد/);
	assert.ok(row.consumers.some((c: string) => /mail-dispatch/.test(c)));
});
