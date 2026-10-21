import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// What the app receives: emailSent on register / resend / login-unverified, and no false "sent" claim.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

function mockRes() {
  const res: any = { statusCode: null, body: null, locals: {} };
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

// Registration answers EVERY outcome with one identical public body (a new address, an address already in use, a failed or a successful mail), so the answer never discloses whether an account
// exists: no `emailSent`, no account id, one neutral message. The honest delivery signal is the SEPARATE resend / login answer (emailSent + the wait). (These two tests used to assert the old
// per-outcome `emailSent` body and had been failing since the uniform answer was introduced.)
test('register: the public answer is identical whether the mail went out or not (201, neutral message, no emailSent, no id)', async (t) => {
  const { REGISTER_GENERIC_MESSAGE } = await import('../utils/auth-messages');
  const bodies: any[] = [];
  for (const result of [{ userId: 'u1', accountCreated: true, emailSent: true }, { userId: 'u1', accountCreated: true, emailSent: false }, { userId: null, accountCreated: false }]) {
    const c = await load(t, { registerUser: async () => result });
    const res = mockRes();
    await c.register({ body: {}, headers: {} } as any, res, () => {});
    assert.equal(res.statusCode, 201);
    bodies.push(res.body);
  }
  assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[0], bodies[2]);
  assert.equal(bodies[0].message, REGISTER_GENERIC_MESSAGE);
  assert.ok(!('emailSent' in (bodies[0].data ?? {})) && !('userId' in (bodies[0].data ?? {})));
  assert.doesNotMatch(bodies[0].message, /تم إرسال|تعذر إرسال/);
});

test('register with a failed email: still the neutral answer (the failure is logged, never shown as a different body); the user resends from the code step', async (t) => {
  const bad = await load(t, { registerUser: async () => ({ userId: 'u1', accountCreated: true, emailSent: false }) });
  const res = mockRes();
  await bad.register({ body: {}, headers: {} } as any, res, () => {});
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.doesNotMatch(JSON.stringify(res.body), /emailSent|تعذر إرسال|تم إرسال/);
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
