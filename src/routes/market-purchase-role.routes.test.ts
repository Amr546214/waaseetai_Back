import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

// Hotfix: buying from the marketplace is a CLIENT-acting flow. Real routers + the real role middleware are mounted; only authentication (reads the test user from a header) and the controllers
// (answer 200 "reached") are replaced, so a 403 here is exactly what the real middleware decides.
process.env.OPENAI_API_KEY = 'test-key';
const SWITCH = 'بدّل إلى حساب طالب الخدمة لإتمام الشراء';

async function serve(t: TestContext) {
  const real: any = await import('../middlewares/auth.middleware');
  t.mock.module('../middlewares/auth.middleware', { namedExports: {
    ...real,
    authenticate: (req: any, res: any, next: any) => { const h = req.headers['x-test-user']; if (!h) return res.status(401).json({ success: false, message: 'unauth' }); req.user = JSON.parse(String(h)); next(); },
    optionalAuthenticate: (req: any, _res: any, next: any) => { const h = req.headers['x-test-user']; if (h) req.user = JSON.parse(String(h)); next(); },
    requireActiveUser: (_req: any, _res: any, next: any) => next()
  } });
  const reached = (_req: any, res: any) => res.status(200).json({ success: true, reached: true });
  t.mock.module('../controllers/cart-checkout.controller', { namedExports: Object.fromEntries(['addCartItem', 'confirmPayment', 'createOrder', 'deleteCartItem', 'getCart', 'getOrder', 'getPaymentMethods', 'initPayment', 'resendPaymentOtp', 'syncCart', 'updateCartItem', 'validateCoupon'].map(k => [k, reached])) });
  const cart = (await import(`./cart-checkout.routes.ts?f=${Date.now()}-${Math.random()}`)).default;
  const app = express(); app.use(express.json()); app.use('/api', cart);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return async (method: string, path: string, user?: object) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': JSON.stringify(user) } : {}) }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
}

const ROUTES: Array<[string, string]> = [['POST', '/cart/items'], ['PUT', '/cart/items/abc'], ['DELETE', '/cart/items/abc'], ['POST', '/cart/sync'], ['GET', '/cart'], ['POST', '/checkout/coupon/validate'], ['POST', '/checkout/order'], ['GET', '/checkout/payment/methods'], ['POST', '/checkout/payment/init'], ['POST', '/checkout/payment/confirm'], ['POST', '/checkout/payment/resend-otp']];
const providerActing = { id: 'u1', accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'CLIENT'], activeRole: 'PROVIDER' };
const sameUserAsClient = { ...providerActing, activeRole: 'CLIENT' };

test('a multi-role user acting as PROVIDER gets 403 with the switch message on every purchase route', async t => {
  const call = await serve(t);
  for (const [m, p] of ROUTES) { const r = await call(m, p, providerActing); assert.equal(r.status, 403, `${m} ${p}`); assert.equal(r.body.message, SWITCH, `${m} ${p}`); }
});

test('the same user acting as CLIENT passes the role gate on every purchase route', async t => {
  const call = await serve(t);
  for (const [m, p] of ROUTES) { const r = await call(m, p, sameUserAsClient); assert.equal(r.status, 200, `${m} ${p}`); assert.equal(r.body.reached, true); }
});

test('a plain client (individual / company) is allowed, a marketer acting as AFFILIATE is not, no token is 401', async t => {
  const call = await serve(t);
  assert.equal((await call('POST', '/cart/items', { id: 'c1', accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'], activeRole: 'CLIENT' })).status, 200);
  assert.equal((await call('POST', '/checkout/order', { id: 'c2', accountType: 'CLIENT_COMPANY', roles: ['CLIENT'], activeRole: 'CLIENT' })).status, 200);
  assert.equal((await call('POST', '/checkout/payment/init', { id: 'm1', accountType: 'MARKETING_BROKER', roles: ['AFFILIATE', 'CLIENT'], activeRole: 'AFFILIATE' })).status, 403);
  assert.equal((await call('POST', '/cart/items')).status, 401);
});

test('a provider acting as PROVIDER cannot buy anything — his own service or another one — because no purchase route is reachable', async t => {
  const call = await serve(t);
  for (const [m, p] of ROUTES.filter(([m]) => m !== 'GET')) assert.equal((await call(m, p, providerActing)).status, 403);
});

test('static: browsing stays open (marketplace models/details have no role gate) and the "request this service" route uses the acting-role gate with the same message', async () => {
  const { readFileSync } = await import('node:fs');
  const market = readFileSync(new URL('./marketplace.routes.ts', import.meta.url), 'utf8');
  assert.match(market, /router\.get\('\/models', optionalAuthenticate, controller\.getMarketplaceModels/);
  assert.match(market, /router\.get\('\/models\/:id', optionalAuthenticate, controller\.getMarketplaceModelById/);
  assert.match(market, /router\.post\('\/models\/:id\/request', authenticate, requireActiveUser, authorizeActiveRoleWithMessage\('بدّل إلى حساب طالب الخدمة لإتمام الشراء'/);
  const cart = readFileSync(new URL('./cart-checkout.routes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(cart, /authorize\(AccountType/);
  assert.equal((cart.match(/\.\.\.clientAuth/g) || []).length, 12);
});

test('static: the client wallet / invoices / PayPal deposit router is gated by the acting role too (provider earnings are a separate balance)', async () => {
  const { readFileSync } = await import('node:fs');
  const fin = readFileSync(new URL('./client-finance.routes.ts', import.meta.url), 'utf8');
  assert.match(fin, /router\.use\(authorizeActiveRoleWithMessage\('بدّل إلى حساب طالب الخدمة لاستخدام المحفظة والدفع', AccountType\.CLIENT_COMPANY, AccountType\.CLIENT_INDIVIDUAL\)\)/);
});
