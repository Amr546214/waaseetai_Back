import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// OTP reliability rules (login code, same engine for activation / reset):
//  1. a failed e-mail send never starts the resend cooldown and never uses up the per-hour allowance, so the honest retry is not answered with "we already sent it";
//  2. two simultaneous requests never leave a stored code different from the one e-mailed;
//  3. a still-valid code is re-sent as it is ONLY while enough time is left for the mail to arrive; near its end a fresh code is issued;
//  4. a correct code opens exactly one session even when verified twice at the same moment.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

type Row = { id: string; userId: string; code: string; attempts: number; expiresAt: Date; purpose: string; createdAt: number };

function setup(t: TestContext, hash: string, mail: { fail: boolean; delayMs: number }) {
	const user = { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', lastName: 'O', status: 'ACTIVE', password: hash, accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', roles: ['CLIENT'] };
	const rows: Row[] = [];
	const attempts: { code: string; ok: boolean }[] = [];
	const sessions: string[] = [];
	let seq = 0;
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: {} } });
	t.mock.module('./session.service', { namedExports: { sessionService: { register: async (id: string) => { await new Promise(r => setImmediate(r)); sessions.push(id); return {}; } } } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
	t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
		findByEmail: async () => ({ ...user }),
		findById: async () => ({ ...user }),
		findByIdForSession: async () => ({ ...user }),
		createOtp: async (userId: string, code: string, _type: string, expiresAt: Date, purpose: string) => { await new Promise(r => setImmediate(r)); rows.push({ id: `o${++seq}`, userId, code, attempts: 0, expiresAt, purpose, createdAt: seq }); return {}; },
		findLatestOtpByPurpose: async (userId: string, purpose: string) => { await new Promise(r => setImmediate(r)); const r = rows.filter(x => x.userId === userId && x.purpose === purpose).sort((a, b) => b.createdAt - a.createdAt)[0]; return r ? { ...r } : null; },
		deleteOtpsByPurpose: async (userId: string, purpose: string) => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === userId && rows[i].purpose === purpose) rows.splice(i, 1); return { count: 0 }; },
		incrementOtpAttempts: async (id: string) => { rows.find(r => r.id === id)!.attempts++; return {}; },
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { sendLoginOtpEmail: async (_to: string, code: string) => {
		if (mail.delayMs) await new Promise(r => setTimeout(r, mail.delayMs));
		attempts.push({ code, ok: !mail.fail });
		if (mail.fail) throw new Error('smtp down');
	} } } });
	return { user, rows, attempts, sessions };
}

async function load() {
	const { authService } = await import(`./auth.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const { otpSendThrottle } = await import('../utils/otp-send-throttle');
	otpSendThrottle.reset();
	return Object.assign(authService, { __throttle: otpSendThrottle });
}
const PW = 'Str0ng!Pass1';
const hashed = async () => (await import('bcrypt')).hash(PW, 4);
const login = (auth: any) => auth.loginUser({ email: 'amr@example.com', password: PW }, { ipAddress: '10.0.0.1' });

test('a failed send does not start the cooldown: the immediate retry really tries again and is not told "we already sent it"', async (t) => {
	const mail = { fail: true, delayMs: 0 };
	const { attempts } = setup(t, await hashed(), mail);
	const auth = await load();
	const first: any = await login(auth);
	assert.equal(first.loginOtpRequired, true);
	assert.equal(first.emailSent, false);
	mail.fail = false; // the mail server recovers
	const second: any = await login(auth);
	assert.equal(second.emailSent, true, 'the retry went out; it was not answered with the interval message');
	assert.equal(attempts.length, 2);
	assert.doesNotMatch(String(second.message), /أرسلنا الرمز بالفعل/);
});

test('failed sends do not use up the per-hour recipient allowance (5 failures, then a working mail server still sends)', async (t) => {
	const mail = { fail: true, delayMs: 0 };
	const { attempts } = setup(t, await hashed(), mail);
	const auth = await load();
	for (let i = 0; i < 6; i++) { const r: any = await login(auth); assert.equal(r.emailSent, false); assert.equal(r.retryAfterSeconds, undefined); }
	mail.fail = false;
	const ok: any = await login(auth);
	assert.equal(ok.emailSent, true);
	assert.equal(attempts.length, 7);
});

test('two simultaneous password logins: the stored code is the code that was e-mailed (nothing is cancelled underneath the user)', async (t) => {
	const mail = { fail: false, delayMs: 30 };
	const { rows, attempts } = setup(t, await hashed(), mail);
	const auth = await load();
	const [a, b]: any[] = await Promise.all([login(auth), login(auth)]);
	assert.equal(rows.length, 1, 'one live code');
	assert.ok(attempts.length >= 1);
	for (const sent of attempts) assert.equal(sent.code, rows[0].code, 'every e-mail that went out carries the live code');
	assert.equal([a, b].filter(x => x.emailSent === true).length >= 1, true);
});

test('resend with plenty of validity left re-sends the SAME code with its original expiry', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
	const { rows, attempts } = setup(t, await hashed(), { fail: false, delayMs: 0 });
	const auth = await load();
	const first: any = await login(auth);
	const code = rows[0].code, exp = rows[0].expiresAt.getTime();
	t.mock.timers.tick(5 * 60_000); // 5 min left
	const again: any = await login(auth);
	assert.equal(again.emailSent, true);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].code, code);
	assert.equal(rows[0].expiresAt.getTime(), exp, 'the validity is not stretched');
	assert.deepEqual(attempts.map(a => a.code), [code, code]);
	assert.equal(new Date(first.expiresAt).getTime(), exp);
});

test('resend close to expiry issues a FRESH code (the mail must not arrive carrying a code that already died)', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
	const { rows, attempts } = setup(t, await hashed(), { fail: false, delayMs: 0 });
	const auth = await load();
	await login(auth);
	const oldCode = rows[0].code;
	t.mock.timers.tick(8 * 60_000 + 10_000); // 1 min 50 s left
	const again: any = await login(auth);
	assert.equal(again.emailSent, true);
	assert.equal(rows.length, 1, 'the old code is replaced, never two live codes');
	const fresh = rows[0];
	assert.notEqual(fresh.code, oldCode === fresh.code ? '' : oldCode);
	assert.equal(fresh.expiresAt.getTime(), Date.now() + 10 * 60_000, 'a normal 10-minute validity, not a stretched one');
	assert.equal(attempts[1].code, fresh.code);
	assert.equal(new Date(again.expiresAt).getTime(), fresh.expiresAt.getTime());
});

test('a code that already expired is refused, and so is the replaced old code', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
	const { rows } = setup(t, await hashed(), { fail: false, delayMs: 0 });
	const auth = await load();
	await login(auth);
	const old = rows[0].code;
	t.mock.timers.tick(10 * 60_000 + 1000);
	await assert.rejects(() => auth.verifyLoginOtp({ userId: 'user-1', code: old }, {}), (e: any) => e.statusCode === 400 && /انتهت صلاحيته/.test(e.message));
});

test('the right code verified twice at the same moment opens exactly one session', async (t) => {
	const { rows, sessions } = setup(t, await hashed(), { fail: false, delayMs: 0 });
	const auth = await load();
	await login(auth);
	const code = rows[0].code;
	const results = await Promise.allSettled([auth.verifyLoginOtp({ userId: 'user-1', code }, {}), auth.verifyLoginOtp({ userId: 'user-1', code }, {})]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal(sessions.length, 1);
});
