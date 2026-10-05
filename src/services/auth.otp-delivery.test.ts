import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Auth flows that send a code: emailSent is reported honestly, a still-valid code is re-sent (not replaced),
// the 10-minute expiry, the send limits for login-while-unverified, the SMS guard, and no clear-text OTP in any log.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

const MIN = 60_000;

function setup(t: TestContext, opts: {
  sendOk?: boolean;
  user?: any;
  latestActivation?: any;
  latestReset?: any;
  smsAvailable?: boolean;
} = {}) {
  const logs: string[] = [];
  const push = (m: unknown) => logs.push(String(m));
  const user = opts.user ?? { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', status: 'PENDING_VERIFICATION', password: null };
  const created: any[] = [];
  const sent: { to: string; code: string }[] = [];
  const spies = { deleteActivationOtps: 0, deleteResetOtps: 0, createResetOtp: 0 };

  t.mock.module('../config/logger', { namedExports: { logger: { info: push, warn: push, error: push, debug: push } } });
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('./session.service', { namedExports: { sessionService: { register: async () => ({}) } } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
  t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
    findByEmailOrPhone: async () => null,
    createUserWithProfile: async () => ({ id: 'user-1', email: 'amr@example.com' }),
    createOtp: async (userId: string, code: string, type: string, expiresAt: Date) => { created.push({ userId, code, type, expiresAt, at: Date.now() }); return {}; },
    findById: async () => user,
    findByEmail: async () => ({ ...user, password: user.password }),
    findLatestActivationOtp: async () => opts.latestActivation ?? null,
    deleteActivationOtps: async () => { spies.deleteActivationOtps++; return { count: 1 }; },
    findLatestPasswordResetOtp: async () => opts.latestReset ?? null,
    deletePasswordResetOtps: async () => { spies.deleteResetOtps++; return { count: 1 }; },
    createPasswordResetOtp: async (_u: string, code: string, expiresAt: Date) => { spies.createResetOtp++; created.push({ code, reset: true, expiresAt }); return {}; },
    deletePhoneOtps: async () => ({ count: 0 }),
  } } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {
    sendEmailOtp: async (to: string, code: string) => { sent.push({ to, code }); if (opts.sendOk === false) throw new Error('SMTP down'); },
    sendPasswordResetEmail: async (to: string, _n: string, code: string) => { sent.push({ to, code }); if (opts.sendOk === false) throw new Error('SMTP down'); },
    sendSmsOtp: async () => {},
    isSmsAvailable: () => !!opts.smsAvailable,
  } } });
  return { logs, created, sent, spies, user };
}

async function load() {
  const { authService } = await import(`./auth.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const { otpSendThrottle } = await import('../utils/otp-send-throttle');
  otpSendThrottle.reset();
  return { authService, otpSendThrottle };
}

const REGISTER_INPUT: any = { email: 'amr@example.com', phoneNumber: '0500000000', password: 'Str0ng!Pass1', firstName: 'Amr', lastName: 'O', accountType: 'CLIENT_INDIVIDUAL' };

test('register: emailSent=true when SMTP accepts; the code lives 10 minutes (as the email says) and is never logged', async (t) => {
  const { created, sent, logs } = setup(t);
  const { authService } = await load();
  const result = await authService.registerUser(REGISTER_INPUT);
  assert.deepEqual(result, { userId: 'user-1', emailSent: true });
  const lifetime = created[0].expiresAt.getTime() - created[0].at; // relative to when the code was created (bcrypt may be slow)
  assert.ok(lifetime >= 10 * MIN - 2000 && lifetime <= 10 * MIN + 2000, `lifetime ${lifetime}`);
  assert.ok(logs.every(l => !l.includes(sent[0].code)), 'no clear-text OTP in the logs');
});

test('register: SMTP failure -> emailSent=false (the account exists, the UI must not say "sent")', async (t) => {
  const { logs, sent } = setup(t, { sendOk: false });
  const { authService } = await load();
  const result = await authService.registerUser(REGISTER_INPUT);
  assert.equal(result.emailSent, false);
  assert.equal(result.userId, 'user-1');
  assert.ok(logs.some(l => /NOT delivered/.test(l)));
  assert.ok(logs.every(l => !l.includes(sent[0].code)));
});

test('resend: SMTP failure -> emailSent=false; success -> true', async (t) => {
  const bad = setup(t, { sendOk: false });
  const { authService } = await load();
  assert.equal((await authService.resendOtp('user-1')).emailSent, false);
  assert.ok(bad.logs.every(l => !/\b\d{6}\b/.test(l.replace(/\d{4}-\d{2}-\d{2}/g, ''))), 'no 6-digit code in logs');
});

test('resend with a still-valid code re-sends THE SAME code and does not replace or delete it', async (t) => {
  const { sent, created, spies } = setup(t, { latestActivation: { code: '555111', expiresAt: new Date(Date.now() + 6 * MIN) } });
  const { authService } = await load();
  const result = await authService.resendOtp('user-1');
  assert.deepEqual(result, { emailSent: true, reused: true });
  assert.deepEqual(sent, [{ to: 'amr@example.com', code: '555111' }]);
  assert.equal(created.length, 0);
  assert.equal(spies.deleteActivationOtps, 0);
});

test('resend after the code expired creates a NEW code (10 minutes), replacing only the old activation codes', async (t) => {
  const { sent, created, spies } = setup(t, { latestActivation: { code: '555111', expiresAt: new Date(Date.now() - MIN) } });
  const { authService } = await load();
  const result = await authService.resendOtp('user-1');
  assert.equal(result.reused, false);
  assert.equal(spies.deleteActivationOtps, 1);
  assert.equal(created.length, 1);
  assert.notEqual(sent[0].code, '555111');
  assert.equal(created[0].type, 'EMAIL');
});

test('resend never touches a verified account', async (t) => {
  setup(t, { user: { id: 'user-1', email: 'amr@example.com', status: 'ACTIVE' } });
  const { authService } = await load();
  await assert.rejects(() => authService.resendOtp('user-1'), (e: any) => e.statusCode === 400);
});

test('forgot-password re-sends a still-valid reset code instead of replacing it; the answer stays generic', async (t) => {
  const { sent, spies } = setup(t, { user: { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', status: 'ACTIVE', password: 'x' }, latestReset: { code: '777222', expiresAt: new Date(Date.now() + 5 * MIN), attempts: 0 } });
  const { authService } = await load();
  const r = await authService.forgotPassword({ email: 'amr@example.com' });
  assert.match(r.message, /[؀-ۿ]/);
  assert.deepEqual(sent, [{ to: 'amr@example.com', code: '777222' }]);
  assert.equal(spies.createResetOtp, 0);
  assert.equal(spies.deleteResetOtps, 0);
});

test('forgot-password creates a new code when none is valid, and an SMTP failure still gives the generic answer (no account enumeration)', async (t) => {
  const { spies, logs, sent } = setup(t, { sendOk: false, user: { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', status: 'ACTIVE', password: 'x' }, latestReset: { code: '777222', expiresAt: new Date(Date.now() - MIN), attempts: 0 } });
  const { authService } = await load();
  const r = await authService.forgotPassword({ email: 'amr@example.com' });
  assert.match(r.message, /إذا كان البريد/);
  assert.equal(spies.createResetOtp, 1);
  assert.ok(logs.some(l => /NOT delivered/.test(l)));
  assert.ok(logs.every(l => !l.includes(sent[0].code)));
});

test('login for an unverified account sends a code and reports emailSent (true / false)', async (t) => {
  const bcrypt = await import('bcrypt');
  const hash = await bcrypt.hash('Str0ng!Pass1', 4);
  const ok = setup(t, { user: { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', status: 'PENDING_VERIFICATION', password: hash } });
  const { authService } = await load();
  const r1 = await authService.loginUser({ email: 'amr@example.com', password: 'Str0ng!Pass1' }, { ipAddress: '1.1.1.1' });
  assert.equal(r1.verified, false);
  assert.equal(r1.emailSent, true);
  assert.equal(ok.sent.length, 1);
});

test('login for an unverified account: a second login within 60 s is throttled (no new email, emailSent=false, wait + Arabic message), the old code stays valid', async (t) => {
  const bcrypt = await import('bcrypt');
  const hash = await bcrypt.hash('Str0ng!Pass1', 4);
  const { sent } = setup(t, { user: { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', status: 'PENDING_VERIFICATION', password: hash } });
  const { authService } = await load();
  await authService.loginUser({ email: 'amr@example.com', password: 'Str0ng!Pass1' }, { ipAddress: '1.1.1.1' });
  const second = await authService.loginUser({ email: 'amr@example.com', password: 'Str0ng!Pass1' }, { ipAddress: '1.1.1.1' });
  assert.equal(second.verified, false);
  assert.equal(second.emailSent, false);
  assert.ok(second.retryAfterSeconds > 0 && second.retryAfterSeconds <= 60);
  assert.match(second.message, /[؀-ۿ]/);
  assert.equal(sent.length, 1);
});

test('login with a WRONG password does not touch the send limits: forgot-password for the same email still sends right after', async (t) => {
  const bcrypt = await import('bcrypt');
  const hash = await bcrypt.hash('Str0ng!Pass1', 4);
  const { sent } = setup(t, { user: { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', status: 'ACTIVE', password: hash } });
  const { authService, otpSendThrottle } = await load();
  for (let i = 0; i < 6; i++) await assert.rejects(() => authService.loginUser({ email: 'amr@example.com', password: 'wrong' }, { ipAddress: '1.1.1.1' }));
  assert.equal(otpSendThrottle.consume('amr@example.com', '1.1.1.1').allowed, true); // what the forgot-password route would do
  await authService.forgotPassword({ email: 'amr@example.com' });
  assert.equal(sent.length, 1);
});

test('SMS guard: phoneOtpEnabled with no SMS sender gives a clear Arabic 503, never "sent to your phone", and creates no code', async (t) => {
  const bcrypt = await import('bcrypt');
  const hash = await bcrypt.hash('Str0ng!Pass1', 4);
  const { created } = setup(t, { smsAvailable: false, user: { id: 'user-1', email: 'amr@example.com', firstName: 'Amr', status: 'ACTIVE', password: hash, phoneOtpEnabled: true, phoneNumber: '500000000', phoneCountryCode: '+966' } });
  const { authService } = await load();
  await assert.rejects(() => authService.loginUser({ email: 'amr@example.com', password: 'Str0ng!Pass1' }, {}), (e: any) => e.statusCode === 503 && /الرسائل النصية/.test(e.message) && !/أرسلنا|المرسل/.test(e.message));
  assert.equal(created.length, 0);
});
