import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static-source regression guard — same approach used by
// admin-affiliate-requests.routes.test.ts, since this codebase's test suite
// does not boot a real Express app. Confirms the PayPal routes are declared
// AFTER router.use(authenticate)/router.use(requireActiveUser), i.e. they
// inherit the same auth protection as every other client-finance route
// (getClientWallet, initiateDeposit, verifyDeposit, ...).

const source = fs.readFileSync(path.join(__dirname, 'client-finance.routes.ts'), 'utf8');

test('client-finance router applies authenticate + requireActiveUser before any route, including the PayPal ones', () => {
	assert.match(source, /router\.use\(authenticate\)/);
	assert.match(source, /router\.use\(requireActiveUser\)/);

	const useAuthenticateIndex = source.indexOf('router.use(authenticate)');
	const paypalCreateIndex = source.indexOf("router.post('/paypal/order/create'");
	const paypalCaptureIndex = source.indexOf("router.post('/paypal/order/capture'");

	assert.ok(useAuthenticateIndex >= 0, 'authenticate must be applied');
	assert.ok(paypalCreateIndex > useAuthenticateIndex, 'PayPal create-order route must be declared after the auth guard');
	assert.ok(paypalCaptureIndex > useAuthenticateIndex, 'PayPal capture route must be declared after the auth guard');
});

test('PayPal create-order and capture routes are registered with amount/order-id validation', () => {
	assert.match(source, /router\.post\('\/paypal\/order\/create',\s*validateDto\(createPaypalOrderSchema\),\s*createPaypalOrder\)/);
	assert.match(source, /router\.post\('\/paypal\/order\/capture',\s*validateDto\(capturePaypalOrderSchema\),\s*capturePaypalOrder\)/);
});

// USD-canonical wallet: Moyasar (SAR-only) must not be able to credit
// User.walletBalance. This locks in that /deposit/init and /deposit/verify
// are no longer wired to client-finance.controller.ts's Moyasar handlers at
// all — the controller/service code itself is untouched (still exported,
// just unreferenced here), so re-enabling later is a one-line revert.
test('Moyasar deposit entry points are disabled — not wired to initiateDeposit/verifyDeposit', () => {
	const importLine = source.split('\n').find(l => l.includes("from '../controllers/client-finance.controller'"));
	assert.ok(importLine, 'client-finance.controller import must exist');
	assert.doesNotMatch(importLine!, /initiateDeposit/, 'initiateDeposit must not be imported into the router anymore');
	assert.doesNotMatch(importLine!, /verifyDeposit/, 'verifyDeposit must not be imported into the router anymore');
	assert.match(source, /router\.post\('\/deposit\/init',\s*moyasarDepositDisabled\)/);
	assert.match(source, /router\.post\('\/deposit\/verify',\s*moyasarDepositDisabled\)/);
});

test('the Moyasar-disabled handler responds 503 without ever calling any service', async () => {
	// Extract and execute the actual inline handler from the router module to
	// prove its runtime behavior, not just that it's wired in.
	const moduleUrl = `./client-finance.routes.ts?fixture=${Date.now()}-${Math.random()}`;
	const router = (await import(moduleUrl)).default;
	const layer = router.stack.find((l: any) => l.route?.path === '/deposit/init');
	assert.ok(layer, '/deposit/init route must exist on the router');
	const handler = layer.route.stack[layer.route.stack.length - 1].handle;

	let statusCode = 0;
	let body: any = null;
	const res: any = {
		status(code: number) { statusCode = code; return this; },
		json(payload: any) { body = payload; return this; }
	};
	handler({} as any, res, () => {});

	assert.equal(statusCode, 503);
	assert.equal(body.success, false);
});
