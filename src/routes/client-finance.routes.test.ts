import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static-source regression guard — same approach used by
// admin-affiliate-requests.routes.test.ts, since this codebase's test suite
// does not boot a real Express app. Confirms the PayPal routes are declared
// AFTER router.use(authenticate)/router.use(requireActiveUser), i.e. they
// inherit the same auth protection as every other client-finance route
// (getClientWallet, getClientInvoices, ...).

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

// PayPal (USD) is the only wallet deposit rail: the Moyasar entry points are gone, not just disabled.
test('there is no /deposit/init or /deposit/verify route and no Moyasar reference left', () => {
	assert.doesNotMatch(source, /deposit\/init|deposit\/verify/);
	assert.doesNotMatch(source, /moyasar/i);
	assert.doesNotMatch(source, /initiateDeposit|verifyDeposit/);
});
