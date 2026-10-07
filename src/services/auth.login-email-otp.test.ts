import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Owner decision #4: OTP is mandatory at login, by EMAIL only. A correct password starts a LOGIN_EMAIL challenge; the session exists only
// after the right code; a code of another purpose (forgot-password, activation, phone change) never works here.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

type Row = { id: string; userId: string; code: string; attempts: number; expiresAt: Date; purpose: string; createdAt: number };

function setup(t: TestContext, hash: string) {
	const user = { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', lastName: 'O', status: 'ACTIVE', password: hash, accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', roles: ['CLIENT'] };
	const rows: Row[] = [];
	const sent: { to: string; code: string }[] = [];
	const sessions: string[] = [];
	let seq = 0;
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: {} } });
	t.mock.module('./session.service', { namedExports: { sessionService: { register: async (id: string) => { sessions.push(id); return {}; } } } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
	t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
		findByEmail: async () => ({ ...user }),
		findById: async () => ({ ...user }),
		findByIdForSession: async () => ({ ...user }),
		createOtp: async (userId: string, code: string, _type: string, expiresAt: Date, purpose: string) => { rows.push({ id: `o${++seq}`, userId, code, attempts: 0, expiresAt, purpose, createdAt: seq }); return {}; },
		findLatestOtpByPurpose: async (userId: string, purpose: string) => (() => { const r = rows.filter(x => x.userId === userId && x.purpose === purpose).sort((a, b) => b.createdAt - a.createdAt)[0]; return r ? { ...r } : null; })(),
		deleteOtpsByPurpose: async (userId: string, purpose: string) => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === userId && rows[i].purpose === purpose) rows.splice(i, 1); return { count: 0 }; },
		incrementOtpAttempts: async (id: string) => { rows.find(r => r.id === id)!.attempts++; return {}; },
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { sendLoginOtpEmail: async (to: string, code: string) => { sent.push({ to, code }); } } } });
	return { user, rows, sent, sessions };
}

async function load() {
	const { authService } = await import(`./auth.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const { otpSendThrottle } = await import('../utils/otp-send-throttle');
	otpSendThrottle.reset();
	return Object.assign(authService, { __throttle: otpSendThrottle });
}
const PW = 'Str0ng!Pass1';
const hashed = async () => (await import('bcrypt')).hash(PW, 4);

test('login with the right password returns a LOGIN_EMAIL challenge: no token, code e-mailed to the account email', async (t) => {
	const { rows, sent, sessions } = setup(t, await hashed());
	const auth = await load();
	const r: any = await auth.loginUser({ email: 'amr@example.com', password: PW }, {});
	assert.equal(r.verified, false);
	assert.equal(r.loginOtpRequired, true);
	assert.equal(r.userId, 'user-1');
	assert.equal(r.emailSent, true);
	assert.equal(r.token, undefined);
	assert.equal(sessions.length, 0);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].purpose, 'LOGIN_EMAIL');
	assert.deepEqual(sent.map(s => s.to), ['amr@example.com']);
});

test('a wrong password never starts a challenge', async (t) => {
	const { rows, sent } = setup(t, await hashed());
	const auth = await load();
	await assert.rejects(() => auth.loginUser({ email: 'amr@example.com', password: 'Wrong!Pass1' }, {}), (e: any) => e.statusCode === 401);
	assert.equal(rows.length, 0);
	assert.equal(sent.length, 0);
});

test('a wrong code is refused (400) and creates no session; the 5th wrong guess locks the code (429)', async (t) => {
	const { sessions, rows } = setup(t, await hashed());
	const auth = await load();
	await auth.loginUser({ email: 'amr@example.com', password: PW }, {});
	const code = rows[0].code;
	const wrong = code === '000000' ? '111111' : '000000';
	for (let i = 0; i < 4; i++) await assert.rejects(() => auth.verifyLoginOtp({ userId: 'user-1', code: wrong }, {}), (e: any) => e.statusCode === 400 && e.message === 'رمز التحقق غير صحيح');
	await assert.rejects(() => auth.verifyLoginOtp({ userId: 'user-1', code: wrong }, {}), (e: any) => e.statusCode === 429);
	assert.equal(sessions.length, 0);
	assert.equal(rows.length, 0, 'the locked code is deleted: even the right code no longer works');
	await assert.rejects(() => auth.verifyLoginOtp({ userId: 'user-1', code }, {}), (e: any) => e.statusCode === 400);
});

test('the right code creates the session (token + registered session) and is single-use', async (t) => {
	const { sessions, rows } = setup(t, await hashed());
	const auth = await load();
	await auth.loginUser({ email: 'amr@example.com', password: PW }, {});
	const code = rows[0].code;
	const ok: any = await auth.verifyLoginOtp({ userId: 'user-1', code }, {});
	assert.equal(typeof ok.token, 'string');
	assert.equal(ok.user.email, 'amr@example.com');
	assert.deepEqual(sessions, ['user-1']);
	await assert.rejects(() => auth.verifyLoginOtp({ userId: 'user-1', code }, {}), (e: any) => e.statusCode === 400);
});

test('a forgot-password / activation / phone-change code cannot be used to log in', async (t) => {
	const { rows, sessions } = setup(t, await hashed());
	const auth = await load();
	for (const purpose of ['PASSWORD_RESET', 'ACTIVATION', 'PHONE_CHANGE', 'SENSITIVE_CHANGE']) {
		rows.push({ id: `x-${purpose}`, userId: 'user-1', code: '123456', attempts: 0, expiresAt: new Date(Date.now() + 60_000), purpose, createdAt: 99 });
	}
	await assert.rejects(() => auth.verifyLoginOtp({ userId: 'user-1', code: '123456' }, {}), (e: any) => e.statusCode === 400);
	assert.equal(sessions.length, 0);
});

test('resend re-sends the same still-valid login code (no new row) and refuses when no login is in progress', async (t) => {
	const { rows, sent } = setup(t, await hashed());
	const auth = await load();
	await assert.rejects(() => auth.resendLoginOtp('user-1'), (e: any) => e.statusCode === 400);
	await auth.loginUser({ email: 'amr@example.com', password: PW }, {});
	const early = await auth.resendLoginOtp('user-1', undefined);
	assert.equal(early.emailSent, false, 'an immediate resend is throttled like every other code send');
	assert.equal(sent.length, 1);
	auth.__throttle.reset();
	const res = await auth.resendLoginOtp('user-1', undefined);
	assert.equal(res.emailSent, true);
	assert.equal(rows.length, 1);
	assert.equal(sent.length, 2);
	assert.equal(sent[0].code, sent[1].code);
});

test('an expired login code is refused with the Arabic expiry message', async (t) => {
	const { rows } = setup(t, await hashed());
	const auth = await load();
	await auth.loginUser({ email: 'amr@example.com', password: PW }, {});
	rows[0].expiresAt = new Date(Date.now() - 1000);
	await assert.rejects(() => auth.verifyLoginOtp({ userId: 'user-1', code: rows[0].code }, {}), (e: any) => e.statusCode === 400 && /انتهت صلاحيته/.test(e.message));
});
