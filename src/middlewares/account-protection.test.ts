import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.JWT_SECRET = 'test-secret-account-protection';
process.env.RL_LOGIN_FREE = '3';
process.env.RL_LOGIN_DELAY_BASE_MS = '600000';
process.env.RL_LOGIN_DELAY_MAX_MS = '900000';

let mw: typeof import('./rate-limit.middleware');
let srv: http.Server;
const listen = (app: express.Express) => new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = (p: string) => `http://127.0.0.1:${(srv.address() as AddressInfo).port}${p}`;
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0';

before(async () => {
  mw = await import('./rate-limit.middleware');
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.post('/login', ...mw.loginLimiters((req) => req.body?.email), (req, res) => {
    if (req.body?.password === 'good') res.json({ success: true, data: { userId: `u-${req.body.email}` } });
    else res.status(401).json({ message: 'bad' });
  });
  app.post('/login/verify-otp', ...mw.loginLimiters((req) => req.body?.userId, 'login_step'), (req, res) => {
    if (req.body?.code === '1') res.json({ success: true, data: { token: 't' } }); else res.status(401).json({ message: 'bad' });
  });
  app.post('/login/resend-otp', ...mw.loginLimiters((req) => req.body?.userId, 'login_step'), (_req, res) => { res.json({ ok: true }); });
  app.put('/password', mw.passwordChangeLimiter, (req, res) => { if (req.body?.current === 'ok') res.json({ ok: true }); else res.status(401).json({ message: 'CURRENT_PASSWORD_INCORRECT' }); });
  app.delete('/sessions/:id', mw.accountActionLimiter, (_req, res) => { res.json({ ok: true }); });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode || 500).json({ message: err.message, errors: err.errors });
  });
  srv = await listen(app);
});
after(() => { srv.closeAllConnections(); srv.close(); });

async function call(method: string, path: string, body: Record<string, unknown> | undefined, headers: Record<string, string> = {}) {
  const r = await fetch(url(path), { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) as any };
}
const login = (email: string, password: string, ip: string, ua = CHROME) => call('POST', '/login', { email, password }, { 'x-forwarded-for': ip, 'user-agent': ua });
const step = (userId: string, code: string, ip: string, ua = CHROME, path = '/login/verify-otp') => call('POST', path, { userId, code }, { 'x-forwarded-for': ip, 'user-agent': ua });
/** a full honest login: password step + e-mail code, from one origin */
async function fullLogin(email: string, ip: string, ua = CHROME) {
  const a = await login(email, 'good', ip, ua);
  assert.equal(a.status, 200);
  const b = await step(a.body.data.userId, '1', ip, ua);
  assert.equal(b.status, 200);
}
const tierOf = (r: { body: any }) => r.body.errors?.[0]?.tier;

test('(i) distributed attack: the owner at a recognised origin is never blocked; a NEW origin gets a delay, not a lock; rejected calls do not extend it', async () => {
  const owner = 'owner1@x.com';
  await fullLogin(owner, '10.20.1.5');
  // attacker, many addresses (each a different /24): 3 free guesses, then the account is in a gap for unrecognised origins
  for (let i = 0; i < 3; i++) assert.equal((await login(owner, 'guess', `10.30.${i}.9`)).status, 401);
  const blocked = await login(owner, 'guess', '10.30.50.9');
  assert.equal(blocked.status, 429);
  assert.equal(tierOf(blocked), 'login_account');
  const wait1 = Number(blocked.retryAfter);
  assert.ok(wait1 > 0 && wait1 <= 900, `a bounded wait, not a lock (got ${wait1})`);
  // 30 more hammering requests do not push the wait further out
  let last = blocked;
  for (let i = 0; i < 30; i++) last = await login(owner, 'guess', `10.31.${i}.9`);
  assert.equal(last.status, 429);
  assert.ok(Number(last.retryAfter) <= wait1, 'rejected attempts never extend the delay');
  // the owner at the recognised origin: typo and correct password both go through, same origin /24 and same browser class
  assert.equal((await login(owner, 'typo', '10.20.1.77')).status, 401);
  assert.equal((await login(owner, 'good', '10.20.1.5')).status, 200);
  // the owner from a NEW origin meets the delay (nuisance), with the standard shape
  const fresh = await login(owner, 'good', '10.99.9.9');
  assert.equal(fresh.status, 429);
  assert.equal(fresh.body.errors[0].retryAfterSeconds, Number(fresh.retryAfter));
});

test('(i) total guesses per day stay capped whatever the number of addresses (simulated day, 1 attempt per second)', async () => {
  const { AccountDelayGuard } = await import('../utils/account-delay-guard');
  let t = 1_000_000;
  const g = new AccountDelayGuard({ free: 10, baseMs: 30_000, ceilingMs: 900_000, now: () => t });
  let admitted = 0; let longest = 0;
  for (let s = 0; s < 24 * 3600; s++, t += 1000) {
    const r = g.admit('victim');
    if (r.allowed) admitted++; else longest = Math.max(longest, r.retryAfterMs);
  }
  assert.ok(admitted <= 125, `admitted ${admitted}`);
  assert.ok(admitted >= 100, 'it is a delay, not a block: attempts keep being admitted');
  assert.ok(longest <= 900_000, 'the wait never exceeds the ceiling');
});

test('(i) a delayed account recovers on its own: after the gap the next attempt is admitted; a success is handed back', async () => {
  const { AccountDelayGuard } = await import('../utils/account-delay-guard');
  let t = 0;
  const g = new AccountDelayGuard({ free: 2, baseMs: 30_000, ceilingMs: 120_000, stepEvery: 1, now: () => t });
  assert.ok(g.admit('a').allowed); assert.ok(g.admit('a').allowed);
  assert.equal(g.admit('a').allowed, false);
  t += 29_000; assert.equal(g.admit('a').allowed, false);
  t += 1_000; assert.ok(g.admit('a').allowed);   // gap 30 s elapsed -> admitted; next gap 60 s
  t += 59_000; assert.equal(g.admit('a').allowed, false);
  t += 1_000; assert.ok(g.admit('a').allowed);   // gap 120 s next (ceiling)
  g.refund('a');                                   // that one was a success
  assert.ok(g.admit('a').allowed, 'after a refund the account is not penalised for the success');
  // state older than the window is forgotten
  t += 25 * 3600_000; assert.ok(g.admit('a').allowed);
});

test('(ii) recognition needs the SECOND step, from the same origin; one account never whitelists another; password-only success recognises nothing', async () => {
  const a = 'acct-a@x.com'; const b = 'acct-b@x.com';
  await fullLogin(a, '10.40.1.1');
  const originOk = mw.recognisedOrigins;
  const { originKey } = await import('../utils/recognised-origins');
  assert.ok(originOk.has(a, originKey('10.40.1.1', CHROME)));
  assert.equal(originOk.has(b, originKey('10.40.1.1', CHROME)), false, 'account B is not recognised at A\'s origin');
  // B's attacker at A's origin is still gated after the free attempts
  for (let i = 0; i < 3; i++) assert.equal((await login(b, 'guess', '10.40.1.1')).status, 401);
  assert.equal((await login(b, 'guess', '10.40.1.2')).status, 429);
  // password step only (no code): not recognised
  const c = 'acct-c@x.com';
  assert.equal((await login(c, 'good', '10.41.1.1')).status, 200);
  assert.equal(originOk.has(c, originKey('10.41.1.1', CHROME)), false);
  // resend-otp success does not recognise either
  const r = await step(`u-${c}`, '1', '10.41.1.1', CHROME, '/login/resend-otp');
  assert.equal(r.status, 200);
  assert.equal(originOk.has(c, originKey('10.41.1.1', CHROME)), false);
  // code verified from a DIFFERENT origin than the password step: not recognised
  const d = 'acct-d@x.com';
  assert.equal((await login(d, 'good', '10.42.1.1')).status, 200);
  assert.equal((await step(`u-${d}`, '1', '10.43.1.1')).status, 200);
  assert.equal(originOk.has(d, originKey('10.43.1.1', CHROME)), false);
  assert.equal(originOk.has(d, originKey('10.42.1.1', CHROME)), false);
});

test('(ii) recognised-origin memory is bounded (accounts, origins per account, pending links) and expires', async () => {
  const { RecognisedOrigins } = await import('../utils/recognised-origins');
  let t = 0;
  const r = new RecognisedOrigins({ ttlMs: 1000, maxAccounts: 3, perAccount: 2, maxPending: 2, now: () => t });
  for (let i = 0; i < 10; i++) r.remember(`acct${i}`, 'o');
  assert.equal(r.size, 3);
  for (const o of ['o1', 'o2', 'o3']) r.remember('multi', o);
  assert.equal(r.has('multi', 'o1'), false); assert.ok(r.has('multi', 'o3'));
  for (let i = 0; i < 6; i++) r.noteChallenge(`u${i}`, 'x', 'o');
  assert.equal(r.pendingSize, 2);
  assert.equal(r.confirm('u0', 'o'), false, 'evicted link');
  assert.equal(r.confirm('u5', 'o'), true);
  t += 1001;
  assert.equal(r.has('x', 'o'), false, 'expired');
});

test('(iii) same address, different accounts: each has its own account budget (no cross blocking)', async () => {
  for (let i = 0; i < 6; i++) assert.equal((await login(`office${i}@x.com`, 'bad', '10.50.1.1')).status, 401);
  for (let i = 0; i < 6; i++) assert.equal((await login(`office${i}@x.com`, 'good', '10.50.1.1')).status, 200);
});

test('(iv) spoofed headers: a forged leading X-Forwarded-For / X-User-Id / other user-agent do not borrow the owner\'s recognised origin', async () => {
  const owner = 'owner4@x.com';
  await fullLogin(owner, '10.60.1.1');
  for (let i = 0; i < 3; i++) assert.equal((await login(owner, 'guess', `10.61.${i}.1`)).status, 401);
  const forged = await call('POST', '/login', { email: owner, password: 'good' }, { 'x-forwarded-for': '10.60.1.1, 10.62.2.2', 'x-real-ip': '10.60.1.1', 'x-user-id': 'owner', 'user-agent': CHROME });
  assert.equal(forged.status, 429, 'the address is the one the trusted proxy appended, not the forged leading entry');
  const otherUa = await login(owner, 'good', '10.60.1.1', 'curl/8.4.0');
  assert.equal(otherUa.status, 429, 'same network but another client class is not recognised');
  const sameBrowserNewVersion = await login(owner, 'good', '10.60.1.200', CHROME.replace('120.0', '121.0'));
  assert.equal(sameBrowserNewVersion.status, 200, 'same /24 and browser class (version bump) stays recognised');
});

test('(v) unknown and existing identifiers get the identical delay response', async () => {
  const shape = (r: any) => ({ status: r.status, tier: tierOf(r), code: r.body.errors?.[0]?.code, msg: String(r.body.message).replace(/[\d٠-٩]+/g, '#'), hasRetry: Number(r.retryAfter) > 0 });
  await fullLogin('exists5@x.com', '10.70.1.1'); // real, with a recognised origin; the attacker is elsewhere
  const run = async (email: string, base: string) => { let r: any; for (let i = 0; i < 4; i++) r = await login(email, 'guess', `${base}.${i}.1`); return shape(r); };
  const a = await run('exists5@x.com', '10.71'); const b = await run('never-existed5@x.com', '10.72');
  assert.deepEqual(a, b);
  assert.equal(a.status, 429);
});

const bearer = (userId: string) => ({ authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}` });

test('(vi) password change: strict per ACCOUNT (5 wrong / h), two users behind one address do not block each other, anonymous stays 10 / h per address', async () => {
  const ip = { 'x-forwarded-for': '10.80.1.1' };
  const A = { ...bearer('user-a'), ...ip }; const B = { ...bearer('user-b'), ...ip };
  for (let i = 0; i < 5; i++) assert.equal((await call('PUT', '/password', { current: 'wrong' }, A)).status, 401);
  const blocked = await call('PUT', '/password', { current: 'wrong' }, A);
  assert.equal(blocked.status, 429);
  assert.equal(tierOf(blocked), 'password_change_failed');
  assert.ok(Number(blocked.retryAfter) > 0);
  assert.equal((await call('PUT', '/password', { current: 'wrong' }, B)).status, 401, 'user B behind the same address is unaffected');
  assert.equal((await call('PUT', '/password', { current: 'ok' }, B)).status, 200);
  // token on another address: the budget follows the account, not the address
  assert.equal((await call('PUT', '/password', { current: 'wrong' }, { ...bearer('user-a'), 'x-forwarded-for': '10.80.9.9' })).status, 429);
  // anonymous: per address
  for (let i = 0; i < 10; i++) assert.equal((await call('PUT', '/password', { current: 'wrong' }, { 'x-forwarded-for': '10.81.1.1' })).status, 401);
  assert.equal((await call('PUT', '/password', { current: 'wrong' }, { 'x-forwarded-for': '10.81.1.1' })).status, 429);
  // forged token = anonymous, cannot fill (or dodge) a victim's account bucket
  assert.equal((await call('PUT', '/password', { current: 'wrong' }, { authorization: 'Bearer forged', 'x-forwarded-for': '10.82.1.1' })).status, 401);
});

test('(vi) password change: successes are limited per account too (10 requests / h)', async () => {
  const H = { ...bearer('user-c'), 'x-forwarded-for': '10.83.1.1' };
  for (let i = 0; i < 10; i++) assert.equal((await call('PUT', '/password', { current: 'ok' }, H)).status, 200);
  const r = await call('PUT', '/password', { current: 'ok' }, H);
  assert.equal(r.status, 429); assert.equal(tierOf(r), 'password_change');
});

test('(vi) sessions / own-account actions: generous per account (60 / h), users behind one address independent, anonymous 10 / h', async () => {
  const ip = { 'x-forwarded-for': '10.84.1.1' };
  const A = { ...bearer('user-d'), ...ip }; const B = { ...bearer('user-e'), ...ip };
  for (let i = 0; i < 60; i++) assert.equal((await call('DELETE', `/sessions/${i}`, undefined, A)).status, 200);
  assert.equal((await call('DELETE', '/sessions/x', undefined, A)).status, 429);
  assert.equal((await call('DELETE', '/sessions/x', undefined, B)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await call('DELETE', '/sessions/x', undefined, { 'x-forwarded-for': '10.85.1.1' })).status, 200);
  assert.equal((await call('DELETE', '/sessions/x', undefined, { 'x-forwarded-for': '10.85.1.1' })).status, 429);
});

test('(vii) OTP verify, payment and withdrawal numbers are exactly as before', () => {
  assert.equal(mw.PREAUTH.OTPV_ID_IP, 10);
  assert.equal(mw.PREAUTH.OTPV_IP, 50);
  assert.equal(mw.PREAUTH.OTPV_ID, 30);
  assert.deepEqual({ ...mw.TIERS.PAYMENT }, { windowMs: 15 * 60_000, user: 20, ip: 10, ipNet: 100 });
  assert.deepEqual({ ...mw.TIERS.WITHDRAWAL }, { windowMs: 60 * 60_000, user: 10, ip: 5, ipNet: 50 });
  assert.equal(mw.PREAUTH.STEP_ID_IP, 10); assert.equal(mw.PREAUTH.STEP_ID, 30); assert.equal(mw.PREAUTH.STEP_IP, 60);
});

test('route wiring: no route is left on the 10 / h per-address authLimiter; password routes use passwordChangeLimiter, sessions use accountActionLimiter', async () => {
  const { readFileSync } = await import('node:fs');
  const src = (f: string) => readFileSync(new URL(`../routes/${f}`, import.meta.url), 'utf8');
  for (const f of ['admin-account.routes.ts', 'provider-profile.routes.ts', 'profile/profile.routes.ts']) assert.doesNotMatch(src(f), /\bauthLimiter\b/, f);
  assert.match(src('provider-profile.routes.ts'), /'\/password', passwordChangeLimiter/);
  assert.match(src('profile/profile.routes.ts'), /password-change-request', passwordChangeLimiter/);
  assert.match(src('provider-profile.routes.ts'), /'\/sessions\/:id', accountActionLimiter/);
  assert.match(src('admin-account.routes.ts'), /sessions', accountActionLimiter/);
});
