import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Operator-only outcome lines for register / resend (the public answer stays uniform); world copied from the uniform test.
// Uniform public registration: the register answer reveals nothing about the account; the code step is keyed by the e-mail typed at
// registration. Stateful in-memory repository, real service + controller + schemas + send gate.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.RATE_LIMIT_ENABLED = 'true';

const LOG: string[] = [];
const PASSWORD = 'Str0ng!Pass1';
const BODY = { email: 'amr@example.com', phoneNumber: '0500000000', phoneCountryCode: '+966', password: PASSWORD, firstName: 'Amr', lastName: 'O', accountType: 'CLIENT_INDIVIDUAL', agreedToTerms: true };

async function world(t: TestContext, o: { activeOwner?: boolean; smtpFails?: boolean; owner?: any } = {}) {
	LOG.length = 0;
	const store: { user: any; otps: any[]; mails: { kind: string; code?: string }[] } = { user: null, otps: [], mails: [] };
	if (o.owner) store.user = o.owner;
	if (o.activeOwner) store.user = { id: '33333333-3333-4333-8333-333333333333', email: BODY.email, firstName: 'Amr', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', password: 'x' };
	t.mock.module('../config/logger', { namedExports: { logger: { info(m: string) { LOG.push(String(m)); }, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: { user: { update: async () => ({}) }, $transaction: async () => ({}) } } });
	t.mock.module('./session.service', { namedExports: { sessionService: { register: async () => ({}) } } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
	t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
		findByEmailOrPhone: async () => store.user,
		findByEmail: async (e: string) => (store.user && store.user.email === e.trim().toLowerCase() ? store.user : null),
		findById: async (id: string) => (store.user?.id === id ? store.user : null),
		createUserWithProfile: async (input: any, hash: string) => { store.user = { id: '22222222-2222-4222-8222-222222222222', email: input.email, firstName: 'Amr', accountType: 'CLIENT_INDIVIDUAL', status: 'PENDING_VERIFICATION', password: hash }; return store.user; },
		createOtp: async (_u: string, code: string, _t: string, expiresAt: Date, purpose: string) => { store.otps.push({ id: String(store.otps.length), code, expiresAt, purpose, attempts: 0 }); return {}; },
		findLatestActivationOtp: async () => store.otps.filter((x) => x.purpose === 'ACTIVATION').at(-1) ?? null,
		deleteActivationOtps: async () => { store.otps = store.otps.filter((x) => x.purpose !== 'ACTIVATION'); return { count: 0 }; },
		deleteUserOtps: async () => { store.otps = []; return { count: 0 }; },
		updateUserStatus: async (_id: string, status: string) => { store.user = { ...store.user, status }; return store.user; },
		incrementOtpAttempts: async (id: string) => { const x = store.otps.find((q) => q.id === id); if (x) x.attempts++; return {}; },
		findLatestPasswordResetOtp: async () => null,
		findLatestOtpByPurpose: async () => null,
		deleteOtpsByPurpose: async () => ({ count: 0 }),
		deletePasswordResetOtps: async () => ({ count: 0 }),
		createPasswordResetOtp: async () => ({}),
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: {
		sendEmailOtp: async (_e: string, code: string) => { store.mails.push({ kind: 'activation', code }); if (o.smtpFails) throw new Error('smtp'); },
		sendLoginOtpEmail: async () => { store.mails.push({ kind: 'login' }); },
		sendPasswordResetEmail: async () => { store.mails.push({ kind: 'reset' }); },
	} } });
	const { authService } = await import(`./auth.service.ts?fx=${Date.now()}-${Math.random()}`);
	t.mock.module('./auth.service', { namedExports: { authService } });
	const { authController } = await import(`../controllers/auth.controller.ts?fx=${Date.now()}-${Math.random()}`);
	const { otpSendThrottle } = await import('../utils/otp-send-throttle');
	otpSendThrottle.reset();
	return { authService, authController, store, otpSendThrottle };
}


// the service stores the LOCAL number (no trunk zero): +966 0500000000 -> 500000000
const OTHER = { id: '44444444-4444-4444-8444-444444444444', email: 'other@example.com', phoneNumber: '500000000', phoneCountryCode: '+966', firstName: 'X', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', password: 'x' };
const line = (tag: string) => LOG.find((l) => l.startsWith(tag))!;

test('register log: a PHONE-only conflict says conflict=phone, masks the address, and never contains the phone, the owner or the password', async (t) => {
	const w = await world(t, { owner: { ...OTHER } });
	await w.authService.registerUser({ ...BODY });
	const l = line('[Register]');
	assert.match(l, /outcome=in-use-nothing-created/);
	assert.match(l, /conflict=phone status=ACTIVE/);
	assert.match(l, /to=a\*\*\*@example\.com/);
	assert.doesNotMatch(l, /other@|500000000|Str0ng/);
	assert.equal(w.store.mails.length, 0);
	assert.equal(w.store.otps.length, 0);
});

test('register log: EMAIL-only conflict -> conflict=email', async (t) => {
	const a = await world(t, { owner: { ...OTHER, email: BODY.email, phoneNumber: '511111111' } });
	await a.authService.registerUser({ ...BODY });
	assert.match(line('[Register]'), /conflict=email status=ACTIVE/);
});

test('register log: same email and phone, pending owner -> conflict=email+phone', async (t) => {
	const b = await world(t, { owner: { ...OTHER, email: BODY.email, status: 'PENDING_VERIFICATION' } });
	await b.authService.registerUser({ ...BODY });
	assert.match(line('[Register]'), /conflict=email\+phone status=PENDING_VERIFICATION/);
});

test('register: another country code with the same local number is the SAME phone (the unique index is on the local number)', async (t) => {
	const w = await world(t, { owner: { ...OTHER, phoneCountryCode: '+20' } });
	await w.authService.registerUser({ ...BODY });
	assert.match(line('[Register]'), /conflict=phone/);
	assert.equal(w.store.mails.length, 0);
});

test('resend by e-mail: unknown address -> nothing sent, reason no-account; the public result is the same void', async (t) => {
	const w = await world(t);
	assert.equal(await w.authService.resendOtpByEmail('ghost@example.com'), undefined);
	assert.match(line('[Resend]'), /outcome=nothing-sent .*reason=no-account-for-this-email/);
	assert.equal(w.store.mails.length, 0);
});

test('resend by e-mail: ACTIVE account -> nothing sent, reason account-active', async (t) => {
	const w = await world(t, { activeOwner: true });
	await w.authService.resendOtpByEmail(BODY.email);
	assert.match(line('[Resend]'), /nothing-sent .*reason=account-active/);
	assert.equal(w.store.mails.length, 0);
});

test('resend by e-mail: PENDING account -> queued, one activation mail, the code is in no log line', async (t) => {
	const w = await world(t, { owner: { ...OTHER, email: BODY.email, status: 'PENDING_VERIFICATION' } });
	await w.authService.resendOtpByEmail(BODY.email);
	await new Promise((r) => setImmediate(r));
	assert.match(line('[Resend]'), /outcome=queued .*code=new/);
	assert.equal(w.store.mails.length, 1);
	assert.ok(!LOG.join('\n').includes(w.store.mails[0].code!));
});
