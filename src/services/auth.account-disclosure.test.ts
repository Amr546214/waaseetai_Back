import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Unauthenticated auth endpoints answer the same status + body shape + wording whether or not the account exists (owner request:
// no unnecessary account-existence disclosure). Real controller + real service, mocked repository / mailer.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
import { REGISTER_GENERIC_MESSAGE } from '../utils/auth-messages';

const USER: any = { id: '11111111-1111-4111-8111-111111111111', email: 'amr@example.com', phoneNumber: '500000000', firstName: 'Amr', status: 'ACTIVE', password: null };
const GHOST_ID = '99999999-9999-4999-8999-999999999999';
const BODY = { email: 'amr@example.com', phoneNumber: '0500000000', phoneCountryCode: '+966', password: 'Str0ng!Pass1', firstName: 'Amr', lastName: 'O', accountType: 'CLIENT_INDIVIDUAL', agreedToTerms: true };

function setup(t: TestContext, o: { exists: boolean; status?: string; resetOtp?: any; googleEmail?: string; googleSub?: string; googleId?: string | null; smtpFails?: boolean; password?: string | null }) {
	const user = o.exists ? { ...USER, status: o.status ?? 'ACTIVE', googleId: o.googleId ?? null, ...(o.password !== undefined ? { password: o.password } : {}) } : null;
	const calls = { createUser: 0, createOtp: 0, mails: 0 };
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: { user: { update: async () => ({ ...user }) } } } });
	t.mock.module('./session.service', { namedExports: { sessionService: { register: async () => ({}) } } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
	t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
		findByEmailOrPhone: async () => user,
		findByEmail: async () => user,
		findById: async (id: string) => (user && id === user.id ? user : null),
		createUserWithProfile: async () => { calls.createUser++; return { id: '22222222-2222-4222-8222-222222222222', email: BODY.email }; },
		createOtp: async () => { calls.createOtp++; return {}; },
		findLatestActivationOtp: async () => null,
		deleteActivationOtps: async () => ({ count: 0 }),
		findLatestPasswordResetOtp: async () => o.resetOtp ?? null,
		findLatestOtpByPurpose: async () => null,
		deleteOtpsByPurpose: async () => ({ count: 0 }),
		deletePasswordResetOtps: async () => ({ count: 0 }),
		createPasswordResetOtp: async () => ({}),
		incrementOtpAttempts: async () => ({}),
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: {
		sendEmailOtp: async () => { calls.mails++; if (o.smtpFails) throw new Error('smtp'); },
		sendLoginOtpEmail: async () => { calls.mails++; },
		sendPasswordResetEmail: async () => { calls.mails++; },
	} } });
	t.mock.module('google-auth-library', { namedExports: { OAuth2Client: class { async verifyIdToken() { return { getPayload: () => ({ sub: o.googleSub ?? 'g-sub', email: o.googleEmail ?? BODY.email, email_verified: true, given_name: 'A', family_name: 'B' }) }; } } } });
	return calls;
}

async function load(t: TestContext) {
	// the service module is cached across scenarios: load a fresh copy (bound to this scenario's mocks) and give it to the controller
	const { authService } = await import(`./auth.service.ts?fx=${Date.now()}-${Math.random()}`);
	t.mock.module('./auth.service', { namedExports: { authService } });
	const { authController } = await import(`../controllers/auth.controller.ts?fx=${Date.now()}-${Math.random()}`);
	const { otpSendThrottle } = await import('../utils/otp-send-throttle');
	otpSendThrottle.reset();
	return authController;
}

// Each scenario gets its own subtest context: module mocks can be installed only once per context.
async function run<T>(t: TestContext, o: Parameters<typeof setup>[1], fn: (c: any, calls: ReturnType<typeof setup>) => Promise<T>): Promise<T> {
	let result!: T;
	await t.test('scenario', async (st) => { const calls = setup(st, o); result = await fn(await load(st), calls); });
	return result;
}

async function call(handler: (req: any, res: any, next: any) => Promise<void>, body: any) {
	const out: any = { status: 200, body: undefined, error: undefined, locals: {} };
	const res: any = { locals: out.locals, status(c: number) { out.status = c; return this; }, json(b: any) { out.body = b; return this; } };
	await handler({ body, ip: '1.1.1.1', get: () => '', headers: {} }, res, (e: any) => { out.error = e; });
	return out;
}

// Same status, same keys, same wording; only the id value may differ (an opaque UUID either way).
function shape(r: any) {
	if (r.error) return { status: r.error.statusCode, message: r.error.message, keys: 'error' };
	const data = r.body?.data;
	return { status: r.status, message: r.body?.message, keys: Object.keys(r.body ?? {}).sort().join(','), dataKeys: data ? Object.keys(data).sort().join(',') : undefined, success: r.body?.success, emailSent: r.body?.emailSent ?? data?.emailSent, uuid: typeof data?.userId === 'string' ? /^[0-9a-f-]{36}$/i.test(data.userId) : undefined };
}

// The response SHAPE is the same (status, keys, data keys); the two things that differ are the ones a caller needs to continue: a real
// userId only when an account was created for THIS request (so the app can open the code step), and accountCreated.
test('register: an email / phone already in use (active or pending) gets 201, the same shape as a fresh registration, no userId, no code claim, and creates / sends nothing', async (t) => {
	const fresh = await run(t, { exists: false }, async (c, calls) => { const r = await call(c.register.bind(c), BODY); assert.equal(calls.createUser, 1); assert.equal(calls.createOtp, 1); assert.equal(calls.mails, 1); return r; });
	const results: any[] = [];
	for (const status of ['ACTIVE', 'PENDING_VERIFICATION']) {
		results.push(await run(t, { exists: true, status }, async (c, used) => {
			const r = await call(c.register.bind(c), BODY);
			assert.equal(used.createUser, 0);
			assert.equal(used.createOtp, 0, `${status}: no code is created`);
			assert.equal(used.mails, 0, `${status}: no mail at all, no alert to an active account`);
			return r;
		}));
	}
	const [active, pending] = results;
	assert.deepEqual(shape(pending), shape(active), 'active and pending are indistinguishable');
	for (const r of results) {
		assert.equal(r.status, 201);
		assert.equal(r.error, undefined);
		assert.equal(r.body.data.userId, null);
		assert.equal(r.body.data.emailSent, false);
		assert.equal(r.body.data.accountCreated, false);
		assert.equal(r.body.message, REGISTER_GENERIC_MESSAGE);
		assert.ok(!r.locals.otpEmailAttempted, 'no mailer call, so no cooldown is recorded');
		assert.doesNotMatch(JSON.stringify(r.body), /أرسلنا رمز|مسجل بالفعل|موجود بالفعل|USER_ID_PLACEHOLDER/);
		assert.ok(!JSON.stringify(r.body).includes(USER.id));
	}
	// same keys at every level as the real registration
	assert.equal(Object.keys(active.body).sort().join(), Object.keys(fresh.body).sort().join());
	assert.equal(Object.keys(active.body.data).sort().join(), Object.keys(fresh.body.data).sort().join());
	assert.equal(fresh.status, active.status);
	// the only revealed difference: a real account id (and the flag) for the caller's own new account
	assert.match(fresh.body.data.userId, /^[0-9a-f-]{36}$/i);
	assert.equal(fresh.body.data.accountCreated, true);
	assert.equal(fresh.body.data.emailSent, true);
	assert.equal(fresh.body.message, REGISTER_GENERIC_MESSAGE, 'a new account whose code went out gets the same words (no extra channel)');
	assert.ok(fresh.locals.otpEmailAttempted && fresh.locals.otpEmailSent);
});

test('register: a new account whose activation email failed is told so honestly (with its real userId, so it can resend)', async (t) => {
	const r = await run(t, { exists: false, smtpFails: true }, (c) => call(c.register.bind(c), BODY));
	assert.equal(r.status, 201);
	assert.equal(r.body.data.emailSent, false);
	assert.equal(r.body.data.accountCreated, true);
	assert.ok(r.body.data.userId);
	assert.match(r.body.message, /تعذر إرسال رمز التحقق/);
	assert.equal(r.locals.otpEmailAttempted, true);
	assert.equal(r.locals.otpEmailSent, false);
});

test('register: a phone that matches another account (different email) is also generic', async (t) => {
	const r = await run(t, { exists: true, status: 'PENDING_VERIFICATION' }, (c) => call(c.register.bind(c), { ...BODY, email: 'someone.else@example.com' }));
	assert.equal(r.status, 201);
	assert.equal(r.body.data.userId, null);
	assert.equal(r.body.message, REGISTER_GENERIC_MESSAGE);
});

test('register with a VERIFIED Google credential for that very address may be told the account exists (409)', async (t) => {
	const own = await run(t, { exists: true }, (c) => call(c.register.bind(c), { ...BODY, password: undefined, googleIdToken: 'tok' }));
	assert.equal(own.error?.statusCode, 409);
	assert.match(own.error.message, /موجود بالفعل/);
});

test('forgot-password: same status/body for a known and an unknown email', async (t) => {
	const known = await run(t, { exists: true }, (c) => call(c.forgotPassword.bind(c), { email: BODY.email }));
	const unknown = await run(t, { exists: false }, (c) => call(c.forgotPassword.bind(c), { email: BODY.email }));
	assert.deepEqual(shape(unknown), shape(known));
	assert.equal(known.status, 200);
});

test('verify-reset-code: unknown email, no code, wrong code and an EXPIRED code all give the same 400 + wording', async (t) => {
	const results: any[] = [];
	for (const o of [
		{ exists: false },
		{ exists: true },
		{ exists: true, resetOtp: { id: 'o', code: '111111', attempts: 0, expiresAt: new Date(Date.now() + 60_000) } },
		{ exists: true, resetOtp: { id: 'o', code: '222222', attempts: 0, expiresAt: new Date(Date.now() - 60_000) } },
	]) {
		results.push(shape(await run(t, o, (c) => call(c.verifyResetCode.bind(c), { email: BODY.email, code: '999999' }))));
	}
	for (const r of results) assert.deepEqual(r, results[0]);
	assert.equal(results[0].status, 400);
});

test('login: unknown email and wrong password give the same 401 + wording', async (t) => {
	const unknown = await run(t, { exists: false }, (c) => call(c.login.bind(c), { email: BODY.email, password: 'Whatever!123' }));
	const known = await run(t, { exists: true }, (c) => call(c.login.bind(c), { email: BODY.email, password: 'Whatever!123' }));
	assert.deepEqual(shape(unknown), shape(known));
	assert.equal(known.error.statusCode, 401);
});

test('resend-otp: unknown id, active account and pending account answer 200 with the same shape and wording', async (t) => {
	const out: any[] = [];
	for (const o of [{ exists: false }, { exists: true, status: 'ACTIVE' }, { exists: true, status: 'PENDING_VERIFICATION' }]) {
		out.push(shape(await run(t, o, (c) => call(c.resendOtp.bind(c), { userId: o.exists ? USER.id : GHOST_ID }))));
	}
	for (const r of out) assert.deepEqual(r, out[0]);
	assert.equal(out[0].status, 200);
	assert.equal(out[0].success, true);
});

test('resend login code: unknown id and an account that is not mid-login answer the same, and send nothing', async (t) => {
	const out: any[] = [];
	for (const o of [{ exists: false }, { exists: true, status: 'ACTIVE' }]) {
		out.push(await run(t, o, async (c, calls) => { const r = shape(await call(c.resendLoginOtp.bind(c), { userId: o.exists ? USER.id : GHOST_ID })); assert.equal(calls.mails, 0); return r; }));
	}
	assert.deepEqual(out[1], out[0]);
	assert.equal(out[0].status, 200);
});

test('google (verified token): routing details stay, but a different linked Google identity is not spelled out', async (t) => {
	const r = await run(t, { exists: true, googleId: 'someone-elses-sub', googleSub: 'g-sub' }, (c) => call(c.googleAuth.bind(c), { idToken: 'tok', intent: 'login' }));
	assert.equal(r.error.statusCode, 401);
	assert.doesNotMatch(r.error.message, /المرتبط/);

	const none = await run(t, { exists: false }, (c) => call(c.googleAuth.bind(c), { idToken: 'tok', intent: 'login' }));
	assert.equal(none.error.statusCode, 404);
	assert.match(none.error.message, /إنشاء حساب/);

	const dup = await run(t, { exists: true }, (c) => call(c.googleAuth.bind(c), { idToken: 'tok', intent: 'register' }));
	assert.equal(dup.error.statusCode, 409);
});
