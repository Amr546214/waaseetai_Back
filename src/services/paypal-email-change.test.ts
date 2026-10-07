import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// Finance #33: the provider's PayPal payout email changes only with an email OTP (purpose PAYPAL_EMAIL_CHANGE), never through PUT /update, and a
// confirmed change records the event that freezes PayPal withdrawals for 24 hours. Database, mail and notifications are replaced.
type Otp = { id: string; userId: string; code: string; type: string; expiresAt: Date; attempts: number; context: any; createdAt: number };
const state = { paypal: 'old@paypal.example' as string | null, otps: [] as Otp[], audit: [] as any[], upserts: [] as any[], sent: [] as { to: string; code: string }[], seq: 0 };
const hasPurpose = (o: Otp, where: any) => !where.context || o.context?.purpose === where.context.equals;
const db: any = {
	user: { findUnique: async () => ({ id: 'u1', email: 'owner@example.com', status: 'ACTIVE', phoneNumber: '0500000000' }) },
	providerProfile: {
		findUnique: async () => ({ paypalPayoutEmail: state.paypal }),
		update: async (a: any) => ({ id: 'p1', ...a.data }),
		upsert: async (a: any) => { state.upserts.push(a); state.paypal = a.update.paypalPayoutEmail ?? state.paypal; return { ...a.update }; },
	},
	otpVerification: {
		deleteMany: async ({ where }: any) => { state.otps = state.otps.filter(o => !(o.userId === where.userId && hasPurpose(o, where))); return { count: 0 }; },
		create: async ({ data }: any) => { const o = { id: `o${++state.seq}`, attempts: 0, createdAt: state.seq, ...data }; state.otps.push(o); return o; },
		findFirst: async ({ where }: any) => { const r = state.otps.filter(o => o.userId === where.userId && hasPurpose(o, where)).sort((a, b) => b.createdAt - a.createdAt)[0]; return r ? { ...r } : null; },
		delete: async ({ where }: any) => { state.otps = state.otps.filter(o => o.id !== where.id); return {}; },
		update: async ({ where, data }: any) => { const o = state.otps.find(x => x.id === where.id)!; if (data.attempts?.increment) o.attempts += data.attempts.increment; return o; },
	},
	accountAuditLog: {
		create: async ({ data }: any) => { state.audit.push({ ...data, occurredAt: new Date() }); return {}; },
		findFirst: async ({ where }: any) => state.audit.filter(a => a.userId === where.userId && a.eventType === where.eventType && a.occurredAt > where.occurredAt.gt).sort((a, b) => +b.occurredAt - +a.occurredAt)[0] ?? null,
	},
};
db.$transaction = async (fn: any) => fn(db);

let loaded: Promise<{ paypal: any; profile: any }> | undefined;
function load() {
	loaded ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma: db } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../utils/socket-registry', { namedExports: { disconnectUserSockets: async () => 0 } });
		mock.module('./notification.service', { namedExports: { notificationService: {
			sendPaypalEmailChangeOtpEmail: async (to: string, code: string) => { state.sent.push({ to, code }); },
			createAndEmit: async () => ({}),
		} } });
		const { paypalEmailChangeService } = await import('./paypal-email-change.service.ts');
		const { profileService } = await import('./profile.service.ts');
		return { paypal: paypalEmailChangeService, profile: profileService };
	})();
	return loaded;
}
const reset = async () => {
	const { paypal } = await load();
	const { otpSendThrottle } = await import('../utils/otp-send-throttle');
	otpSendThrottle.reset();
	Object.assign(state, { paypal: 'old@paypal.example', otps: [], audit: [], upserts: [], sent: [] });
	return paypal;
};

test('no direct update: PUT /profiles/update refuses a different PayPal email (and clearing it) in Arabic and writes nothing', async () => {
	await reset();
	const { profile } = await load();
	for (const value of ['new@paypal.example', '', null]) {
		await assert.rejects(() => profile.updateProfile('u1', 'PROVIDER', { paypalPayoutEmail: value } as any), (e: any) => e.statusCode === 400 && /رمز تحقق/.test(e.message));
	}
	assert.equal(state.paypal, 'old@paypal.example');
	assert.equal(state.upserts.length, 0);
	// the unchanged value is ignored, not an error, and is never written
	await profile.updateProfile('u1', 'PROVIDER', { paypalPayoutEmail: 'OLD@paypal.example' } as any);
	for (const u of state.upserts) assert.equal('paypalPayoutEmail' in u.update, false);
});

test('request: a code with purpose PAYPAL_EMAIL_CHANGE goes to the ACCOUNT email; the new address is only pending', async () => {
	const paypal = await reset();
	const r = await paypal.requestChange('u1', 'New@PayPal.example', undefined);
	assert.equal(r.emailSent, true);
	assert.deepEqual(state.sent.map(s => s.to), ['owner@example.com']);
	assert.equal(state.otps[0].context.purpose, 'PAYPAL_EMAIL_CHANGE');
	assert.equal(state.otps[0].context.newEmail, 'new@paypal.example');
	assert.equal(state.paypal, 'old@paypal.example');
	await assert.rejects(() => paypal.requestChange('u1', 'not-an-email', undefined), (e: any) => e.statusCode === 400);
	await assert.rejects(() => paypal.requestChange('u1', 'old@paypal.example', undefined), (e: any) => e.statusCode === 400);
});

test('confirm: a wrong code is refused (the 5th locks it), the address does not change and nothing starts the freeze', async () => {
	const paypal = await reset();
	await paypal.requestChange('u1', 'new@paypal.example', undefined);
	const wrong = state.sent[0].code === '000000' ? '111111' : '000000';
	for (let i = 0; i < 4; i++) await assert.rejects(() => paypal.confirmChange('u1', wrong), (e: any) => e.statusCode === 400);
	await assert.rejects(() => paypal.confirmChange('u1', wrong), (e: any) => e.statusCode === 429);
	assert.equal(state.paypal, 'old@paypal.example');
	assert.equal(state.audit.length, 0);
	assert.equal(await paypal.frozenUntil('u1'), null);
});

test('confirm: the right code writes the new address once, records the change and starts the 24 hour freeze', async () => {
	const paypal = await reset();
	await paypal.requestChange('u1', 'new@paypal.example', undefined);
	const r = await paypal.confirmChange('u1', state.sent[0].code);
	assert.equal(r.paypalPayoutEmail, 'new@paypal.example');
	assert.equal(state.paypal, 'new@paypal.example');
	assert.equal(state.audit[0].eventType, 'PAYPAL_EMAIL_CHANGED');
	const until = await paypal.frozenUntil('u1');
	assert.ok(until && Math.abs(+until - (Date.now() + 24 * 3600_000)) < 5000);
	await assert.rejects(() => paypal.confirmChange('u1', state.sent[0].code), (e: any) => e.statusCode === 400, 'the code is single-use');
});

test('freeze: still frozen at 23h59m, lifted after 24 hours', async () => {
	const paypal = await reset();
	state.audit.push({ userId: 'u1', eventType: 'PAYPAL_EMAIL_CHANGED', occurredAt: new Date(Date.now() - (24 * 3600_000 - 60_000)) });
	assert.ok(await paypal.frozenUntil('u1'));
	state.audit.length = 0;
	state.audit.push({ userId: 'u1', eventType: 'PAYPAL_EMAIL_CHANGED', occurredAt: new Date(Date.now() - (24 * 3600_000 + 60_000)) });
	assert.equal(await paypal.frozenUntil('u1'), null);
});

test('other OTP purposes (login, forgot-password, phone change, activation) cannot confirm a PayPal email change', async () => {
	const paypal = await reset();
	for (const purpose of ['LOGIN_EMAIL', 'PASSWORD_RESET', 'PHONE_CHANGE', 'ACTIVATION', 'SENSITIVE_CHANGE']) {
		state.otps.push({ id: `x-${purpose}`, userId: 'u1', code: '123456', type: 'EMAIL', expiresAt: new Date(Date.now() + 60_000), attempts: 0, context: { purpose, newEmail: 'evil@paypal.example' }, createdAt: 99 });
	}
	await assert.rejects(() => paypal.confirmChange('u1', '123456'), (e: any) => e.statusCode === 400);
	assert.equal(state.paypal, 'old@paypal.example');
	assert.equal(state.audit.length, 0);
});
