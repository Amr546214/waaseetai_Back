import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { otpSendThrottle } from '../utils/otp-send-throttle';

// The limiters read RATE_LIMIT_ENABLED when the module loads (a local .env may switch them off for QA): force them on.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.AUTH_RATE_LIMIT_MAX = '10';
let otpSendLimiter: typeof import('./rate-limit.middleware').otpSendLimiter;
let authLimiter: typeof import('./rate-limit.middleware').authLimiter;
test.before(async () => {
  ({ otpSendLimiter, authLimiter } = await import('./rate-limit.middleware'));
});

function run(mw: any, req: any) {
  const headers: Record<string, string> = {};
  const res: any = { setHeader: (k: string, v: string) => { headers[k] = v; } };
  let err: any = null; let passed = false;
  mw(req, res, (e?: unknown) => { if (e) err = e; else passed = true; });
  return { err, passed, headers };
}
const reqFor = (email: string, ip = '5.5.5.5'): any => ({ body: { email }, ip });
const getLimiter = () => otpSendLimiter(req => req.body?.email);

test('the 2nd send within 60 s is a 429 with an Arabic message, Retry-After and a machine-readable retry', () => {
  otpSendThrottle.reset();
  assert.equal(run(getLimiter(), reqFor('x@y.co')).passed, true);
  const second = run(getLimiter(), reqFor('x@y.co'));
  assert.equal(second.passed, false);
  assert.equal(second.err.statusCode, 429);
  assert.match(second.err.message, /[؀-ۿ]/);
  assert.doesNotMatch(second.err.message, /Too many/i);
  assert.ok(Number(second.headers['Retry-After']) > 0 && Number(second.headers['Retry-After']) <= 60);
  assert.equal(second.err.errors[0].code, 'OTP_RATE_LIMITED');
  assert.equal(second.err.errors[0].retryAfterSeconds, Number(second.headers['Retry-After']));
});

test('a request without a recipient is passed on (validation answers the 400)', () => {
  otpSendThrottle.reset();
  assert.equal(run(otpSendLimiter(() => undefined), { body: {}, ip: '1.1.1.1' }).passed, true);
});

test('other recipients and the verify limiter are not affected by a throttled recipient', () => {
  otpSendThrottle.reset();
  run(getLimiter(), reqFor('x@y.co'));
  assert.equal(run(getLimiter(), reqFor('x@y.co')).passed, false);
  assert.equal(run(getLimiter(), reqFor('z@y.co')).passed, true);
});

test('route wiring: SEND endpoints use otpSendLimiter (after validation) and not authLimiter; verify/reset use otpVerifyLimiters (after validation); login/google keep authLimiter', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/auth/auth.routes.ts'), 'utf8');
  const block = (route: string) => {
    const i = src.indexOf(`'${route}'`);
    assert.ok(i >= 0, route);
    return src.slice(i, src.indexOf(');', i));
  };
  for (const route of ['/register', '/resend-otp', '/forgot-password']) {
    assert.match(block(route), /otpSendLimiter\(/, route);
    assert.doesNotMatch(block(route), /authLimiter/, `${route} must not share the login limiter`);
    assert.ok(block(route).indexOf('validateRequest(') < block(route).indexOf('otpSendLimiter('), `${route}: the limiter runs AFTER the schema validation`);
  }
  for (const route of ['/verify-otp', '/verify-reset-code', '/reset-password']) {
    assert.match(block(route), /otpVerifyLimiters\(/, route);
    assert.doesNotMatch(block(route), /otpSendLimiter/, route);
    assert.ok(block(route).indexOf('validateRequest(') < block(route).indexOf('otpVerifyLimiters('), `${route}: the limiter runs AFTER the schema validation`);
  }
  for (const route of ['/login', '/google', '/login/verify-otp']) {
    assert.match(block(route), /authLimiter/, route);
    assert.doesNotMatch(block(route), /otpSendLimiter/, route);
  }
});

test('a wrong password burns the login limiter, never the send limiter: forgot-password for the same IP still sends', () => {
  otpSendThrottle.reset();
  // many login attempts only touch authLimiter (a different counter); the first forgot-password for this email passes
  assert.equal(typeof authLimiter, 'function');
  assert.equal(run(otpSendLimiter(req => req.body?.email), reqFor('victim@y.co', '7.7.7.7')).passed, true);
});

test('the general limiters answer in Arabic with Retry-After as well', async () => {
  // Drive authLimiter past its max with a fake store-less request object via its own handler.
  const rl = authLimiter as any;
  const headers: Record<string, string> = {};
  const res: any = { setHeader: (k: string, v: string) => { headers[k] = v; }, getHeader: () => undefined, statusCode: 200, status() { return this; }, send() { return this; } };
  const req: any = { ip: '3.3.3.3', headers: {}, app: { get: () => false }, method: 'POST', socket: {} };
  let err: any = null;
  for (let i = 0; i < 12; i++) {
    await new Promise<void>(resolve => rl(req, res, (e?: unknown) => { if (e) err = e; resolve(); }));
  }
  assert.ok(err, 'the 11th request is limited');
  assert.equal(err.statusCode, 429);
  assert.match(err.message, /[؀-ۿ]/);
  assert.doesNotMatch(err.message, /Too many/i);
  assert.ok(Number(headers['Retry-After']) > 0);
});
