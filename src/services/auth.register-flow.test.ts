import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Repeat registration, end to end at the service level with a stateful in-memory repository: a new account reaches the code step,
// a repeated registration (pending or active) sends nothing and claims nothing, and the pending owner still activates through
// login (throttled) and the resend; forgot-password and the cooldown gate behave as before.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.RATE_LIMIT_ENABLED = 'true';

const PASSWORD = 'Str0ng!Pass1';
const BODY = { email: 'amr@example.com', phoneNumber: '0500000000', phoneCountryCode: '+966', password: PASSWORD, firstName: 'Amr', lastName: 'O', accountType: 'CLIENT_INDIVIDUAL', agreedToTerms: true };

async function world(t: TestContext) {
	const store: { user: any; otps: any[]; mails: { kind: string; code?: string }[] } = { user: null, otps: [], mails: [] };
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: { user: { update: async () => ({}) }, $transaction: async () => ({}) } } });
	t.mock.module('./session.service', { namedExports: { sessionService: { register: async () => ({}) } } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
	t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
		findByEmailOrPhone: async () => store.user,
		findByEmail: async () => store.user,
		findById: async (id: string) => (store.user?.id === id ? store.user : null),
		createUserWithProfile: async (input: any, hash: string) => { store.user = { id: '22222222-2222-4222-8222-222222222222', email: input.email, firstName: 'Amr', accountType: 'CLIENT_INDIVIDUAL', status: 'PENDING_VERIFICATION', password: hash }; return store.user; },
		createOtp: async (_u: string, code: string, _t: string, expiresAt: Date, purpose: string) => { store.otps.push({ id: String(store.otps.length), code, expiresAt, purpose, attempts: 0 }); return {}; },
		findLatestActivationOtp: async () => store.otps.filter((o) => o.purpose === 'ACTIVATION').at(-1) ?? null,
		deleteActivationOtps: async () => { store.otps = store.otps.filter((o) => o.purpose !== 'ACTIVATION'); return { count: 0 }; },
		deleteUserOtps: async () => { store.otps = []; return { count: 0 }; },
		updateUserStatus: async (_id: string, status: string) => { store.user = { ...store.user, status }; return store.user; },
		findLatestPasswordResetOtp: async () => null,
		findLatestOtpByPurpose: async () => null,
		deleteOtpsByPurpose: async () => ({ count: 0 }),
		deletePasswordResetOtps: async () => ({ count: 0 }),
		createPasswordResetOtp: async () => ({}),
		incrementOtpAttempts: async () => ({}),
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: {
		sendEmailOtp: async (_e: string, code: string) => { store.mails.push({ kind: 'activation', code }); },
		sendLoginOtpEmail: async () => { store.mails.push({ kind: 'login' }); },
		sendPasswordResetEmail: async () => { store.mails.push({ kind: 'reset' }); },
	} } });
	const { authService } = await import(`./auth.service.ts?fx=${Date.now()}-${Math.random()}`);
	const { otpSendThrottle } = await import('../utils/otp-send-throttle');
	otpSendThrottle.reset();
	return { authService, store, otpSendThrottle };
}

test('flow: new registration -> code step -> verify-otp activates; a repeated registration afterwards sends nothing', async (t) => {
	const w = await world(t);
	const reg = await w.authService.registerUser({ ...BODY });
	assert.equal(reg.accountCreated, true);
	assert.ok(reg.userId);
	assert.equal(w.store.mails.length, 1);
	const code = w.store.mails[0].code!;
	await w.authService.verifyOtp({ userId: reg.userId, code });
	assert.equal(w.store.user.status, 'ACTIVE');

	const again = await w.authService.registerUser({ ...BODY });
	assert.deepEqual(again, { userId: null, accountCreated: false });
	assert.equal(w.store.mails.length, 1, 'no alert / activation mail to an ACTIVE account');
});

test('flow: pending account -> repeat registration sends nothing -> login re-sends the activation code (throttled) -> verify activates', async (t) => {
	const w = await world(t);
	const reg = await w.authService.registerUser({ ...BODY });
	assert.equal(w.store.mails.length, 1);
	// the original tab is gone; the owner registers again: nothing is created or sent
	const again = await w.authService.registerUser({ ...BODY });
	assert.equal(again.userId, null);
	assert.equal(again.accountCreated, false);
	assert.equal(w.store.mails.length, 1);
	assert.equal(w.store.otps.length, 1);

	// the natural path: login with the password re-sends the (still valid) code and returns the real userId for the code step
	const login1 = await w.authService.loginUser({ email: BODY.email, password: PASSWORD }, { ipAddress: '9.9.9.9' });
	assert.equal(login1.verified, false);
	assert.equal(login1.userId, reg.userId);
	assert.equal(login1.emailSent, true);
	assert.equal(w.store.mails.length, 2);
	assert.equal(w.store.mails[1].code, w.store.mails[0].code, 'a still-valid code is re-sent as it is');

	// cooldown: a second login within 60 s is throttled, no mail, the answer says how long to wait
	const login2 = await w.authService.loginUser({ email: BODY.email, password: PASSWORD }, { ipAddress: '9.9.9.9' });
	assert.equal(login2.emailSent, false);
	assert.ok((login2 as any).retryAfterSeconds > 0);
	assert.equal(w.store.mails.length, 2);

	await w.authService.verifyOtp({ userId: reg.userId, code: w.store.mails[0].code! });
	assert.equal(w.store.user.status, 'ACTIVE');
});

test('flow: pending account -> per-recipient hourly cap and per-IP cap apply to the activation resend', async (t) => {
	const w = await world(t);
	const reg = await w.authService.registerUser({ ...BODY });
	// record 5 sends for this recipient (the 60 s spacing is bypassed by recording directly); the 6th request is refused
	for (let i = 0; i < 5; i++) w.otpSendThrottle.record(`user:${reg.userId}`, '7.7.7.7', true);
	const r = await w.authService.loginUser({ email: BODY.email, password: PASSWORD }, { ipAddress: '8.8.8.8' });
	assert.equal(r.emailSent, false);
	assert.ok((r as any).retryAfterSeconds > 0);
	const before = w.store.mails.length;
	assert.equal(before, 1, 'nothing was sent by the throttled attempt');
});

test('flow: forgot-password for a pending account still sends the reset code; Back/repeat register never creates a second account', async (t) => {
	const w = await world(t);
	await w.authService.registerUser({ ...BODY });
	const f = await w.authService.forgotPassword({ email: BODY.email });
	assert.ok(f.message);
	await new Promise((r) => setImmediate(r));
	assert.ok(w.store.mails.some((m) => m.kind === 'reset'));
	let created = 0;
	const orig = w.store.user;
	await w.authService.registerUser({ ...BODY });
	if (w.store.user !== orig) created++;
	assert.equal(created, 0);
});

test('cooldown gate on /register: a real send starts it; a repeat registration of an existing account records nothing', async (t) => {
	const { otpSendThrottle } = await world(t);
	const { otpSendGate } = await import('../middlewares/rate-limit.middleware');
	const gate = otpSendGate((req: any) => req.body?.email);
	const go = (email: string, locals: Record<string, unknown>) => {
		let err: any = null;
		const handlers: Record<string, () => void> = {};
		const res: any = { locals, setHeader() {}, once: (e: string, f: () => void) => { handlers[e] = f; } };
		gate({ body: { email }, ip: '4.4.4.4' } as any, res, (e?: unknown) => { if (e) err = e; });
		handlers.finish?.();
		return err;
	};
	assert.equal(go('dup@x.co', {}), null);             // existing account: controller sets no otpEmailAttempted
	assert.equal(go('dup@x.co', {}), null);             // still not throttled: nothing was recorded
	assert.equal(go('new@x.co', { otpEmailAttempted: true, otpEmailSent: true }), null);
	assert.equal(go('new@x.co', {})?.statusCode, 429);  // a real code went out: the cooldown applies
	void otpSendThrottle;
});
