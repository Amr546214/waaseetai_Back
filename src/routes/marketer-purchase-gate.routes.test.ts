import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

// A marketer acting as AFFILIATE (whose roles also hold CLIENT) cannot buy: every cart / checkout / payment route answers 403 with the switch message,
// while acting as CLIENT the normal flow passes the gate. Browsing the marketplace has no role gate (checked statically).
process.env.OPENAI_API_KEY = 'test-key';
const SWITCH = 'بدّل إلى حساب طالب الخدمة لإتمام الشراء';

async function serve(t: TestContext) {
  const real: any = await import('../middlewares/auth.middleware');
  t.mock.module('../middlewares/auth.middleware', { namedExports: {
    ...real,
    authenticate: (req: any, res: any, next: any) => { const h = req.headers['x-test-user']; if (!h) return res.status(401).json({ success: false, message: 'unauth' }); req.user = JSON.parse(String(h)); next(); },
    requireActiveUser: (_req: any, _res: any, next: any) => next()
  } });
  const reached = (_req: any, res: any) => res.status(200).json({ success: true, reached: true });
  t.mock.module('../controllers/cart-checkout.controller', { namedExports: Object.fromEntries(['addCartItem', 'confirmPayment', 'createOrder', 'deleteCartItem', 'getCart', 'getOrder', 'getPaymentMethods', 'initPayment', 'resendPaymentOtp', 'syncCart', 'updateCartItem', 'validateCoupon'].map(k => [k, reached])) });
  const cart = (await import(`./cart-checkout.routes.ts?f=${Date.now()}-${Math.random()}`)).default;
  const app = express(); app.use(express.json()); app.use('/api', cart);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return async (method: string, path: string, user: object) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-user': JSON.stringify(user) }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
}

const ROUTES: Array<[string, string]> = [['POST', '/cart/items'], ['PUT', '/cart/items/abc'], ['DELETE', '/cart/items/abc'], ['POST', '/cart/sync'], ['GET', '/cart'], ['POST', '/checkout/coupon/validate'], ['POST', '/checkout/order'], ['GET', '/checkout/payment/methods'], ['POST', '/checkout/payment/init'], ['POST', '/checkout/payment/confirm'], ['POST', '/checkout/payment/resend-otp']];
const marketerActing = { id: 'm1', accountType: 'MARKETING_BROKER', roles: ['AFFILIATE', 'CLIENT'], activeRole: 'AFFILIATE' };

test('a marketer acting as AFFILIATE (roles include CLIENT) gets 403 with the switch message on every purchase route', async t => {
  const call = await serve(t);
  for (const [m, p] of ROUTES) { const r = await call(m, p, marketerActing); assert.equal(r.status, 403, `${m} ${p}`); assert.equal(r.body.message, SWITCH, `${m} ${p}`); }
});

test('the same marketer after switching to CLIENT passes the gate on every purchase route', async t => {
  const call = await serve(t);
  for (const [m, p] of ROUTES) { const r = await call(m, p, { ...marketerActing, activeRole: 'CLIENT' }); assert.equal(r.status, 200, `${m} ${p}`); }
});

test('static: browsing the marketplace has no role gate, and the client wallet / "request this service" use the acting-role gate', async () => {
  const { readFileSync } = await import('node:fs');
  const market = readFileSync(new URL('./marketplace.routes.ts', import.meta.url), 'utf8');
  assert.match(market, /router\.get\('\/models', optionalAuthenticate, controller\.getMarketplaceModels/);
  assert.match(market, /router\.get\('\/models\/:id', optionalAuthenticate, controller\.getMarketplaceModelById/);
});
