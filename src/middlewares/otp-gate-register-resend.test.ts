import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Register and resend-by-e-mail answer identically for every address, and both tell when the next send is allowed (resendAvailableAt): the app's resend wait comes from it.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

async function setup(t: TestContext) {
  t.mock.module('../services/auth.service', { namedExports: { authService: { registerUser: async () => ({}), resendOtpByEmail: async () => ({}) } } });
  const { authController } = await import(`../controllers/auth.controller.ts?f=${Date.now()}-${Math.random()}`);
  const { otpSendGate } = await import(`./rate-limit.middleware.ts?f=${Date.now()}-${Math.random()}`);
  return { authController, otpSendGate };
}
function run(gate: any, handler: (req: any, res: any, next: any) => Promise<void>, body: any) {
  const sent: any[] = [];
  const res: any = { locals: {}, statusCode: 0, setHeader() {}, once() {}, status(c: number) { this.statusCode = c; return this; }, json(b: any) { sent.push(b); return this; } };
  const req: any = { body, ip: '3.3.3.3', headers: {} };
  return new Promise<any>((resolve) => gate(req, res, async () => { await handler(req, res, () => {}); resolve({ res, body: sent[0] }); }));
}

test('register and resend-by-e-mail: same keys, status and resendAvailableAt (~60 s) in the body and in data', async (t) => {
  const { authController, otpSendGate } = await setup(t);
  const before = Date.now();
  const gate = otpSendGate((req: any) => req.body.email);
  const reg = await run(gate, (q, s, n) => authController.register(q, s, n), { email: 'a@x.co' });
  const rsd = await run(gate, (q, s, n) => authController.resendOtp(q, s, n), { email: 'b@x.co' });
  for (const r of [reg, rsd]) {
    const at = Date.parse(r.body.resendAvailableAt);
    assert.ok(at >= before + 59_000 && at <= Date.now() + 61_000);
    assert.equal(r.body.data.resendAvailableAt, r.body.resendAvailableAt);
    assert.equal(r.body.data.emailSent, undefined); // nothing about the account
    assert.equal('expiresAt' in r.body, false); // no per-account validity here (same shape for every address)
  }
  assert.equal(reg.res.statusCode, 201);
  assert.deepEqual(Object.keys(reg.body.data).sort(), ['resendAvailableAt']);
});
