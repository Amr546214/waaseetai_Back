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

// ============================================================================
// Payout P3-B — getPayoutBatch() GET transport + outcome classification.
// TRANSPORT ONLY: no DB call anywhere in this file (structurally verified
// at the bottom of this section), no financial-completion decision from
// batch_status, item transaction_status recognized only from the documented
// set.
// ============================================================================

const VALID_BATCH_ID = 'PBBATCHID123';

function fullBatchResponse(overrides: any = {}) {
	return {
		batch_header: {
			payout_batch_id: VALID_BATCH_ID,
			batch_status: 'SUCCESS',
			...overrides.batch_header
		},
		items: overrides.items ?? [
			{
				payout_item_id: 'ITEM-1',
				payout_batch_id: VALID_BATCH_ID,
				transaction_status: 'SUCCESS',
				sender_item_id: 'attempt-1',
				receiver: 'provider@paypal-sandbox.example'
			}
		]
	};
}

test('getPayoutBatch: 1. GET URL uses the exact payoutBatchId, percent-encoded, with method GET', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse()));
	const service = await loadPaypalService();

	await service.getPayoutBatch(VALID_BATCH_ID);

	const getCall = calls.find(c => c.url.includes('/v1/payments/payouts/') && c.init.method === 'GET');
	assert.ok(getCall, 'expected a GET call to the payouts-batch endpoint');
	assert.equal(getCall!.url, `https://api-m.sandbox.paypal.com/v1/payments/payouts/${VALID_BATCH_ID}`);
});

test('getPayoutBatch: 2. an invalid payoutBatchId is rejected before any HTTP call (path injection/traversal prevention)', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse()));
	const service = await loadPaypalService();

	for (const bad of ['', '../etc/passwd', 'has spaces', 'slash/inside', 'PB?evil=1', 'PB#frag', 'x'.repeat(65)]) {
		await assert.rejects(() => service.getPayoutBatch(bad), `expected rejection for payoutBatchId: ${JSON.stringify(bad)}`);
	}
	assert.equal(calls.length, 0, 'no HTTP call of any kind for any invalid id');
});

test('getPayoutBatch: 3. the payout-specific OAuth token path is used', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse()));
	const service = await loadPaypalService();

	await service.getPayoutBatch(VALID_BATCH_ID);

	assert.ok(calls.find(c => c.url.includes('/v1/oauth2/token')), 'expected an OAuth token call');
});

test('getPayoutBatch: 4. a hung OAuth acquisition is genuinely aborted at exactly 15000ms, classifies UNKNOWN, and no GET is ever attempted', async (t) => {
	let oauthFetchCalled = false;
	let getFetchCalled = false;
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
		getFetchCalled = true;
		return jsonResponse(fullBatchResponse());
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const service = await loadPaypalService();

	const promise = service.getPayoutBatch(VALID_BATCH_ID);
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));

	let settled = false;
	promise.then(() => { settled = true; });

	t.mock.timers.tick(14999);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(settled, false);

	t.mock.timers.tick(1);
	const result = await promise;

	assert.equal(oauthFetchCalled, true);
	assert.equal(oauthSignalAborted, true);
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(getFetchCalled, false, 'no GET may ever be attempted once OAuth acquisition itself has timed out');
});

test('getPayoutBatch: 5-6. a hung GET request is genuinely aborted at exactly 15000ms, classifies UNKNOWN, and no retry occurs', async (t) => {
	let getFetchCallCount = 0;
	let getSignalAborted = false;

	t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
		if (String(url).includes('/v1/oauth2/token')) {
			return jsonResponse({ access_token: 'tok', expires_in: 3600 });
		}
		getFetchCallCount++;
		return new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => {
				getSignalAborted = true;
				const err: any = new Error('The operation was aborted');
				err.name = 'AbortError';
				reject(err);
			});
		});
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const service = await loadPaypalService();

	const promise = service.getPayoutBatch(VALID_BATCH_ID);
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));

	t.mock.timers.tick(15000);
	const result = await promise;

	assert.equal(getSignalAborted, true);
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(getFetchCallCount, 1, 'exactly one GET attempt — no retry on timeout');
});

test('getPayoutBatch: 7. a network/transport error is classified UNKNOWN with no retry', async (t) => {
	let getCallCount = 0;
	mockOAuthAndPayout(t, async () => { getCallCount++; throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); });
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(getCallCount, 1);
});

test('getPayoutBatch: 8. HTTP 500/404 are classified UNKNOWN, never payout failure or success, with no retry', async (t) => {
	let getCallCount = 0;
	mockOAuthAndPayout(t, async () => { getCallCount++; return jsonResponse({}, 500); });
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(getCallCount, 1);
});

test('getPayoutBatch: a 404 (batch not found) is classified UNKNOWN, never interpreted as failure', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ name: 'RESOURCE_NOT_FOUND' }, 404));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('getPayoutBatch: 9-11. a valid batch response is parsed narrowly — payoutItemId and senderItemId extracted correctly; senderBatchId is conservatively always undefined (removed speculative parsing, post-review)', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse()));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);

	assert.equal(result.outcome, 'FOUND');
	if (result.outcome === 'FOUND') {
		assert.equal(result.batch.payoutBatchId, VALID_BATCH_ID);
		// Post-review field-shape audit: the official contract confirmed for
		// this project does not document batch_header.sender_batch_header
		// being echoed back on a GET response — that prior speculative read
		// was removed. senderBatchId must always be undefined until a real
		// Sandbox-observed response justifies parsing it.
		assert.equal(result.batch.senderBatchId, undefined);
		assert.equal(result.batch.items.length, 1);
		assert.equal(result.batch.items[0].payoutItemId, 'ITEM-1');
		assert.equal(result.batch.items[0].senderItemId, 'attempt-1');
		assert.equal(result.batch.items[0].payoutBatchId, VALID_BATCH_ID);
	}
});

test('getPayoutBatch: 12. every documented item transaction status is recognized and normalized (trim/case-insensitive)', async (t) => {
	for (const status of ['SUCCESS', 'FAILED', 'PENDING', 'UNCLAIMED', 'RETURNED', 'ONHOLD', 'BLOCKED', 'REFUNDED', 'REVERSED']) {
		mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse({
			items: [{ payout_item_id: 'ITEM-1', payout_batch_id: VALID_BATCH_ID, transaction_status: `  ${status.toLowerCase()}  `, sender_item_id: 'attempt-1' }]
		})));
		const service = await loadPaypalService();
		const result = await service.getPayoutBatch(VALID_BATCH_ID);
		assert.equal(result.outcome, 'FOUND');
		if (result.outcome === 'FOUND') {
			assert.equal(result.batch.items[0].transactionStatus, status, `status ${status} must round-trip after trim+uppercase normalization`);
		}
	}
});

test('getPayoutBatch: 13. an unrecognized item status is conservative — transactionStatus undefined, never guessed', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse({
		items: [{ payout_item_id: 'ITEM-1', payout_batch_id: VALID_BATCH_ID, transaction_status: 'SOME_FUTURE_STATUS', sender_item_id: 'attempt-1' }]
	})));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'FOUND');
	if (result.outcome === 'FOUND') {
		assert.equal(result.batch.items[0].transactionStatus, undefined);
	}
});

test('getPayoutBatch: post-review — an item with an unknown/unrecognized status is NOT dropped from the result; its trusted identifiers (payoutItemId/senderItemId) are preserved for future investigation/correlation', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse({
		items: [{ payout_item_id: 'ITEM-KEEP-ME', payout_batch_id: VALID_BATCH_ID, transaction_status: 'SOME_FUTURE_STATUS', sender_item_id: 'attempt-keep-me' }]
	})));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'FOUND');
	if (result.outcome === 'FOUND') {
		assert.equal(result.batch.items.length, 1, 'the item must not be silently dropped merely because its status is unrecognized');
		assert.equal(result.batch.items[0].payoutItemId, 'ITEM-KEEP-ME');
		assert.equal(result.batch.items[0].senderItemId, 'attempt-keep-me');
		assert.equal(result.batch.items[0].transactionStatus, undefined);
	}
});

test('getPayoutBatch: post-review — a response whose batch_header.payout_batch_id does not match the REQUESTED payoutBatchId is classified UNKNOWN, never silently accepted', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse({ batch_header: { payout_batch_id: 'SOMEOTHERBATCHID' } })));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('getPayoutBatch: post-review — an item whose OWN payout_batch_id contradicts the batch-level id is classified UNKNOWN for the whole response, never silently normalized into the batch id', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse({
		items: [{ payout_item_id: 'ITEM-1', payout_batch_id: 'CONTRADICTORYBATCHID', transaction_status: 'SUCCESS', sender_item_id: 'attempt-1' }]
	})));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'UNKNOWN', 'a response containing contradictory PayPal identifiers must never look like a clean valid reconciliation response');
});

test('getPayoutBatch: 14. a missing transaction_status field is conservative — undefined, never guessed', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse({
		items: [{ payout_item_id: 'ITEM-1', payout_batch_id: VALID_BATCH_ID, sender_item_id: 'attempt-1' }]
	})));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'FOUND');
	if (result.outcome === 'FOUND') {
		assert.equal(result.batch.items[0].transactionStatus, undefined);
	}
});

test('getPayoutBatch: 15. a malformed 2xx response (missing payout_batch_id) is classified UNKNOWN, never FOUND', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { batch_status: 'SUCCESS' } }));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('getPayoutBatch: a non-JSON 2xx response is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('getPayoutBatch: 16. a batch_status of SUCCESS is plain passthrough data — this transport never treats it as financial completion, and makes no DB/state decision from it', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse({ batch_header: { batch_status: 'SUCCESS' } })));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	assert.equal(result.outcome, 'FOUND');
	if (result.outcome === 'FOUND') {
		// The type itself has no "COMPLETED"/financial-status concept at all —
		// batchStatus is just an informational string field.
		assert.equal(result.batch.batchStatus, 'SUCCESS');
		assert.equal(Object.keys(result).sort().join(','), 'batch,outcome');
		assert.equal('withdrawalStatus' in result, false);
		assert.equal('payoutAttemptStatus' in result, false);
	}
});

test('getPayoutBatch: 17. recipient/receiver PII is excluded from the returned typed result even when present deep in the raw response', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(fullBatchResponse({
		items: [{
			payout_item_id: 'ITEM-1', payout_batch_id: VALID_BATCH_ID, transaction_status: 'SUCCESS',
			payout_item: { sender_item_id: 'attempt-1', receiver: 'leaked-pii@example.com', amount: { value: '10.00', currency: 'USD' } }
		}]
	})));
	const service = await loadPaypalService();

	const result = await service.getPayoutBatch(VALID_BATCH_ID);
	const serialized = JSON.stringify(result);
	assert.equal(serialized.includes('leaked-pii@example.com'), false, 'the typed result must never carry the recipient email through');
	assert.equal(serialized.includes('test-access-token'), false);
});

test('getPayoutBatch: makes zero Prisma/DB calls — paypal.service.ts has no database import at all (structural guarantee)', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const source = fs.readFileSync(path.join(__dirname, 'paypal.service.ts'), 'utf8');
	assert.equal(source.includes("from '../config/db'"), false, 'this file must never import the Prisma client — every method in it, including getPayoutBatch()/recoverPayoutBySenderBatch(), is structurally incapable of touching the DB');
	assert.equal(source.includes('@prisma/client'), false);
});

// ============================================================================
// Payout P3-B — recoverPayoutBySenderBatch() idempotent resubmission
// transport + conservative duplicate-link recovery.
// ============================================================================

const RECOVERY_PARAMS = Object.freeze({
	senderBatchId: 'wd-recover-a1',
	senderItemId: 'attempt-99',
	recipientEmail: 'provider@paypal-sandbox.example',
	amount: 17.25
});

function trustedDuplicateLinkResponse(originalBatchId: string) {
	return {
		name: 'SOME_UNVERIFIED_NAME',
		message: 'free text that must never be trusted on its own',
		links: [
			{ href: `https://api-m.sandbox.paypal.com/v1/payments/payouts/${originalBatchId}`, rel: 'self', method: 'GET' }
		]
	};
}

test('recoverPayoutBySenderBatch: 18-21. reuses the exact senderBatchId/senderItemId/recipient/amount supplied — no substitution', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-FRESH-1' } }));
	const service = await loadPaypalService();

	await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);

	const postCall = calls.find(c => c.url.endsWith('/v1/payments/payouts') && c.init.method === 'POST');
	assert.ok(postCall, 'expected a POST to the create-payouts endpoint');
	const body = JSON.parse(postCall!.init.body);
	assert.equal(body.sender_batch_header.sender_batch_id, RECOVERY_PARAMS.senderBatchId);
	assert.equal(body.items[0].sender_item_id, RECOVERY_PARAMS.senderItemId);
	assert.equal(body.items[0].receiver, RECOVERY_PARAMS.recipientEmail);
	assert.equal(body.items[0].amount.value, '17.25');
});

test('recoverPayoutBySenderBatch: 22. currency is always the hardcoded USD literal, even if a caller-supplied currency field is injected via `as any`', async (t) => {
	const { calls } = mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PB-FRESH-1' } }));
	const service = await loadPaypalService();

	await service.recoverPayoutBySenderBatch({ ...RECOVERY_PARAMS, currency: 'EUR' } as any);

	const postCall = calls.find(c => c.url.endsWith('/v1/payments/payouts') && c.init.method === 'POST');
	const body = JSON.parse(postCall!.init.body);
	assert.equal(body.items[0].amount.currency, 'USD');
});

test('recoverPayoutBySenderBatch: 23-24. exactly one HTTP attempt is made — no generated replacement id, no retry loop', async (t) => {
	let postCallCount = 0;
	mockOAuthAndPayout(t, async () => { postCallCount++; return jsonResponse({}, 500); });
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(postCallCount, 1, 'no automatic retry from within this method');
});

test('recoverPayoutBySenderBatch: post-review — a 2xx response missing payout_batch_id is classified UNKNOWN, never RECOVERED', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { batch_status: 'PENDING' } }));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: post-review — RECOVERED means identity ONLY, never success/completion: the result is bounded to exactly {outcome, payoutBatchId} with no status-like field of any kind', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ batch_header: { payout_batch_id: 'PBFRESH1', batch_status: 'SUCCESS' } }));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'RECOVERED');
	assert.equal(Object.keys(result).sort().join(','), 'outcome,payoutBatchId', 'RECOVERED must never carry a status/transactionStatus/completed-like field — identity only, per PaypalRecoverPayoutResult\'s own documented semantic boundary');
	if (result.outcome === 'RECOVERED') {
		assert.equal('transactionStatus' in result, false);
		assert.equal('batchStatus' in result, false);
		assert.equal('completed' in result, false);
	}
});

test('recoverPayoutBySenderBatch: 25. a structurally valid original-payout HATEOAS link (trusted origin + expected path) recovers the batch id', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(trustedDuplicateLinkResponse('PBORIGINAL1'), 422));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'RECOVERED');
	if (result.outcome === 'RECOVERED') {
		assert.equal(result.payoutBatchId, 'PBORIGINAL1');
	}
});

test('recoverPayoutBySenderBatch: 26. a link pointing at an arbitrary external host is rejected — never trusted, never followed', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({
		links: [{ href: 'https://evil.example/v1/payments/payouts/PBORIGINAL1', rel: 'self' }]
	}, 400));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 27. a link with the correct trusted origin but the wrong resource path is rejected', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({
		links: [{ href: 'https://api-m.sandbox.paypal.com/v1/some-other-resource/PBORIGINAL1', rel: 'self' }]
	}, 400));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 28. a malformed href never crashes and never recovers', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({
		links: [{ href: 'not a url at all', rel: 'self' }]
	}, 400));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 29. a free-text error claiming "duplicate" with no links array at all is NOT enough to recover', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({
		name: 'DUPLICATE_BATCH', message: 'A batch with this sender_batch_id already exists, see the original payout.'
	}, 400));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 30. a generic VALIDATION_ERROR name with no valid link is NOT enough to recover', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({ name: 'VALIDATION_ERROR', message: 'Invalid request.' }, 400));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 31. an arbitrary 4xx with no valid link at all is UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({}, 409));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 32. a timeout is classified UNKNOWN, with exactly one attempt', async (t) => {
	let postCallCount = 0;
	t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
		if (String(url).includes('/v1/oauth2/token')) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
		postCallCount++;
		return new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => {
				const err: any = new Error('aborted');
				err.name = 'AbortError';
				reject(err);
			});
		});
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const service = await loadPaypalService();

	const promise = service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
	t.mock.timers.tick(15000);
	const result = await promise;

	assert.equal(result.outcome, 'UNKNOWN');
	assert.equal(postCallCount, 1);
});

test('recoverPayoutBySenderBatch: 33. a network/transport error is classified UNKNOWN', async (t) => {
	mockOAuthAndPayout(t, async () => { throw new TypeError('fetch failed'); });
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 34. HTTP 5xx is classified UNKNOWN even if a structurally-valid-looking link is present — 5xx is never eligible for recovery', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse(trustedDuplicateLinkResponse('PB-SHOULD-NOT-RECOVER'), 500));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 35. a malformed (non-JSON) 4xx response is classified UNKNOWN, never crashes', async (t) => {
	mockOAuthAndPayout(t, async () => new Response('<html>error</html>', { status: 400, headers: { 'content-type': 'text/html' } }));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	assert.equal(result.outcome, 'UNKNOWN');
});

test('recoverPayoutBySenderBatch: 36. the returned result never contains recipient PII, raw body, debug_id, or the access token', async (t) => {
	mockOAuthAndPayout(t, async () => jsonResponse({
		name: 'VALIDATION_ERROR', message: 'contains ' + RECOVERY_PARAMS.recipientEmail, debug_id: 'debug-secret-123',
		links: [{ href: `https://api-m.sandbox.paypal.com/v1/payments/payouts/PBORIGINAL1`, rel: 'self' }]
	}, 400));
	const service = await loadPaypalService();

	const result = await service.recoverPayoutBySenderBatch(RECOVERY_PARAMS);
	const serialized = JSON.stringify(result);
	assert.equal(serialized.includes(RECOVERY_PARAMS.recipientEmail), false);
	assert.equal(serialized.includes('debug-secret-123'), false);
	assert.equal(serialized.includes('test-access-token'), false);
	// RECOVERED in this case, since the link IS valid — but the result shape
	// itself must still be bounded to exactly {outcome, payoutBatchId}.
	if (result.outcome === 'RECOVERED') {
		assert.equal(Object.keys(result).sort().join(','), 'outcome,payoutBatchId');
	}
});

test('recoverPayoutBySenderBatch: 37. makes zero Prisma/DB calls (same structural guarantee as getPayoutBatch)', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const source = fs.readFileSync(path.join(__dirname, 'paypal.service.ts'), 'utf8');
	assert.equal(source.includes("from '../config/db'"), false);
});
