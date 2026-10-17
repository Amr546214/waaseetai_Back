import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

// The marketer routers (earnings, withdrawals, wallet, assets, settings, tickets, profile) answer only while the user ACTS as the marketer. Real routers + the real role middleware
// are mounted; only authentication (the test user comes from a header) and the controllers (answer 200 "reached") are replaced, so a 403 is exactly what the middleware decides.
process.env.OPENAI_API_KEY = 'test-key';

const reached = (_req: any, res: any) => res.status(200).json({ success: true, reached: true });
const names = (o: object) => Object.getOwnPropertyNames(o);

async function serve(t: TestContext) {
  const real: any = await import('../middlewares/auth.middleware');
  t.mock.module('../middlewares/auth.middleware', { namedExports: {
    ...real,
    authenticate: (req: any, res: any, next: any) => { const h = req.headers['x-test-user']; if (!h) return res.status(401).json({ success: false, message: 'unauth' }); req.user = JSON.parse(String(h)); next(); },
    requireActiveUser: (_req: any, _res: any, next: any) => next()
  } });
  const realOverview: any = await import('../controllers/marketer-overview.controller');
  t.mock.module('../controllers/marketer-overview.controller', { namedExports: { marketerOverviewController: Object.fromEntries(names(Object.getPrototypeOf(realOverview.marketerOverviewController)).filter(k => k !== 'constructor').map(k => [k, reached])) } });
  const realWithdrawal: any = await import('../controllers/withdrawal.controller');
  t.mock.module('../controllers/withdrawal.controller', { namedExports: { ...realWithdrawal, submitMarketerWithdrawal: reached, listMyMarketerWithdrawals: reached } });
  const realTickets: any = await import('../controllers/support-ticket.controller');
  t.mock.module('../controllers/support-ticket.controller', { namedExports: { ...realTickets, createTicket: reached, listMyTickets: reached, getMyTicket: reached, replyToTicket: reached, closeMyTicket: reached } });
  const realAccount: any = await import('../controllers/marketer-account.controller');
  t.mock.module('../controllers/marketer-account.controller', { namedExports: { ...realAccount, getMarketerWallet: reached, getMyMarketerWithdrawal: reached, getMarketerAssets: reached, getMarketerSettings: reached, updateMarketerSettings: reached, exportMarketerData: reached } });
  const overview = (await import(`./marketer-overview.routes.ts?f=${Date.now()}-${Math.random()}`)).default;
  const app = express(); app.use(express.json()); app.use('/api/marketer-overview', overview);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/marketer-overview`;
  return async (method: string, path: string, user?: object) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': JSON.stringify(user) } : {}) }, body: method === 'GET' ? undefined : '{}' }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
}

const ROUTES: Array<[string, string]> = [
  ['GET', '/summary'], ['GET', '/commissions'], ['GET', '/referrals'], ['GET', '/ref-links'],
  ['POST', '/withdrawals'], ['GET', '/withdrawals'], ['GET', '/withdrawals/w1'], ['GET', '/wallet'],
  ['GET', '/assets'], ['GET', '/settings'], ['PATCH', '/settings'], ['GET', '/settings/data-export'],
  ['POST', '/tickets'], ['GET', '/tickets'], ['GET', '/tickets/t1'], ['POST', '/tickets/t1/reply'], ['POST', '/tickets/t1/close']
];
const marketer = { id: 'm1', accountType: 'MARKETING_BROKER', roles: ['AFFILIATE', 'CLIENT'], activeRole: 'AFFILIATE' };

test('a marketer acting as AFFILIATE reaches every earnings / withdrawal / wallet / assets / settings / tickets route', async t => {
  const call = await serve(t);
  for (const [m, p] of ROUTES) { const r = await call(m, p, marketer); assert.equal(r.status, 200, `${m} ${p}`); assert.equal(r.body.reached, true); }
});

test('the same marketer acting as CLIENT gets 403 with the switch message on every marketer route', async t => {
  const call = await serve(t);
  for (const [m, p] of ROUTES) { const r = await call(m, p, { ...marketer, activeRole: 'CLIENT' }); assert.equal(r.status, 403, `${m} ${p}`); assert.match(r.body.message, /بدّل إلى حساب الوسيط/); }
});

test('a provider (roles also hold AFFILIATE and CLIENT) acting as PROVIDER, and a plain client, get 403 on every marketer route; no token is 401', async t => {
  const call = await serve(t);
  const provider = { id: 'p1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'AFFILIATE', 'CLIENT'], activeRole: 'PROVIDER' };
  const client = { id: 'c1', accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT' };
  for (const [m, p] of ROUTES) {
    assert.equal((await call(m, p, provider)).status, 403, `provider ${m} ${p}`);
    assert.equal((await call(m, p, client)).status, 403, `client ${m} ${p}`);
    assert.equal((await call(m, p)).status, 401, `anon ${m} ${p}`);
  }
});

test('a provider who also holds AFFILIATE and switched to AFFILIATE reaches the marketer routes (the acting role is the judge)', async t => {
  const call = await serve(t);
  const switched = { id: 'p1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'AFFILIATE', 'CLIENT'], activeRole: 'AFFILIATE' };
  assert.equal((await call('GET', '/wallet', switched)).status, 200);
});

test('static: the marketer profile router (PayPal, channels, KYC) is gated by the acting role too, and the public profile stays open', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./marketer-profile.routes.ts', import.meta.url), 'utf8');
  assert.match(src, /router\.use\(authorizeActiveRoleWithMessage\(/);
  assert.ok(src.indexOf("router.get('/public/:id'") < src.indexOf('router.use(authorizeActiveRoleWithMessage'));
});
