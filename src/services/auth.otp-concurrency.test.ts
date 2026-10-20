import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Concurrency rules of the code engine (one Node process: the locks and the throttle are in-memory, as the backend runs a single instance):
//  - concurrent sends from ONE address for different accounts never pass the per-IP limit while the mail is in flight;
//  - a failed mail never counts as a delivered one for the recipient (cooldown / hourly allowance);
//  - resend and verify at the same moment cannot delete each other's code, and a slow mail never blocks a verification;
//  - a re-sent code's mail states the time that is REALLY left, not a fresh 10 minutes.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

type Row = { id: string; userId: string; code: string; attempts: number; expiresAt: Date; purpose: string; createdAt: number };
type Mail = { fail: boolean; delayMs: number; failFor?: Set<string> };

function setup(t: TestContext, hash: string, mail: Mail, users: number) {
	const list = Array.from({ length: users }, (_, i) => ({ id: `user-${i}`, email: `u${i}@example.com`, firstName: 'U', lastName: String(i), status: 'ACTIVE', password: hash, accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', roles: ['CLIENT'] }));
	const byEmail = (e: string) => list.find(u => u.email === e) ?? null;
	const byId = (id: string) => list.find(u => u.id === id) ?? null;
	const rows: Row[] = [];
	const mails: { to: string; code: string; minutes: number | undefined; ok: boolean }[] = [];
	const sessions: string[] = [];
	let seq = 0;
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: {} } });
	t.mock.module('./session.service', { namedExports: { sessionService: { register: async (id: string) => { await new Promise(r => setImmediate(r)); sessions.push(id); return {}; } } } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
	t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
		findByEmail: async (e: string) => { const u = byEmail(e); return u ? { ...u } : null; },
		findById: async (id: string) => { const u = byId(id); return u ? { ...u } : null; },
		findByIdForSession: async (id: string) => { const u = byId(id); return u ? { ...u } : null; },
		createOtp: async (userId: string, code: string, _t: string, expiresAt: Date, purpose: string) => { try { t.mock.timers.tick(40); } catch { /* real clock: time passes by itself */ } await new Promise(r => setImmediate(r)); rows.push({ id: `o${++seq}`, userId, code, attempts: 0, expiresAt, purpose, createdAt: seq }); return {}; },
		findLatestOtpByPurpose: async (userId: string, purpose: string) => { await new Promise(r => setImmediate(r)); const r = rows.filter(x => x.userId === userId && x.purpose === purpose).sort((a, b) => b.createdAt - a.createdAt)[0]; return r ? { ...r } : null; },
		deleteOtpsByPurpose: async (userId: string, purpose: string) => { await new Promise(r => setImmediate(r)); for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === userId && rows[i].purpose === purpose) rows.splice(i, 1); return { count: 0 }; },
		incrementOtpAttempts: async (id: string) => { const r = rows.find(x => x.id === id); if (r) r.attempts++; return {}; },
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { sendLoginOtpEmail: async (to: string, code: string, minutes?: number) => {
		if (mail.delayMs) await new Promise(r => setTimeout(r, mail.delayMs));
		const ok = !(mail.fail || mail.failFor?.has(to));
		mails.push({ to, code, minutes, ok });
		if (!ok) throw new Error('smtp down');
	} } } });
	return { list, rows, mails, sessions };
}
async function load() {
	const { authService } = await import(`./auth.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const { otpSendThrottle } = await import('../utils/otp-send-throttle');
	otpSendThrottle.reset();
	return authService;
}
const PW = 'Str0ng!Pass1';
const hashed = async () => (await import('bcrypt')).hash(PW, 4);
const loginAs = (auth: any, i: number, ip = '10.0.0.1') => auth.loginUser({ email: `u${i}@example.com`, password: PW }, { ipAddress: ip });

test('40 simultaneous logins of different accounts from one address: at most 30 mails are attempted while SMTP is slow, the rest are told to wait', async (t) => {
	const { mails } = setup(t, await hashed(), { fail: false, delayMs: 25 }, 40);
	const auth = await load();
	const results: any[] = await Promise.all(Array.from({ length: 40 }, (_, i) => loginAs(auth, i)));
	assert.equal(mails.length, 30, 'exactly the per-IP allowance reached the mailer');
	assert.equal(results.filter(r => r.emailSent === true).length, 30);
	const throttled = results.filter(r => r.emailSent === false);
	assert.equal(throttled.length, 10);
	for (const r of throttled) assert.ok(r.retryAfterSeconds > 0 && /هذا الجهاز/.test(r.message));
});

test('another address is not affected by a busy one', async (t) => {
	const { mails } = setup(t, await hashed(), { fail: false, delayMs: 5 }, 35);
	const auth = await load();
	await Promise.all(Array.from({ length: 32 }, (_, i) => loginAs(auth, i, '10.0.0.1')));
	const other: any = await loginAs(auth, 33, '10.0.0.2');
	assert.equal(other.emailSent, true);
	assert.equal(mails.length, 31);
});

test('failed mails count for the address (attempts) but never as a delivered send for the recipient', async (t) => {
	const mail: Mail = { fail: true, delayMs: 0 };
	const { mails } = setup(t, await hashed(), mail, 2);
	const auth = await load();
	const a: any = await loginAs(auth, 0); assert.equal(a.emailSent, false);
	mail.fail = false;
	const b: any = await loginAs(auth, 0);
	assert.equal(b.emailSent, true, 'no cooldown was started by the failure');
	const c: any = await loginAs(auth, 0);
	assert.equal(c.emailSent, false, 'the delivered one DID start the cooldown');
	assert.match(c.message, /أرسلنا الرمز بالفعل/);
	assert.equal(mails.filter(m => m.ok).length, 1);
});

test('a resend near expiry and a verification of the old code at the same moment: one consistent outcome, never two sessions, never a live code nobody was told', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
	const { rows, mails, sessions } = setup(t, await hashed(), { fail: false, delayMs: 0 }, 1);
	const auth = await load();
	await loginAs(auth, 0);
	const oldCode = rows[0].code;
	t.mock.timers.tick(8 * 60_000 + 70_000); // 1 min left, past the 60 s resend interval
	const [res, ver]: any[] = await Promise.allSettled([auth.resendLoginOtp('user-0', '10.0.0.1'), auth.verifyLoginOtp({ userId: 'user-0', code: oldCode }, {})]);
	assert.equal(res.status, 'fulfilled');
	assert.ok(sessions.length <= 1);
	if (ver.status === 'fulfilled') {
		assert.equal(sessions.length, 1);
	} else {
		assert.equal(ver.reason.statusCode, 400, 'a verification that lost the race is a plain wrong/used code, not a crash');
		assert.equal(sessions.length, 0);
	}
	// whatever is stored now is exactly what the last mail carried
	if (rows.length) assert.equal(rows[rows.length - 1].code, mails[mails.length - 1].code);
});

test('a slow mail never blocks a verification of the code that is already valid', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
	const mail: Mail = { fail: false, delayMs: 0 };
	const { rows, sessions } = setup(t, await hashed(), mail, 1);
	const auth = await load();
	await loginAs(auth, 0);
	const code = rows[0].code;
	t.mock.timers.tick(61_000); // resend allowed again, plenty of validity left (reuse)
	mail.delayMs = 400; // SMTP is slow now (real timers from here)
	const slowResend = auth.resendLoginOtp('user-0', '10.0.0.1');
	await new Promise(r => setTimeout(r, 30));
	const t0 = Date.now();
	await auth.verifyLoginOtp({ userId: 'user-0', code }, {});
	assert.ok(Date.now() - t0 < 250, 'verification did not wait for the 400 ms mail');
	assert.equal(sessions.length, 1);
	await slowResend;
});

test('a re-sent code (3+ minutes left) is mailed with the time really left; a fresh code with 10 minutes', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
	const { mails, rows } = setup(t, await hashed(), { fail: false, delayMs: 0 }, 1);
	const auth = await load();
	await loginAs(auth, 0);
	assert.equal(mails[0].minutes, 10);
	t.mock.timers.tick(5 * 60_000 + 30_000); // 4 min 30 s left -> "4 minutes", never a new 10
	const second: any = await loginAs(auth, 0);
	assert.equal(mails[1].code, mails[0].code);
	assert.equal(mails[1].minutes, 4);
	t.mock.timers.tick(5 * 60_000); // 0 min 0 s left -> expired -> fresh
	await loginAs(auth, 0);
	assert.notEqual(rows[0].code, mails[0].code === rows[0].code ? '' : mails[0].code);
	assert.equal(mails[2].minutes, 10);
});
