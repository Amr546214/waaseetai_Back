import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

// Small budgets so a few requests prove each rule; read at import time.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.AUTH_RATE_LIMIT_MAX = '3';          // OTP verify: 3 per address+account, 15 per address, 9 per account
process.env.RL_LOGIN_ID_IP = '3';
process.env.RL_LOGIN_ID = '5';
process.env.RL_LOGIN_IP = '8';
process.env.RL_LOGIN_IP_ALL = '14';
process.env.RL_LOGIN_STEP_IP = '8';

let mw: typeof import('./rate-limit.middleware');
let proxied: http.Server; let direct: http.Server;
const listen = (app: express.Express) => new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = (s: http.Server, p: string) => `http://127.0.0.1:${(s.address() as AddressInfo).port}${p}`;

function buildApp(trustProxy: string | boolean) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  // the "controller": identical answer for known and unknown accounts (password 'good' = success, anything else = 401)
  const handler: express.RequestHandler = (req, res) => { if (req.body?.password === 'good') res.json({ ok: true }); else res.status(401).json({ message: 'bad' }); };
  app.post('/login', ...mw.loginLimiters((req) => req.body?.email), handler);
  app.post('/google', ...mw.loginLimiters(() => undefined, 'google'), handler);
  app.post('/verify', ...mw.otpVerifyLimiters((req) => req.body?.email), handler);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode || 500).json({ message: err.message, errors: err.errors });
  });
  return app;
}
before(async () => {
  mw = await import('./rate-limit.middleware');
  proxied = await listen(buildApp('loopback'));
  direct = await listen(buildApp(false));
});
after(() => { proxied.closeAllConnections(); proxied.close(); direct.closeAllConnections(); direct.close(); });

async function post(s: http.Server, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await fetch(url(s, path), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) as any };
}
const bad = (email: string, ip: string, path = '/login', s = proxied) => post(s, path, { email, password: 'wrong' }, { 'x-forwarded-for': ip });
const tierOf = (r: { body: any }) => r.body.errors?.[0]?.tier;

test('same address, different accounts: users behind one network do not block each other (up to the per-address ceiling), then spraying is stopped', async () => {
  // 8 failures from ONE address over 8 DIFFERENT accounts: all answered (old limit would have stopped at 10 requests of ANY kind, here the ceiling is 8 failures)
  for (let i = 0; i < 8; i++) assert.equal((await bad(`office${i}@x.com`, '10.1.1.1')).status, 401);
  const sprayed = await bad('office-new@x.com', '10.1.1.1');
  assert.equal(sprayed.status, 429);
  assert.equal(tierOf(sprayed), 'login_ip');
  assert.equal(sprayed.body.errors[0].code, 'RATE_LIMITED');
  assert.ok(Number(sprayed.retryAfter) > 0);
  // another address is unaffected
  assert.equal((await bad('office0@x.com', '10.1.1.2')).status, 401);
});

test('same address, same account: tight per-account+address limit, other accounts from that address still answered', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await bad('victim1@x.com', '10.2.2.2')).status, 401);
  const r = await bad('Victim1@X.com ', '10.2.2.2'); // different spelling = same bucket
  assert.equal(r.status, 429);
  assert.equal(tierOf(r), 'login_account_ip');
  assert.equal((await bad('colleague@x.com', '10.2.2.2')).status, 401);
});

test('one account hammered from MANY addresses is blocked (distributed guessing) with the same 429 shape', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await bad('victim2@x.com', `10.3.3.${i + 1}`)).status, 401);
  const r = await bad('victim2@x.com', '10.3.3.99');
  assert.equal(r.status, 429);
  assert.equal(tierOf(r), 'login_account');
  assert.equal(r.body.errors[0].code, 'RATE_LIMITED');
  assert.ok(Number(r.retryAfter) > 0);
  assert.equal(r.body.errors[0].retryAfterSeconds, Number(r.retryAfter));
});

test('known and unknown identifiers get identical 429 (same status, tier, code, message shape)', async () => {
  const shape = (r: any) => ({ status: r.status, tier: tierOf(r), code: r.body.errors?.[0]?.code, message: r.body.message?.replace(/\d+|[٠-٩]+/g, '#') });
  const run = async (email: string, ipBase: string) => { let last: any; for (let i = 0; i < 6; i++) last = await bad(email, `${ipBase}.${i}`); return shape(last); };
  const known = await run('exists@x.com', '10.4.4'); // 'exists' is just a string here: the limiter never looks accounts up
  const unknown = await run('nobody-ever@x.com', '10.5.5');
  assert.deepEqual(known, unknown);
  assert.equal(known.status, 429);
});

test('successful logins do not use the failure budgets (an office of honest users), but the per-address flood guard still counts them', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post(proxied, '/login', { email: `ok${i}@x.com`, password: 'good' }, { 'x-forwarded-for': '10.6.6.6' })).status, 200);
  // 10 successes so far; 4 more reach the flood ceiling (14), the 15th request is refused whatever its outcome
  for (let i = 0; i < 4; i++) assert.equal((await post(proxied, '/login', { email: 'ok@x.com', password: 'good' }, { 'x-forwarded-for': '10.6.6.6' })).status, 200);
  const flood = await post(proxied, '/login', { email: 'ok@x.com', password: 'good' }, { 'x-forwarded-for': '10.6.6.6' });
  assert.equal(flood.status, 429);
  assert.equal(tierOf(flood), 'login_ip_flood');
});

test('spoofing: a rotating X-Forwarded-For on a direct connection and X-User-Id never dodge the per-address limit; the account bucket ignores both', async () => {
  // direct server: trust proxy off, every request is the same socket address 127.0.0.1
  for (let i = 0; i < 8; i++) assert.equal((await bad(`spray${i}@x.com`, `9.9.9.${i}`, '/login', direct)).status, 401);
  const r = await post(direct, '/login', { email: 'spray-x@x.com', password: 'wrong' }, { 'x-forwarded-for': '77.77.77.77', 'x-user-id': 'someone-else', 'x-real-ip': '88.88.88.88' });
  assert.equal(r.status, 429);
  assert.equal(tierOf(r), 'login_ip');
  // proxied server: a forged LEADING entry is ignored (only the entry added by the trusted proxy is used)
  const a = await post(proxied, '/login', { email: 'spoof@x.com', password: 'wrong' }, { 'x-forwarded-for': '1.1.1.1, 10.7.7.7' });
  assert.equal(a.status, 401);
});

test('google sign-in: address-only buckets (no identifier is read)', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await post(proxied, '/google', { idToken: `t${i}` }, { 'x-forwarded-for': '10.8.8.8' })).status, 401);
  const r = await post(proxied, '/google', { idToken: 'tx' }, { 'x-forwarded-for': '10.8.8.8' });
  assert.equal(r.status, 429);
  assert.equal(tierOf(r), 'google_ip');
});

test('OTP verify stays strict: 3 per address+account, then blocked; distributed guessing against one account stops at 9 failures', async () => {
  const v = (email: string, ip: string) => post(proxied, '/verify', { email, code: '000000' }, { 'x-forwarded-for': ip });
  for (let i = 0; i < 3; i++) assert.equal((await v('otp1@x.com', '10.9.9.9')).status, 401);
  const r = await v('otp1@x.com', '10.9.9.9');
  assert.equal(r.status, 429);
  assert.equal(tierOf(r), 'otp_verify_account_ip');
  assert.equal((await v('otp1@x.com', '10.9.9.10')).status, 401, 'another address is not locked out by the first (no third-party lockout)');
  for (let i = 0; i < 9; i++) await v('otp2@x.com', `10.10.10.${i}`);
  const dist = await v('otp2@x.com', '10.10.10.200');
  assert.equal(dist.status, 429);
  assert.equal(tierOf(dist), 'otp_verify_account');
});

// ---- store unit tests ----
test('bounded store: key count never exceeds the cap; expired keys go first', async () => {
  const { BoundedRateLimitStore } = await import('../utils/bounded-rate-limit-store');
  let t = 1_000_000;
  const st = new BoundedRateLimitStore({ limit: 5, maxKeys: 100, now: () => t });
  st.init({ windowMs: 1000 });
  for (let i = 0; i < 1000; i++) { await st.increment(`k${i}`); assert.ok(st.size <= 100); }
  assert.equal(st.size, 100);
  t += 2000; // everything expired
  await st.increment('fresh');
  assert.ok(st.size <= 100);
  st.shutdown();
});

test('bounded store: flooding fresh keys cannot evict an active lockout; progressive lockout doubles the wait; strikes expire', async () => {
  const { BoundedRateLimitStore } = await import('../utils/bounded-rate-limit-store');
  let t = 5_000_000;
  const st = new BoundedRateLimitStore({ limit: 2, maxKeys: 50, maxMultiplier: 8, strikeMemoryMs: 10_000, now: () => t });
  st.init({ windowMs: 1000 });
  for (let i = 0; i < 3; i++) await st.increment('locked');
  assert.equal((await st.increment('locked')).totalHits, 4);
  for (let i = 0; i < 500; i++) await st.increment(`noise${i}`);
  assert.ok((await st.get('locked'))!.totalHits >= 3, 'lockout survived the flood');
  assert.ok(st.size <= 50);
  // strike 1: lock lasts the rest of the window (1 s); after it, strike 2 locks for 2 windows
  t += 1001;
  assert.equal((await st.increment('locked')).totalHits, 1);
  await st.increment('locked');
  const second = await st.increment('locked');
  assert.ok(second.totalHits > 2);
  assert.equal(second.resetTime.getTime() - t, 2000, 'strike 2 = 2 windows');
  // strike memory expires: back to a normal single window
  t += 20_000;
  await st.increment('locked'); await st.increment('locked');
  const again = await st.increment('locked');
  assert.equal(again.resetTime.getTime() - t, 1000);
  // a success hands the hit back but never unlocks
  await st.decrement('locked');
  assert.ok((await st.get('locked'))!.totalHits >= 3);
  st.shutdown();
});

test('OTP send throttle maps are capped', async () => {
  const { OtpSendThrottle, OTP_SEND_MAX_KEYS } = await import('../utils/otp-send-throttle');
  const th = new OtpSendThrottle({ minIntervalMs: 1, perRecipientPerHour: 5, perIpPerHour: 1_000_000 });
  for (let i = 0; i < OTP_SEND_MAX_KEYS + 300; i++) th.consume(`u${i}@x.com`, `ip${i}`);
  assert.ok((th as any).recipients.size <= OTP_SEND_MAX_KEYS + 200);
  assert.ok((th as any).ips.size <= OTP_SEND_MAX_KEYS + 200);
});
