import { test } from 'node:test';
import assert from 'node:assert/strict';

// Exercises PaypalService's own configuration guard directly (no network
// mocking needed: assertConfigured() must throw before any fetch happens).

test('PaypalService: createOrder fails safely when PAYPAL_CLIENT_ID/SECRET are missing', async () => {
	delete process.env.PAYPAL_CLIENT_ID;
	delete process.env.PAYPAL_CLIENT_SECRET;

	const moduleUrl = `./paypal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { PaypalService } = await import(moduleUrl);
	const service = new PaypalService();

	await assert.rejects(
		() => service.createOrder({ amount: '50.00', currency: 'USD', referenceId: 'ref-1', customId: 'client-1' }),
		/غير مهيأة/
	);
});

test('PaypalService: verifyWebhookSignature fails safely when PAYPAL_WEBHOOK_ID is missing', async () => {
	process.env.PAYPAL_CLIENT_ID = 'test-client-id';
	process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
	delete process.env.PAYPAL_WEBHOOK_ID;

	const moduleUrl = `./paypal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { PaypalService } = await import(moduleUrl);
	const service = new PaypalService();

	await assert.rejects(
		() =>
			service.verifyWebhookSignature({
				transmissionId: 't1',
				transmissionTime: 'now',
				certUrl: 'https://api.paypal.com/cert',
				authAlgo: 'SHA256withRSA',
				transmissionSig: 'sig',
				webhookEvent: {}
			}),
		/غير مهيأة/
	);

	process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
});

test('PaypalService: selects the sandbox base URL by default / when PAYPAL_ENV=sandbox', async () => {
	process.env.PAYPAL_ENV = 'sandbox';
	const moduleUrl = `./paypal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { PaypalService } = await import(moduleUrl);
	const service = new PaypalService() as any;
	assert.equal(service.getBaseUrl(), 'https://api-m.sandbox.paypal.com');
});
