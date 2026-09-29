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

// ============================================================================
// Payout P2-B — createPayout() transport + outcome classification.
//
// No real network: fetch is always mocked. The mock distinguishes the OAuth
// token call (/v1/oauth2/token, reused unchanged from the deposit flow) from
// the payout call (/v1/payments/payouts) by URL, so each test can control
// the payout response independently of a normal, successful OAuth exchange.
// ============================================================================

const VALID_PAYOUT_PARAMS = Object.freeze({
	senderBatchId: 'wd-abc-a1',
	senderItemId: 'attempt-1',
	recipientEmail: 'provider@paypal-sandbox.example',
	amount: 42.5
});

function mockOAuthAndPayout(t: TestContext, payoutHandler: (url: string, init: any) => Promise<Response> | Response) {
	const calls: { url: string; init: any }[] = [];
	const fetchSpy = t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
		calls.push({ url: String(url), init });
		if (String(url).includes('/v1/oauth2/token')) {
			return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		return payoutHandler(String(url), init);
	});
	return { fetchSpy, calls };
}

async function loadPaypalService() {
	process.env.PAYPAL_CLIENT_ID = 'test-client-id';
	process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
	process.env.PAYPAL_ENV = 'sandbox';
	const moduleUrl = `./paypal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { PaypalService } = await import(moduleUrl);
	return new PaypalService();
}

function jsonResponse(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('createPayout: 1-3. posts to the exact Payouts URL, with POST, and an Authorization bearer header that never exposes anything but the token', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () =>
		jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'PENDING' } })
	);
	const service = await loadPaypalService();

	await service.createPayout(VALID_PAYOUT_PARAMS);

	const payoutCall = calls.find(c => c.url.includes('/v1/payments/payouts'));
	assert.ok(payoutCall, 'expected a call to the payouts endpoint');
	assert.equal(payoutCall!.url, 'https://api-m.sandbox.paypal.com/v1/payments/payouts');
	assert.equal(payoutCall!.init.method, 'POST');
	assert.equal(payoutCall!.init.headers.Authorization, 'Bearer test-access-token');
});

test('createPayout: 4-8. request body reuses the exact senderBatchId/senderItemId, maps the recipient, normalizes amount to two decimals, and always sends USD', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () =>
		jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'PENDING' } })
	);
	const service = await loadPaypalService();

	await service.createPayout({ senderBatchId: 'wd-xyz-a2', senderItemId: 'attempt-77', recipientEmail: 'p@example.com', amount: 10 });

	const payoutCall = calls.find(c => c.url.includes('/v1/payments/payouts'));
	const body = JSON.parse(payoutCall!.init.body);
	assert.equal(body.sender_batch_header.sender_batch_id, 'wd-xyz-a2');
	assert.equal(body.items[0].sender_item_id, 'attempt-77');
	assert.equal(body.items[0].receiver, 'p@example.com');
	assert.equal(body.items[0].amount.value, '10.00');
	assert.equal(body.items[0].amount.currency, 'USD');
});

test('createPayout: 9. caller cannot override currency — CreatePayoutParams has no currency field, and the request always sends USD regardless', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () =>
		jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'PENDING' } })
	);
	const service = await loadPaypalService();

	// Even if an extra `currency` field somehow reached the input object
	// (e.g. a caller bypassing TypeScript with `as any`), the request body
	// construction never reads it — the currency is a hardcoded literal.
	await service.createPayout({ ...VALID_PAYOUT_PARAMS, currency: 'EUR' } as any);

	const payoutCall = calls.find(c => c.url.includes('/v1/payments/payouts'));
	const body = JSON.parse(payoutCall!.init.body);
	assert.equal(body.items[0].amount.currency, 'USD');
});

test('createPayout: 10. an invalid recipient email is rejected before any HTTP call', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse({}));
	const service = await loadPaypalService();

	await assert.rejects(() => service.createPayout({ ...VALID_PAYOUT_PARAMS, recipientEmail: 'not-an-email' }));
	assert.equal(calls.length, 0, 'no HTTP call of any kind — not even the OAuth token call — should happen for invalid input');
});

test('createPayout: 11. a zero or negative amount is rejected before any HTTP call', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse({}));
	const service = await loadPaypalService();

	await assert.rejects(() => service.createPayout({ ...VALID_PAYOUT_PARAMS, amount: 0 }));
	await assert.rejects(() => service.createPayout({ ...VALID_PAYOUT_PARAMS, amount: -5 }));
	assert.equal(calls.length, 0);
});

test('createPayout: an amount with more than two decimal places is rejected before any HTTP call', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse({}));
	const service = await loadPaypalService();

	await assert.rejects(() => service.createPayout({ ...VALID_PAYOUT_PARAMS, amount: 10.999 }));
	assert.equal(calls.length, 0);
});

test('createPayout: 12-13. a valid accepted response (PENDING) is classified ACCEPTED with payoutBatchId/batchStatus extracted correctly', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-REAL-123', batch_status: 'PENDING' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);

	assert.equal(result.outcome, 'ACCEPTED');
	if (result.outcome === 'ACCEPTED') {
		assert.equal(result.payoutBatchId, 'PB-REAL-123');
		assert.equal(result.batchStatus, 'PENDING');
	}
});

// ============================================================================
// Payout P2-B fix — strict create-response batch-status classification.
// Only PENDING/PROCESSING (PayPal's create-time "accepted for asynchronous
// processing" statuses) are ACCEPTED. DENIED, SUCCESS, and anything
// unrecognized/missing/empty are UNKNOWN — P2-B never declares a terminal
// outcome; that is P3's job.
// ============================================================================

test('createPayout: batch_status PROCESSING is classified ACCEPTED', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'PROCESSING' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'ACCEPTED');
});

test('createPayout: batch_status DENIED is classified UNKNOWN, never ACCEPTED and never DEFINITELY_REJECTED', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'DENIED' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: batch_status SUCCESS is classified UNKNOWN for P2-B — terminal interpretation is P3\'s responsibility', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'SUCCESS' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: an unrecognized batch_status is classified UNKNOWN, never guessed into ACCEPTED', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'SOME_FUTURE_STATUS' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: an empty-string batch_status is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: '' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: a missing batch_status field is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: a missing payout_batch_id (valid batch_status otherwise) is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { batch_status: 'PENDING' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: batch_status normalization tolerates whitespace/casing without accepting an arbitrary string', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: '  pending  ' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'ACCEPTED');
});

test('createPayout: 14-15. a request exceeding the 15s timeout is aborted and classified UNKNOWN, never DEFINITELY_REJECTED', async (t) => {
	let payoutFetchCalled = false;
	mockOAuthAndPayout(t, (_url, init) => {
		payoutFetchCalled = true;
		return new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => {
				const err: any = new Error('The operation was aborted');
				err.name = 'AbortError';
				reject(err);
			});
		});
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const service = await loadPaypalService();

	const promise = service.createPayout(VALID_PAYOUT_PARAMS);

	// Let the mocked (timer-free) OAuth exchange resolve and the code reach
	// its setTimeout() call before advancing mocked time.
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));

	let settled = false;
	promise.then(() => { settled = true; });

	t.mock.timers.tick(14999);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(settled, false, 'must not abort before the full 15000ms elapses');

	t.mock.timers.tick(1);
	const result = await promise;

	assert.equal(payoutFetchCalled, true);
	assert.equal(result.outcome, 'UNKNOWN');
	assert.notEqual((result as any).outcome, 'DEFINITELY_REJECTED');
});

// ============================================================================
// Payout P2-B fix — bounded, isolated OAuth acquisition for createPayout()
// (getAccessTokenForPayout()). getAccessToken() itself (used by deposits) is
// never touched — a separate test group below re-confirms that directly.
// ============================================================================

test('createPayout: a hung OAuth token request is genuinely aborted at exactly 15000ms and classifies UNKNOWN, and no payout POST is ever attempted', async (t) => {
	let oauthFetchCalled = false;
	let payoutFetchCalled = false;
	let oauthSignalAborted = false;

	t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
		if (String(url).includes('/v1/oauth2/token')) {
			oauthFetchCalled = true;
			return new Promise((_resolve, reject) => {
				init.signal.addEventListener('abort', () => {
					oauthSignalAborted = true;
					const err: any = new Error('The operation was aborted');
					err.name = 'AbortError';
					reject(err);
				});
			});
		}
		payoutFetchCalled = true;
		return jsonResponse({ batch_header: { payout_batch_id: 'PB-SHOULD-NOT-BE-REACHED', batch_status: 'PENDING' } });
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const service = await loadPaypalService();

	const promise = service.createPayout(VALID_PAYOUT_PARAMS);

	// Let the code actually reach its setTimeout() call before advancing
	// mocked time.
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));

	let settled = false;
	promise.then(() => { settled = true; });

	t.mock.timers.tick(14999);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(settled, false, 'must not abort the OAuth acquisition before the full 15000ms elapses');

	t.mock.timers.tick(1);
	const result = await promise;

	assert.equal(oauthFetchCalled, true);
	// Proves genuine cancellation of the underlying request — the mock's
	// fetch implementation only settles in response to the SAME
	// AbortController.signal createPayout() passed to it, not a
	// Promise.race timing out independently of the real request.
	assert.equal(oauthSignalAborted, true, 'the actual OAuth fetch signal must have received the abort, not merely a race timing out alongside it');
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(payoutFetchCalled, false, 'no payout POST may ever be attempted once OAuth acquisition itself has failed/timed out');
});

test('createPayout: normal (non-hung) OAuth acquisition still works end-to-end and reaches ACCEPTED', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'PENDING' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);

	const oauthCall = calls.find(c => c.url.includes('/v1/oauth2/token'));
	assert.ok(oauthCall, 'the OAuth call must still happen normally');
	assert.equal(result.outcome, 'ACCEPTED');
});

test('getAccessToken() (the shared deposit/order path) remains completely unbounded — no AbortSignal attached, unchanged by the payout OAuth fix', async (t) => {
	let observedInit: any = null;
	t.mock.method(globalThis, 'fetch', async (_url: string, init: any) => {
		observedInit = init;
		return jsonResponse({ access_token: 'tok', expires_in: 3600 });
	});
	const service = await loadPaypalService();

	await (service as any).getAccessToken();

	assert.equal(observedInit.signal, undefined, 'getAccessToken() must be byte-for-byte unchanged from before the payout fix — no AbortController/signal ever attached to the deposit/order OAuth call');
});

test('createPayout: 16. a network/transport error (fetch rejects) is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); });
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: 17. HTTP 500 is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ name: 'INTERNAL_SERVER_ERROR' }, 500));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: 18. HTTP 503 is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({}, 503));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: 19. a malformed successful (2xx) response missing the payout batch id is classified UNKNOWN, never ACCEPTED', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { batch_status: 'PENDING' } })); // no payout_batch_id
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: 20. a non-JSON successful (2xx) response is classified UNKNOWN, never ACCEPTED', async (t) => {
	mockOAuthAndPayout(t, async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

// Post-financial-safety-review fix: a single top-level PayPal error `name`
// is not authoritative enough evidence that "no payout was created" (see
// paypal.service.ts's own comment on ACCEPTED_PAYOUT_BATCH_STATUSES/the 4xx
// branch) — a false DEFINITELY_REJECTED could reopen a Withdrawal and enable
// a real duplicate payout, whereas a false UNKNOWN only stalls safely. Every
// 4xx is UNKNOWN now; the following tests pin that down for several
// distinct 4xx shapes, including the one that used to be special-cased.

test('createPayout: a 400 with name VALIDATION_ERROR is classified UNKNOWN, NOT DEFINITELY_REJECTED (post-review fix)', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ name: 'VALIDATION_ERROR', message: 'Invalid request - see details.' }, 400));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: an arbitrary structured 4xx (recognized JSON shape, unrelated error name) is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ name: 'PERMISSION_DENIED', message: 'Not authorized for this action.' }, 403));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: an unparseable (non-JSON) 4xx body is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => new Response('<html>Bad Request</html>', { status: 400, headers: { 'content-type': 'text/html' } }));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: no HTTP 4xx status code, of any shape, ever produces DEFINITELY_REJECTED', async (t) => {
	const fourXxCases: Array<[number, any]> = [
		[400, { name: 'VALIDATION_ERROR', message: 'x' }],
		[401, { name: 'AUTHENTICATION_FAILURE' }],
		[403, { name: 'PERMISSION_DENIED' }],
		[404, { name: 'RESOURCE_NOT_FOUND' }],
		[409, { name: 'DUPLICATE_BATCH_IDENTIFIER' }],
		[422, {}],
		[429, undefined]
	];

	for (const [status, body] of fourXxCases) {
		mockOAuthAndPayout(t, async () => (body === undefined ? new Response('', { status }) : jsonResponse(body, status)));
		const service = await loadPaypalService();
		const result = await service.createPayout(VALID_PAYOUT_PARAMS);
		assert.notEqual(result.outcome, 'DEFINITELY_REJECTED', `status ${status} must not be DEFINITELY_REJECTED`);
		assert.equal(result.outcome, 'UNKNOWN', `status ${status} must be UNKNOWN`);
	}
});

test('createPayout: 22. an ambiguous/unrecognized 4xx is classified UNKNOWN, not DEFINITELY_REJECTED', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ name: 'SOME_UNDOCUMENTED_ERROR_NAME' }, 422));
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('createPayout: 23. safeResponse never contains the recipient/receiver email', async (t) => {
	mockOAuthAndPayout(t, async () =>
		jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'PENDING' }, items: [{ receiver: VALID_PAYOUT_PARAMS.recipientEmail }] })
	);
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'ACCEPTED');
	const serialized = JSON.stringify((result as any).safeResponse);
	assert.equal(serialized.includes(VALID_PAYOUT_PARAMS.recipientEmail), false, 'safeResponse must never echo the recipient email');
	assert.equal(serialized.includes('test-access-token'), false, 'safeResponse must never echo the access token');
});

test('createPayout: 24. exactly one HTTP payout call is made — no automatic retry on UNKNOWN', async (t) => {
	let payoutCallCount = 0;
	mockOAuthAndPayout(t, async () => { payoutCallCount++; return jsonResponse({}, 500); });
	const service = await loadPaypalService();

	const result = await service.createPayout(VALID_PAYOUT_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(payoutCallCount, 1, 'createPayout must never retry internally');
});

test('createPayout: uses the exact supplied senderBatchId — never generates or mutates it', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'PENDING' } }));
	const service = await loadPaypalService();

	await service.createPayout({ ...VALID_PAYOUT_PARAMS, senderBatchId: 'exact-caller-supplied-id' });

	const payoutCall = calls.find(c => c.url.includes('/v1/payments/payouts'));
	const body = JSON.parse(payoutCall!.init.body);
	assert.equal(body.sender_batch_header.sender_batch_id, 'exact-caller-supplied-id');
});

test('createPayout: never reads process.env for the recipient, and has no ProviderProfile/User dependency at all — recipient comes only from its explicit input', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-1', batch_status: 'PENDING' } }));
	const service = await loadPaypalService();

	// createPayout() takes no userId/withdrawalId/providerId parameter at
	// all — there is no way for it to look anything up from a profile or
	// user row even in principle. This test locks in that its only source
	// of the recipient is the recipientEmail field on its own input.
	await service.createPayout({ ...VALID_PAYOUT_PARAMS, recipientEmail: 'only-this-one@example.com' });

	const payoutCall = calls.find(c => c.url.includes('/v1/payments/payouts'));
	const body = JSON.parse(payoutCall!.init.body);
	assert.equal(body.items[0].receiver, 'only-this-one@example.com');
});
