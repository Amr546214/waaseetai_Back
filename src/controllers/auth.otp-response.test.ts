import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// What the app receives: emailSent on register / resend / login-unverified, and no false "sent" claim.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

function mockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.cookie = () => res;
  return res;
}

async function load(t: TestContext, service: Record<string, unknown>) {
  t.mock.module('../services/auth.service', { namedExports: { authService: service } });
  const { authController } = await import(`./auth.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  return authController;
}

test('register: emailSent=true keeps the normal message; emailSent=false says the email did NOT go out (still 201, the account exists)', async (t) => {
  const ok = await load(t, { registerUser: async () => ({ userId: 'u1', emailSent: true }) });
  const res1 = mockRes();
  await ok.register({ body: {}, headers: {} } as any, res1, () => {});
  assert.equal(res1.statusCode, 201);
  assert.equal(res1.body.data.emailSent, true);
  assert.match(res1.body.message, /يرجى تفعيل الحساب/);
});

test('register with a failed email: the message says the code could not be sent', async (t) => {
  const bad = await load(t, { registerUser: async () => ({ userId: 'u1', emailSent: false }) });
  const res = mockRes();
  await bad.register({ body: {}, headers: {} } as any, res, () => {});
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.emailSent, false);
  assert.match(res.body.message, /تعذر إرسال رمز التحقق/);
  assert.doesNotMatch(res.body.message, /تم إرسال/);
});

test('resend: success=true + emailSent=true when the email was sent', async (t) => {
  const sent = await load(t, { resendOtp: async () => ({ emailSent: true, reused: false }) });
  const r1 = mockRes();
  await sent.resendOtp({ body: { userId: 'u1' } } as any, r1, () => {});
  assert.deepEqual([r1.body.success, r1.body.emailSent, r1.body.data.emailSent], [true, true, true]);
});

test('resend: success=false + emailSent=false + an honest message when the email failed (an older app reading only `success` does not claim it was sent)', async (t) => {
  const failed = await load(t, { resendOtp: async () => ({ emailSent: false, reused: true }) });
  const r2 = mockRes();
  await failed.resendOtp({ body: { userId: 'u1' } } as any, r2, () => {});
  assert.deepEqual([r2.body.success, r2.body.emailSent], [false, false]);
  assert.match(r2.body.message, /تعذر إرسال رمز التحقق/);
});

test('login (unverified) passes emailSent and the throttle wait through', async (t) => {
  const c = await load(t, { loginUser: async () => ({ verified: false, phoneOtpRequired: false, userId: 'u1', emailSent: false, retryAfterSeconds: 42, message: 'انتظر' }) });
  const res = mockRes();
  await c.login({ body: {}, ip: '1.1.1.1', get: () => '' } as any, res, () => {});
  assert.equal(res.body.data.verified, false);
  assert.equal(res.body.data.emailSent, false);
  assert.equal(res.body.data.retryAfterSeconds, 42);
});

test('login (unverified) from the plain path without emailSent info keeps the old shape', async (t) => {
  const c = await load(t, { loginUser: async () => ({ verified: false, phoneOtpRequired: true, userId: 'u1', message: 'x' }) });
  const res = mockRes();
  await c.login({ body: {}, ip: '1.1.1.1', get: () => '' } as any, res, () => {});
  assert.equal('emailSent' in res.body.data, false);
});
