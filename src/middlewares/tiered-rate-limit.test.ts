import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

// Small budgets so a handful of requests prove the behaviour; read by the module at import time.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.JWT_SECRET = 'tier-test-secret';
process.env.RL_BROWSE_USER = '5';
process.env.RL_BROWSE_IP = '3';
process.env.RL_BROWSE_IP_NET = '9';
process.env.RL_WRITE_USER = '6';
process.env.RL_WRITE_IP = '6';
process.env.RL_AI_USER = '2';
process.env.RL_AI_IP = '2';
process.env.RL_PAYMENT_USER = '2';
process.env.RL_WITHDRAWAL_USER = '1';
process.env.RL_UPLOAD_USER = '2';
process.env.AUTH_RATE_LIMIT_MAX = '3';

let mw: typeof import('./rate-limit.middleware');
let identity: typeof import('../utils/rate-limit-identity');
let proxied: http.Server; let direct: http.Server;
const listen = (app: express.Express) => new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = (s: http.Server, p: string) => `http://127.0.0.1:${(s.address() as AddressInfo).port}${p}`;

function buildApp(trustProxy: string | boolean) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(mw.apiLimiter);
  const ok: express.RequestHandler = (_req, res) => { res.json({ ok: true }); };
  app.get('/health', ok);
  app.get('/api/things', ok);
  app.post('/api/things', ok);
  app.get('/ai', mw.aiLimiter, ok);
  app.post('/pay', mw.paymentLimiter, ok);
  app.post('/withdraw', mw.withdrawalLimiter, ok);
  app.post('/login', mw.authLimiter, ok);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode || 500).json({ message: err.message, errors: err.errors });
  });
  return app;
}
before(async () => {
  mw = await import('./rate-limit.middleware');
  identity = await import('../utils/rate-limit-identity');
  proxied = await listen(buildApp('loopback'));   // behind a trusted proxy on 127.0.0.1: X-Forwarded-For is honoured
  direct = await listen(buildApp(false));         // reached directly: X-Forwarded-For must be ignored
});
after(() => { proxied.closeAllConnections(); proxied.close(); direct.closeAllConnections(); direct.close(); });

const token = (userId: string, extra: Record<string, unknown> = {}, secret = 'tier-test-secret', opts: jwt.SignOptions = { expiresIn: '1h' }) => jwt.sign({ userId, ...extra }, secret, opts);
async function call(s: http.Server, method: string, path: string, headers: Record<string, string> = {}) {
  const r = await fetch(url(s, path), { method, headers });
  return { status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) as any };
}
const as = (userId: string, ip: string, extra: Record<string, unknown> = {}) => ({ authorization: `Bearer ${token(userId, extra)}`, 'x-forwarded-for': ip });

test('key generation: verified token -> user id (role / renewal do not change it); forged, expired and header-only identities -> client address', () => {
  const req = (headers: Record<string, string>, ip = '203.0.113.5'): any => ({ headers, ip });
  const k = identity.identityKey;
  assert.equal(k(req({ authorization: `Bearer ${token('user-1', { activeRole: 'CLIENT' })}` })), 'u:user-1');
  assert.equal(k(req({ authorization: `Bearer ${token('user-1', { activeRole: 'PROVIDER', jti: 'renewed-1' })}` })), 'u:user-1', 'a renewed token / another active role keeps the bucket');
  assert.equal(k(req({ cookie: `waseet_token=${token('user-2')}` })), 'u:user-2');
  assert.equal(k(req({ authorization: `Bearer ${token('victim', {}, 'wrong-secret')}` })), 'ip:203.0.113.5', 'forged signature is anonymous');
  assert.equal(k(req({ authorization: `Bearer ${token('victim', {}, 'tier-test-secret', { expiresIn: -10 })}` })), 'ip:203.0.113.5', 'expired is anonymous');
  assert.equal(k(req({ authorization: 'Bearer not-a-jwt' })), 'ip:203.0.113.5');
  assert.equal(k(req({ 'x-user-id': 'victim', 'x-forwarded-for': '1.1.1.1' })), 'ip:203.0.113.5', 'identity headers are never read');
});

test('IPv6: addresses of one /56 share a key, another /56 does not; an IPv4-mapped address is the IPv4 key', () => {
  const k = (ip: string) => identity.clientIpKey({ ip, headers: {} } as any);
  assert.equal(k('2001:db8:aaaa:bb00::1'), k('2001:db8:aaaa:bbff:1:2:3:4'));
  assert.notEqual(k('2001:db8:aaaa:bb00::1'), k('2001:db8:aaaa:bc00::1'));
  assert.equal(k('::ffff:203.0.113.9'), k('203.0.113.9'));
});

test('two accounts behind ONE address do not block each other (per-account bucket), and exhausting one account is a 429 with Retry-After + machine code + Arabic text', async () => {
  const ip = '198.51.100.10';
  for (let i = 0; i < 5; i++) assert.equal((await call(proxied, 'GET', '/api/things', as('alice', ip))).status, 200);
  const blocked = await call(proxied, 'GET', '/api/things', as('alice', ip));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retryAfter) >= 1, 'Retry-After header present');
  assert.equal(blocked.body.errors[0].code, 'RATE_LIMITED');
  assert.equal(blocked.body.errors[0].tier, 'browse');
  assert.ok(blocked.body.errors[0].retryAfterSeconds >= 1);
  assert.match(blocked.body.message, /طلبات كثيرة/);
  assert.equal((await call(proxied, 'GET', '/api/things', as('bob', ip))).status, 200, 'bob, same address, is not blocked');
});

test('role switch / token renewal does not reset the bucket', async () => {
  const ip = '198.51.100.11';
  for (let i = 0; i < 5; i++) await call(proxied, 'GET', '/api/things', as('carol', ip, { activeRole: i % 2 ? 'CLIENT' : 'PROVIDER', jti: `r-${i}` }));
  assert.equal((await call(proxied, 'GET', '/api/things', as('carol', ip, { activeRole: 'AFFILIATE' }))).status, 429);
});

test('anonymous traffic is bucketed by the trusted client address; a spoofed X-Forwarded-For cannot dodge it when the app is reached directly', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call(proxied, 'GET', '/api/things', { 'x-forwarded-for': '192.0.2.1' })).status, 200);
  assert.equal((await call(proxied, 'GET', '/api/things', { 'x-forwarded-for': '192.0.2.1' })).status, 429);
  assert.equal((await call(proxied, 'GET', '/api/things', { 'x-forwarded-for': '192.0.2.2' })).status, 200, 'another real client behind the proxy has its own bucket');
  // a client-supplied leading entry is ignored: the proxy appends the real address on the right
  assert.equal((await call(proxied, 'GET', '/api/things', { 'x-forwarded-for': '9.9.9.9, 192.0.2.1' })).status, 429);
  // direct access: every forged header lands in the same (socket address) bucket
  for (let i = 0; i < 3; i++) assert.equal((await call(direct, 'GET', '/api/things', { 'x-forwarded-for': `10.1.1.${i}` })).status, 200);
  assert.equal((await call(direct, 'GET', '/api/things', { 'x-forwarded-for': '10.1.1.99' })).status, 429);
});

test('a forged token / X-User-Id header never gives a fresh bucket nor charges the victim', async () => {
  const ip = '192.0.2.50';
  const forged = { authorization: `Bearer ${token('dave', {}, 'attacker-secret')}`, 'x-forwarded-for': ip };
  for (let i = 0; i < 3; i++) assert.equal((await call(proxied, 'GET', '/api/things', forged)).status, 200);
  assert.equal((await call(proxied, 'GET', '/api/things', forged)).status, 429, 'counted as anonymous on its own address');
  assert.equal((await call(proxied, 'GET', '/api/things', as('dave', '192.0.2.51'))).status, 200, 'the real dave is untouched');
});

test('address safety net: many accounts from one address are bounded together', async () => {
  const ip = '192.0.2.60';
  let blockedAt = -1;
  for (let i = 0; i < 12; i++) { const r = await call(proxied, 'GET', '/api/things', as(`net-${i}`, ip)); if (r.status === 429 && blockedAt < 0) blockedAt = i; }
  assert.equal(blockedAt, 9, 'the 10th request of the address (net = 9) is refused');
});

test('browse and write have separate budgets; health probes are never counted', async () => {
  const ip = '192.0.2.70';
  for (let i = 0; i < 6; i++) assert.equal((await call(proxied, 'POST', '/api/things', as('erin', ip))).status, 200);
  assert.equal((await call(proxied, 'POST', '/api/things', as('erin', ip))).status, 429);
  assert.equal((await call(proxied, 'GET', '/api/things', as('erin', ip))).status, 200, 'reads still fine after writes are exhausted');
  for (let i = 0; i < 20; i++) assert.equal((await call(proxied, 'GET', '/health', { 'x-forwarded-for': '192.0.2.71' })).status, 200);
});

test('strict tiers are independent: AI, payment, withdrawal block at their own small caps without touching browsing', async () => {
  const ip = '192.0.2.80';
  const h = as('frank', ip);
  for (let i = 0; i < 2; i++) assert.equal((await call(proxied, 'GET', '/ai', h)).status, 200);
  const ai = await call(proxied, 'GET', '/ai', h);
  assert.equal(ai.status, 429); assert.equal(ai.body.errors[0].tier, 'ai'); assert.ok(ai.retryAfter);
  for (let i = 0; i < 2; i++) assert.equal((await call(proxied, 'POST', '/pay', as('frank', ip))).status, 200);
  assert.equal((await call(proxied, 'POST', '/pay', as('frank', ip))).status, 429);
  assert.equal((await call(proxied, 'POST', '/withdraw', as('frank', ip))).status, 200);
  const w = await call(proxied, 'POST', '/withdraw', as('frank', ip));
  assert.equal(w.status, 429); assert.equal(w.body.errors[0].tier, 'withdrawal');
  assert.equal((await call(proxied, 'GET', '/api/things', as('frank', ip))).status, 200, 'browsing unaffected');
  assert.equal((await call(proxied, 'GET', '/ai', as('grace', ip))).status, 200, 'another account on the same address keeps its own AI budget');
});

test('login/OTP-style tier stays strict per address (10/hour default, 3 here) and ignores spoofed headers when direct', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call(direct, 'POST', '/login', { 'x-forwarded-for': `7.7.7.${i}` })).status, 200);
  const b = await call(direct, 'POST', '/login', { 'x-forwarded-for': '7.7.7.200' });
  assert.equal(b.status, 429); assert.ok(b.retryAfter); assert.equal(b.body.errors[0].tier, 'auth');
});

test('every multer upload goes through the upload tier (memoryUpload wraps single/array/fields/any/none)', async () => {
  const { memoryUpload } = await import('../utils/cloudinary-storage');
  const up = memoryUpload({ files: 1 });
  const app = express(); app.set('trust proxy', 'loopback');
  app.post('/up', up.single('file'), (_req, res) => { res.json({ ok: true }); });
  app.use((err: any, _req: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(err.statusCode || 500).json({ errors: err.errors }); });
  const s = await listen(app);
  try {
    const h = as('uploader', '192.0.2.90');
    assert.equal((await call(s, 'POST', '/up', h)).status, 200);
    assert.equal((await call(s, 'POST', '/up', h)).status, 200);
    const r = await call(s, 'POST', '/up', h);
    assert.equal(r.status, 429); assert.equal(r.body.errors[0].tier, 'upload');
  } finally { s.closeAllConnections(); s.close(); }
});
