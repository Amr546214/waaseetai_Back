import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Uniform public registration: the register answer reveals nothing about the account; the code step is keyed by the e-mail typed at
// registration. Stateful in-memory repository, real service + controller + schemas + send gate.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.RATE_LIMIT_ENABLED = 'true';

const PASSWORD = 'Str0ng!Pass1';
const BODY = { email: 'amr@example.com', phoneNumber: '0500000000', phoneCountryCode: '+966', password: PASSWORD, firstName: 'Amr', lastName: 'O', accountType: 'CLIENT_INDIVIDUAL', agreedToTerms: true };

async function world(t: TestContext, o: { activeOwner?: boolean; smtpFails?: boolean } = {}) {
	const store: { user: any; otps: any[]; mails: { kind: string; code?: string }[] } = { user: null, otps: [], mails: [] };
	if (o.activeOwner) store.user = { id: '33333333-3333-4333-8333-333333333333', email: BODY.email, firstName: 'Amr', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', password: 'x' };
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
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

async function call(handler: any, body: any) {
	const out: any = { status: 200, body: undefined, error: undefined, locals: {} };
	const res: any = { locals: out.locals, status(c: number) { out.status = c; return this; }, json(b: any) { out.body = b; return this; } };
	await handler({ body, ip: '1.1.1.1', get: () => '', headers: {} }, res, (e: any) => { out.error = e; });
	return out;
}
// module mocks can be installed once per context: every scenario world gets its own subtest
async function scenario<T>(t: TestContext, o: Parameters<typeof world>[1], fn: (w: Awaited<ReturnType<typeof world>>) => Promise<T>): Promise<T> {
	let r!: T;
	await t.test('scenario', async (st) => { r = await fn(await world(st, o)); });
	return r;
}
const flush = () => new Promise((r) => setImmediate(r));
const errOf = (p: Promise<unknown>) => p.then(() => null, (e) => ({ status: e.statusCode, message: e.message }));

test('flow: register (uniform answer) -> verify BY E-MAIL activates -> login works; the answer carries no id', async (t) => {
	const w = await world(t);
	const reg = await call(w.authController.register.bind(w.authController), BODY);
	assert.deepEqual(reg.body, { success: true, message: reg.body.message, data: {} });
	await flush();
	assert.equal(w.store.mails.length, 1);
	const code = w.store.mails[0].code!;
	const v = await w.authService.verifyOtp({ email: 'AMR@example.com ', code });
	assert.equal(w.store.user.status, 'ACTIVE');
	assert.ok(v.token);
	const login = await w.authService.loginUser({ email: BODY.email, password: PASSWORD }, { ipAddress: '9.9.9.9' });
	assert.equal((login as any).loginOtpRequired, true, 'an activated account goes on to the normal login-code step (not the activation one)');
});

test('verify by e-mail: unknown address, ACTIVE account, wrong code, no code, expired and locked all give the SAME 400 answer', async (t) => {
	const results: any[] = [];
	results.push(await scenario(t, {}, (w) => errOf(w.authService.verifyOtp({ email: 'ghost@example.com', code: '123456' }))));
	results.push(await scenario(t, { activeOwner: true }, (w) => errOf(w.authService.verifyOtp({ email: BODY.email, code: '123456' }))));
	for (const mode of ['wrong', 'none', 'expired', 'locked'] as const) {
		results.push(await scenario(t, {}, async (w) => {
			await w.authService.registerUser({ ...BODY });
			const real = w.store.otps[0].code;
			if (mode === 'none') w.store.otps = [];
			if (mode === 'expired') w.store.otps[0].expiresAt = new Date(Date.now() - 1000);
			if (mode === 'locked') w.store.otps[0].attempts = 5;
			// 'wrong' sends a wrong code; the other modes send the REAL code, so only the state of the code makes them fail
			const r = await errOf(w.authService.verifyOtp({ email: BODY.email, code: mode === 'wrong' ? (real === '000000' ? '111111' : '000000') : real }));
			assert.equal(w.store.user.status, 'PENDING_VERIFICATION', `${mode}: not activated`);
			return r;
		}));
	}
	for (const r of results) { assert.equal(r.status, 400); assert.deepEqual(r, results[0]); }
});

test('verify by e-mail: the fifth wrong guess deletes the code (still the same 400); the right code then needs a fresh one', async (t) => {
	const w = await world(t);
	await w.authService.registerUser({ ...BODY });
	const real = w.store.otps[0].code;
	const wrong = real === '000000' ? '111111' : '000000';
	for (let i = 0; i < 5; i++) assert.equal((await errOf(w.authService.verifyOtp({ email: BODY.email, code: wrong })))!.status, 400);
	assert.equal(w.store.otps.length, 0);
	assert.equal((await errOf(w.authService.verifyOtp({ email: BODY.email, code: real })))!.status, 400);
});

test('verify by id (login-while-pending path) keeps its specific messages and still works', async (t) => {
	const w = await world(t);
	const reg = await w.authService.registerUser({ ...BODY });
	const wrong = w.store.otps[0].code === '000000' ? '111111' : '000000';
	assert.equal((await errOf(w.authService.verifyOtp({ userId: reg.userId!, code: wrong })))!.message, 'رمز التحقق غير صحيح');
	await w.authService.verifyOtp({ userId: reg.userId!, code: w.store.otps[0].code });
	assert.equal(w.store.user.status, 'ACTIVE');
});

test('resend by e-mail: identical 200 body for pending / active / unknown; sends only for a pending account; no mail to active', async (t) => {
	const bodies: any[] = [];
	bodies.push(await scenario(t, {}, async (w) => {
		await w.authService.registerUser({ ...BODY });
		await flush();
		w.otpSendThrottle.reset();
		const r = await call(w.authController.resendOtp.bind(w.authController), { email: BODY.email });
		await flush();
		assert.equal(w.store.mails.length, 2, 'the pending account got its (same, still valid) code again');
		assert.equal(w.store.mails[1].code, w.store.mails[0].code);
		return r;
	}));
	bodies.push(await scenario(t, { activeOwner: true }, async (w) => {
		const r = await call(w.authController.resendOtp.bind(w.authController), { email: BODY.email });
		await flush();
		assert.equal(w.store.mails.length, 0, 'no alert / activation mail to an ACTIVE account');
		assert.equal(w.store.otps.length, 0);
		return r;
	}));
	bodies.push(await scenario(t, {}, async (w) => {
		const r = await call(w.authController.resendOtp.bind(w.authController), { email: 'ghost@example.com' });
		assert.equal(w.store.mails.length, 0);
		return r;
	}));
	for (const b of bodies) {
		assert.equal(b.status, 200);
		assert.deepEqual(b.body, bodies[0].body);
		assert.deepEqual(b.body.data, {});
		assert.equal(b.body.success, true);
		assert.deepEqual(b.locals, bodies[0].locals);
	}
});

test('resend by e-mail after a failed first send: the pending account gets its code (honest generic answer, failure only logged)', async (t) => {
	const w = await world(t, { smtpFails: true });
	const reg = await call(w.authController.register.bind(w.authController), BODY);
	assert.equal(reg.status, 201);
	await flush();
	assert.equal(w.store.otps.length, 1);
	assert.equal(w.store.mails.length, 1, 'the failing send was attempted once');
	w.otpSendThrottle.reset();
	const r = await call(w.authController.resendOtp.bind(w.authController), { email: BODY.email });
	await flush();
	assert.equal(r.status, 200);
	assert.equal(w.store.mails.length, 2);
});

test('cooldown / caps: the register and the e-mail resend share one per-address bucket that applies to every address alike', async (t) => {
	const w = await world(t);
	const { otpSendGate } = await import('../middlewares/rate-limit.middleware');
	const gate = otpSendGate((req: any) => req.body?.email);
	const go = (email: string) => {
		let err: any = null; const handlers: Record<string, () => void> = {};
		const res: any = { locals: { otpEmailAttempted: true, otpEmailSent: true }, setHeader() {}, once: (e: string, f: () => void) => { handlers[e] = f; } };
		gate({ body: { email }, ip: '4.4.4.4' } as any, res, (e?: unknown) => { if (e) err = e; });
		handlers.finish?.();
		return err;
	};
	for (const e of ['new@x.co', 'taken@x.co']) { assert.equal(go(e), null); assert.equal(go(e)?.statusCode, 429, `${e}: the second request inside the interval is refused alike`); }
	void w;
});

test('Back flow: a second POST /register for the same data creates no second account and sends nothing', async (t) => {
	const w = await world(t);
	await call(w.authController.register.bind(w.authController), BODY);
	await flush();
	const owner = w.store.user;
	const again = await call(w.authController.register.bind(w.authController), BODY);
	await flush();
	assert.equal(w.store.user, owner);
	assert.equal(w.store.mails.length, 1);
	assert.equal(again.status, 201);
});

test('schemas: verify-otp / resend-otp take exactly one of userId or email; wiring uses the identifier limiters', async () => {
	const { verifyOtpSchema, resendOtpSchema } = await import('../routes/auth/auth.schema');
	const uid = '11111111-1111-4111-8111-111111111111';
	assert.ok(verifyOtpSchema.safeParse({ body: { userId: uid, code: '123456' } }).success);
	assert.ok(verifyOtpSchema.safeParse({ body: { email: 'a@b.co', code: '123456' } }).success);
	assert.ok(!verifyOtpSchema.safeParse({ body: { code: '123456' } }).success);
	assert.ok(!verifyOtpSchema.safeParse({ body: { userId: uid, email: 'a@b.co', code: '123456' } }).success);
	assert.ok(!verifyOtpSchema.safeParse({ body: { email: 'not-an-email', code: '123456' } }).success);
	assert.ok(resendOtpSchema.safeParse({ body: { email: 'a@b.co' } }).success);
	assert.ok(!resendOtpSchema.safeParse({ body: {} }).success);
	const src = fs.readFileSync(path.join(__dirname, '../routes/auth/auth.routes.ts'), 'utf8');
	assert.match(src, /otpVerifyLimiters\(\(req\) => req\.body\?\.userId \?\? req\.body\?\.email\),\s*authController\.verifyOtp/);
	assert.match(src, /validateRequest\(resendOtpSchema\),\s*otpSendGate\(byUserId\)/);
});
