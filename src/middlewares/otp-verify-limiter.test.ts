import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// AUD-FND-000038: the OTP limiter key is built from the validated, NORMALISED identifier plus the client address, so a third party
// cannot lock another user out; successful requests do not use up the failed-attempt budget.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.AUTH_RATE_LIMIT_MAX = '3';
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '3600000';

let mod: typeof import('./rate-limit.middleware');
test.before(async () => { mod = await import('./rate-limit.middleware'); });

const mkReq = (identifier: unknown, ip: string): any => ({ body: { email: identifier }, ip, app: { get: () => false }, headers: {}, get: () => undefined });
async function hit(limiters: any[], req: any, status = 400): Promise<{ blocked: boolean; err?: any }> {
  const res: any = Object.assign(new EventEmitter(), { statusCode: status, headersSent: false, setHeader() {}, getHeader() {}, status() { return this; } });
  for (const limiter of limiters) {
    let outcome: { next?: unknown } | null = null;
    await new Promise<void>((resolve) => { limiter(req, res, (e?: unknown) => { outcome = { next: e }; resolve(); }); });
    if (outcome && (outcome as any).next) return { blocked: true, err: (outcome as any).next };
  }
  res.emit('finish'); // the response completes with `status`
  return { blocked: false };
}

test('the key is normalised: the same account written differently shares one bucket (and the key carries the IP)', () => {
  assert.equal(mod.normalizeOtpIdentifier('  Victim@Example.COM '), 'victim@example.com');
  assert.equal(mod.normalizeOtpIdentifier(42), undefined);
  assert.equal(mod.normalizeOtpIdentifier('   '), undefined);
  assert.equal(mod.otpVerifyKey('1.2.3.4', mod.normalizeOtpIdentifier('A@b.com ')), mod.otpVerifyKey('1.2.3.4', mod.normalizeOtpIdentifier('a@B.com')));
  assert.notEqual(mod.otpVerifyKey('1.2.3.4', 'a@b.com'), mod.otpVerifyKey('9.9.9.9', 'a@b.com'));
});

test('failed attempts are limited per IP + normalised identifier; a different IP using the same email is NOT affected (no third-party lockout)', async () => {
  const limiters = mod.otpVerifyLimiters((req) => req.body?.email);
  const attacker = (e: string) => mkReq(e, '6.6.6.6');
  for (let i = 0; i < 3; i++) assert.equal((await hit(limiters, attacker(i % 2 ? 'VICTIM@x.com' : ' victim@x.com'))).blocked, false);
  const fourth = await hit(limiters, attacker('Victim@X.com'));
  assert.equal(fourth.blocked, true, 'the attacker is blocked after the budget');
  assert.equal(fourth.err.statusCode, 429);
  const victim = await hit(limiters, mkReq('victim@x.com', '7.7.7.7'));
  assert.equal(victim.blocked, false, 'the real user, from another address, is not locked out');
});

test('successful requests do not consume the failed-attempt budget', async () => {
  const limiters = mod.otpVerifyLimiters((req) => req.body?.email);
  for (let i = 0; i < 10; i++) assert.equal((await hit(limiters, mkReq('ok@x.com', '8.8.8.8'), 200)).blocked, false);
  assert.equal((await hit(limiters, mkReq('ok@x.com', '8.8.8.8'), 400)).blocked, false);
});

test('mounted after the schema validation on every OTP route; send routes key by the normalised identifier', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/auth/auth.routes.ts'), 'utf8');
  assert.match(src, /normalizeOtpIdentifier\(req\.body\?\.email\)/);
  assert.match(src, /normalizeOtpIdentifier\(req\.body\?\.userId\)/);
  for (const r of ['/register', '/verify-otp', '/resend-otp', '/forgot-password', '/verify-reset-code', '/reset-password']) {
    const i = src.indexOf(`'${r}'`); const block = src.slice(i, src.indexOf(');', i));
    assert.ok(block.indexOf('validateRequest(') >= 0 && block.indexOf('validateRequest(') < block.search(/otpSendLimiter\(|otpVerifyLimiters\(/), `${r}: validation first`);
  }
});
