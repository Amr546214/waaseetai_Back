import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

async function load(t: TestContext, o: { settings?: unknown; language?: string | null; providerPrefs?: unknown; type?: string; actionUrl?: string | null } = {}) {
	const mails: any[] = []; const pushes: any[] = [];
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (m: any) => { mails.push(m); return { accepted: [m.to], rejected: [], messageId: 'm1', response: '250 ok' }; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
	t.mock.module('../socket', { namedExports: { getIO: () => ({ to() { return this; }, emit: (_e: string, d: any) => pushes.push(d) }) } });
	const stored = { id: 'n1', userId: 'u1', title: 'تسليم جديد', message: 'تم تسليم مرحلة', category: 'PROJECTS', type: o.type ?? 'STAGE_DELIVERY', actionUrl: o.actionUrl === undefined ? '/client-overview/projects/p1' : o.actionUrl, actionText: null, metadata: null, isRead: false, createdAt: new Date(), updatedAt: new Date() };
	t.mock.module('../config/db', { namedExports: { prisma: {
		notification: { create: async () => stored },
		providerProfile: { findUnique: async () => (o.providerPrefs ? { preferences: o.providerPrefs, user: { email: 'prov@example.com', firstName: 'م' } } : null) },
		notificationPreference: { findUnique: async () => (o.settings === undefined ? null : { settings: o.settings }) },
		clientProfile: { findUnique: async () => ({ interfaceLanguage: o.language ?? null }) },
		user: { findUnique: async () => ({ email: 'client@example.com', firstName: 'ليلى' }) }
	} } });
	const mod = await import(`./notification.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { ...mod, mails, pushes };
}
const settle = () => new Promise(r => setTimeout(r, 20));
const send = (svc: any) => svc.createAndEmit({ userId: 'u1', title: 'تسليم جديد', message: 'تم تسليم مرحلة', actionUrl: '/client-overview/projects/p1', type: 'STAGE_DELIVERY' });

test('resolveClientNotificationChannels: nothing saved = push on, email off; saved values are honoured', async t => {
	const { resolveClientNotificationChannels: r } = await load(t);
	assert.deepEqual(r(undefined), { push: true, email: false });
	assert.deepEqual(r({}), { push: true, email: false });
	assert.deepEqual(r({ inApp: false, email: true }), { push: false, email: true });
	assert.deepEqual(r({ inApp: true, email: false }), { push: true, email: false });
	assert.deepEqual(r({ requestStatus: false, email: true }, 'STAGE_DELIVERY'), { push: false, email: false });
	assert.deepEqual(r({ newOffer: false }, 'NEW_PROPOSAL'), { push: false, email: false });
	assert.deepEqual(r({ newOffer: false, email: true }, 'STAGE_DELIVERY'), { push: true, email: true });
	assert.deepEqual(r({ walletActivity: false }, 'ESCROW_FUNDED'), { push: false, email: false });
});

test('client with nothing saved: stored, real-time push, no mail (today\'s behaviour)', async t => {
	const { notificationService, mails, pushes } = await load(t);
	await send(notificationService); await settle();
	assert.equal(pushes.length, 1);
	assert.equal(mails.length, 0);
});

test('client saved e-mail on + in-app on: push AND a mail to the account e-mail, link inside /client-overview', async t => {
	const { notificationService, mails, pushes } = await load(t, { settings: { inApp: true, email: true } });
	await send(notificationService); await settle();
	assert.equal(pushes.length, 1);
	assert.equal(mails.length, 1);
	assert.equal(mails[0].to, 'client@example.com');
	assert.match(mails[0].html, /\/client-overview\/projects\/p1/);
	assert.match(mails[0].html, /dir="rtl"/);
});

test('client saved in-app off: stored (returned), no real-time push; e-mail still goes when on', async t => {
	const { notificationService, mails, pushes } = await load(t, { settings: { inApp: false, email: true } });
	const dto = await send(notificationService); await settle();
	assert.equal(dto.id, 'n1');
	assert.equal(pushes.length, 0);
	assert.equal(mails.length, 1);
});

test('client saved both off: stored only', async t => {
	const { notificationService, mails, pushes } = await load(t, { settings: { inApp: false, email: false } });
	const dto = await send(notificationService); await settle();
	assert.equal(dto.id, 'n1');
	assert.equal(mails.length + pushes.length, 0);
});

test('a switched-off topic silences both channels; an unrelated topic does not', async t => {
	const off = await load(t, { settings: { requestStatus: false, email: true } });
	await send(off.notificationService); await settle();
	assert.equal(off.mails.length + off.pushes.length, 0);
});

test('client e-mail follows the profile language: English mail is ltr with English copy', async t => {
	const { notificationService, mails } = await load(t, { settings: { email: true }, language: 'English' });
	await send(notificationService); await settle();
	assert.match(mails[0].html, /dir="ltr"/);
	assert.match(mails[0].html, /Hello ليلى/);
});

test('an account with BOTH roles: a /client-overview notification follows the CLIENT settings, not the provider channels', async t => {
	const { notificationService, mails, pushes } = await load(t, { providerPrefs: { notifChannels: [] }, settings: { inApp: true, email: true } });
	await send(notificationService); await settle();
	assert.equal(pushes.length, 1);
	assert.equal(mails.length, 1);
	assert.equal(mails[0].to, 'client@example.com');
});

test('a /provider-overview notification still follows the provider channels (unchanged)', async t => {
	const { notificationService, mails, pushes } = await load(t, { providerPrefs: { notifChannels: ['email'] }, settings: { inApp: true, email: false }, actionUrl: '/provider-overview/offers' });
	await notificationService.createAndEmit({ userId: 'u1', title: 'ت', message: 'م', actionUrl: '/provider-overview/offers' }); await settle();
	assert.equal(pushes.length, 0);
	assert.equal(mails.length, 1);
	assert.equal(mails[0].to, 'prov@example.com');
});

test('payment OTP e-mail has its own subject (not "تفعيل حسابك") and the code in the body', async t => {
	const { notificationService, mails, PAYMENT_OTP_DEFAULT_SUBJECT } = await load(t);
	await notificationService.sendPaymentOtpEmail('client@example.com', '123456');
	assert.equal(mails[0].subject, PAYMENT_OTP_DEFAULT_SUBJECT);
	assert.match(mails[0].subject, /تأكيد الدفع/);
	assert.doesNotMatch(mails[0].subject, /تفعيل حسابك/);
	await notificationService.sendEmailOtp('client@example.com', '123456');
	assert.match(mails[1].subject, /تفعيل حسابك/); // the activation mail keeps its own wording
	assert.match(mails[0].text, /123456/);
});
