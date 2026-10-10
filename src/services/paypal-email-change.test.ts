import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// Finance #33: the provider's PayPal payout email changes only with an email OTP (purpose PAYPAL_EMAIL_CHANGE), never through PUT /update, and a
// confirmed change records the event that freezes PayPal withdrawals for 24 hours. Database, mail and notifications are replaced.
type Otp = { id: string; userId: string; code: string; type: string; expiresAt: Date; attempts: number; context: any; createdAt: number };
const state = { paypal: 'old@paypal.example' as string | null, otps: [] as Otp[], audit: [] as any[], upserts: [] as any[], sent: [] as { to: string; code: string }[], seq: 0, failMail: false };
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
			sendPaypalEmailChangeOtpEmail: async (to: string, code: string) => { if (state.failMail) throw new Error('SMTP rejected the recipient'); state.sent.push({ to, code }); },
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
	Object.assign(state, { paypal: 'old@paypal.example', otps: [], audit: [], upserts: [], sent: [], failMail: false });
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
	// the log says it was confirmed by the e-mail code and was NOT human-reviewed; it is COMPLETED at once
	assert.match(state.audit[0].title, /مؤكَّد برمز التحقق/);
	assert.match(state.audit[0].actionText, /دون مراجعة يدوية/);
	assert.equal(state.audit[0].status, 'COMPLETED');
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

test('policy: a PayPal email change is OTP-confirmed and immediate — it never creates an admin review / modification request', async () => {
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('./paypal-email-change.service.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
	assert.doesNotMatch(src, /profileModificationRequest|profileChangeRequest|PENDING_HUMAN_REVIEW|IN_REVIEW|adminReview/i);
});

test('request, ADD mode (no PayPal email yet): the code goes to the account email, mode is "add", the hint is the masked ACCOUNT email', async () => {
	const paypal = await reset();
	state.paypal = null;
	const r = await paypal.requestChange('u1', 'first@paypal.example', undefined);
	assert.equal(r.emailSent, true); assert.equal(r.mode, 'add');
	assert.equal(r.emailHint, 'o***@example.com');
	assert.equal(r.expiresInSeconds, 600);
	assert.deepEqual(state.sent.map(x => x.to), ['owner@example.com']);
	assert.equal(state.otps[0].context.purpose, 'PAYPAL_EMAIL_CHANGE');
	assert.ok(+state.otps[0].expiresAt > Date.now() + 9 * 60_000 && +state.otps[0].expiresAt <= Date.now() + 10 * 60_000 + 1000, 'expires in 10 minutes');
	assert.equal(state.paypal, null, 'nothing is saved before the code is confirmed');
	// confirming an ADD applies it and starts the freeze too
	await paypal.confirmChange('u1', state.sent[0].code);
	assert.equal(state.paypal, 'first@paypal.example');
	assert.ok(await paypal.frozenUntil('u1'));
});

test('request, CHANGE mode (a PayPal email exists): mode is "change" and the code still goes to the account email', async () => {
	const paypal = await reset();
	const r = await paypal.requestChange('u1', 'second@paypal.example', undefined);
	assert.equal(r.mode, 'change');
	assert.deepEqual(state.sent.map(x => x.to), ['owner@example.com']);
});

test('mail failure: a controlled 503 (code PAYPAL_OTP_EMAIL_FAILED), no success shape, and no pending code is left behind', async () => {
	const paypal = await reset();
	state.failMail = true;
	await assert.rejects(() => paypal.requestChange('u1', 'new@paypal.example', undefined), (e: any) =>
		e.statusCode === 503 && e.code === 'PAYPAL_OTP_EMAIL_FAILED' && e.message === 'تعذر إرسال رمز التحقق، حاول مرة أخرى');
	assert.equal(state.otps.length, 0);
	assert.equal(state.sent.length, 0);
	assert.equal(state.paypal, 'old@paypal.example');
});

test('resend too soon: 429 with code OTP_THROTTLED and retryAfterSeconds (a clear wait, not a silent failure)', async () => {
	const paypal = await reset();
	await paypal.requestChange('u1', 'new@paypal.example', undefined);
	await assert.rejects(() => paypal.requestChange('u1', 'new@paypal.example', undefined), (e: any) =>
		e.statusCode === 429 && e.code === 'OTP_THROTTLED' && e.retryAfterSeconds > 0 && /انتظر|بعد/.test(e.message));
	assert.equal(state.sent.length, 1, 'no second mail');
});

test('the confirmation e-mail subject is distinguishable: "رمز تأكيد بريد PayPal"', async () => {
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('./notification.service.ts', import.meta.url), 'utf8');
	assert.match(src, /PAYPAL_CHANGE_EMAIL_SUBJECT \?\? 'رمز تأكيد بريد PayPal - Waseet AI'/);
});
