import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Release gate (Payout P3-D excluded from this release — see
// utils/payout-automation.util.ts): the controller now short-circuits the
// payout branch with an honest 200 ack BEFORE calling
// payoutWebhookService.processPayoutWebhookEvent() at all, unless
// PAYOUT_AUTOMATION_ENABLED='true'. The pre-existing payout-dispatch tests
// below are exercising the real pipeline-delegation behavior, so this file
// enables the flag for its own duration; dedicated tests further down cover
// the disabled (default) gate itself. The deposit-path tests are unaffected
// either way — the gate only wraps the payout branch.
process.env.PAYOUT_AUTOMATION_ENABLED = 'true';

function mockDeps(
	t: TestContext,
	opts: {
		verifyWebhookSignature?: any;
		completeFromWebhook?: any;
		denyFromWebhook?: any;
		processPayoutWebhookEvent?: any;
	} = {}
) {
	const completeFromWebhookSpy = t.mock.fn(opts.completeFromWebhook || (async () => ({ handled: true, alreadyCompleted: false })));
	const denyFromWebhookSpy = t.mock.fn(opts.denyFromWebhook || (async () => undefined));
	const processPayoutWebhookEventSpy = t.mock.fn(opts.processPayoutWebhookEvent || (async () => ({ httpStatus: 200 })));

	t.mock.module('../services/paypal.service', {
		namedExports: {
			paypalService: {
				verifyWebhookSignature: opts.verifyWebhookSignature || (async () => true)
			}
		}
	});
	t.mock.module('../services/paypal-finance.service', {
		namedExports: {
			paypalFinanceService: {
				completeFromWebhook: completeFromWebhookSpy,
				denyFromWebhook: denyFromWebhookSpy
			}
		}
	});
	// Payout P3-D: mocked separately from the deposit finance service above —
	// the two must never call into each other (see the tests below).
	t.mock.module('../services/payout-webhook.service', {
		namedExports: {
			payoutWebhookService: { processPayoutWebhookEvent: processPayoutWebhookEventSpy },
			SUPPORTED_PAYOUT_EVENT_TYPES: new Set([
				'PAYMENT.PAYOUTSBATCH.DENIED', 'PAYMENT.PAYOUTSBATCH.PROCESSING', 'PAYMENT.PAYOUTSBATCH.SUCCESS',
				'PAYMENT.PAYOUTS-ITEM.BLOCKED', 'PAYMENT.PAYOUTS-ITEM.CANCELED', 'PAYMENT.PAYOUTS-ITEM.FAILED',
				'PAYMENT.PAYOUTS-ITEM.HELD', 'PAYMENT.PAYOUTS-ITEM.REFUNDED', 'PAYMENT.PAYOUTS-ITEM.RETURNED',
				'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED'
			])
		}
	});

	return { completeFromWebhookSpy, denyFromWebhookSpy, processPayoutWebhookEventSpy };
}

function makeReqRes(body: any, headers: Record<string, string> = {}) {
	const defaultHeaders: Record<string, string> = {
		'paypal-transmission-id': 't1',
		'paypal-transmission-time': '2026-01-01T00:00:00Z',
		'paypal-cert-url': 'https://api.paypal.com/cert',
		'paypal-auth-algo': 'SHA256withRSA',
		'paypal-transmission-sig': 'sig',
		...headers
	};

	const req: any = {
		body,
		header: (name: string) => defaultHeaders[name.toLowerCase()]
	};

	let statusCode = 0;
	let jsonBody: any = null;
	const res: any = {
		status(code: number) {
			statusCode = code;
			return this;
		},
		json(body: any) {
			jsonBody = body;
			return this;
		}
	};

	return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
}

async function loadController(t: TestContext) {
	const moduleUrl = `./paypal-webhook.controller.ts?fixture=${Date.now()}-${Math.random()}`;
	const { handlePaypalWebhook } = await import(moduleUrl);
	return handlePaypalWebhook;
}

test('webhook: an invalid signature is rejected with no financial side effects', async (t) => {
	const { completeFromWebhookSpy, denyFromWebhookSpy } = mockDeps(t, { verifyWebhookSignature: async () => false });
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} });
	await handler(req, res, () => {});

	assert.equal(getStatus(), 400);
	assert.equal(completeFromWebhookSpy.mock.callCount(), 0);
	assert.equal(denyFromWebhookSpy.mock.callCount(), 0);
});

test('webhook: missing signature headers are rejected with no financial side effects', async (t) => {
	const { completeFromWebhookSpy } = mockDeps(t);
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }, { 'paypal-transmission-sig': '' });
	await handler(req, res, () => {});

	assert.equal(getStatus(), 400);
	assert.equal(completeFromWebhookSpy.mock.callCount(), 0);
});

test('webhook: an unsupported/unsubscribed event type is acknowledged without any side effects', async (t) => {
	const { completeFromWebhookSpy, denyFromWebhookSpy } = mockDeps(t);
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: {} });
	await handler(req, res, () => {});

	assert.equal(getStatus(), 200);
	assert.equal(completeFromWebhookSpy.mock.callCount(), 0);
	assert.equal(denyFromWebhookSpy.mock.callCount(), 0);
});

test('webhook: PAYMENT.CAPTURE.COMPLETED with a verified signature correlates order/capture/amount to the finance service', async (t) => {
	const { completeFromWebhookSpy } = mockDeps(t);
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({
		event_type: 'PAYMENT.CAPTURE.COMPLETED',
		resource: {
			id: 'CAPTURE-1',
			amount: { currency_code: 'USD', value: '50.00' },
			supplementary_data: { related_ids: { order_id: 'ORDER-1' } }
		}
	});
	await handler(req, res, () => {});

	assert.equal(getStatus(), 200);
	assert.equal(completeFromWebhookSpy.mock.callCount(), 1);
	assert.deepEqual(completeFromWebhookSpy.mock.calls[0].arguments[0], {
		paypalOrderId: 'ORDER-1',
		paypalCaptureId: 'CAPTURE-1',
		currency: 'USD',
		amountValue: '50.00'
	});
});

test('webhook: PAYMENT.CAPTURE.DENIED with a verified signature marks the payment failed and never credits', async (t) => {
	const { denyFromWebhookSpy } = mockDeps(t);
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({
		event_type: 'PAYMENT.CAPTURE.DENIED',
		resource: { id: 'CAPTURE-1', supplementary_data: { related_ids: { order_id: 'ORDER-1' } } }
	});
	await handler(req, res, () => {});

	assert.equal(getStatus(), 200);
	assert.equal(denyFromWebhookSpy.mock.callCount(), 1);
	assert.equal(denyFromWebhookSpy.mock.calls[0].arguments[0], 'ORDER-1');
});

// ── Payout P3-D: dispatch/regression tests only — the payout pipeline's own
// dedup/correlation/reconciliation behavior is exhaustively covered in
// payout-webhook.service.test.ts. These tests verify ONLY that this
// controller routes correctly and that the two pipelines never cross. ──

test('webhook: a supported PAYOUT event with a verified signature delegates to payoutWebhookService and returns ITS httpStatus, never touching the deposit finance service', async (t) => {
	const { completeFromWebhookSpy, denyFromWebhookSpy, processPayoutWebhookEventSpy } = mockDeps(t, {
		processPayoutWebhookEvent: async () => ({ httpStatus: 200 })
	});
	const handler = await loadController(t);

	const webhookEvent = { id: 'WH-1', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_item_id: 'ITEM-1' } };
	const { req, res, getStatus } = makeReqRes(webhookEvent);
	await handler(req, res, () => {});

	assert.equal(getStatus(), 200);
	assert.equal(processPayoutWebhookEventSpy.mock.callCount(), 1);
	assert.deepEqual(processPayoutWebhookEventSpy.mock.calls[0].arguments[0], webhookEvent);
	assert.equal(completeFromWebhookSpy.mock.callCount(), 0, 'a payout event must never reach the deposit handlers');
	assert.equal(denyFromWebhookSpy.mock.callCount(), 0);
});

test('webhook: the payout pipeline reporting a 5xx is surfaced verbatim, without leaking any internal error detail', async (t) => {
	const { processPayoutWebhookEventSpy } = mockDeps(t, { processPayoutWebhookEvent: async () => ({ httpStatus: 500 }) });
	const handler = await loadController(t);

	const { req, res, getStatus, getJson } = makeReqRes({ id: 'WH-1', event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { payout_batch_id: 'BATCH-1' } });
	await handler(req, res, () => {});

	assert.equal(getStatus(), 500);
	assert.equal(processPayoutWebhookEventSpy.mock.callCount(), 1);
	assert.equal(getJson().success, false);
	assert.doesNotMatch(JSON.stringify(getJson()), /Error|stack|prisma/i);
});

test('webhook: the payout pipeline reporting 400 (malformed payload) is surfaced, without payout processing being retried by this controller', async (t) => {
	const { processPayoutWebhookEventSpy } = mockDeps(t, { processPayoutWebhookEvent: async () => ({ httpStatus: 400 }) });
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({ event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: {} });
	await handler(req, res, () => {});

	assert.equal(getStatus(), 400);
	assert.equal(processPayoutWebhookEventSpy.mock.callCount(), 1);
});

test('webhook: an invalid signature is rejected even for a payout event type — never reaches payoutWebhookService', async (t) => {
	const { processPayoutWebhookEventSpy } = mockDeps(t, { verifyWebhookSignature: async () => false });
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({ id: 'WH-1', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: {} });
	await handler(req, res, () => {});

	assert.equal(getStatus(), 400);
	assert.equal(processPayoutWebhookEventSpy.mock.callCount(), 0);
});

test('webhook: a deposit event never reaches payoutWebhookService', async (t) => {
	const { processPayoutWebhookEventSpy } = mockDeps(t);
	const handler = await loadController(t);

	const { req, res } = makeReqRes({
		event_type: 'PAYMENT.CAPTURE.COMPLETED',
		resource: { id: 'CAPTURE-1', amount: { currency_code: 'USD', value: '50.00' }, supplementary_data: { related_ids: { order_id: 'ORDER-1' } } }
	});
	await handler(req, res, () => {});

	assert.equal(processPayoutWebhookEventSpy.mock.callCount(), 0);
});

test('webhook: release gate — PAYOUT_AUTOMATION_ENABLED unset (default) acks a payout event honestly without calling payoutWebhookService, and never touches the deposit path either', async (t) => {
	const previous = process.env.PAYOUT_AUTOMATION_ENABLED;
	delete process.env.PAYOUT_AUTOMATION_ENABLED;
	t.after(() => {
		if (previous === undefined) delete process.env.PAYOUT_AUTOMATION_ENABLED;
		else process.env.PAYOUT_AUTOMATION_ENABLED = previous;
	});

	const { completeFromWebhookSpy, denyFromWebhookSpy, processPayoutWebhookEventSpy } = mockDeps(t);
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({ id: 'WH-1', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_item_id: 'ITEM-1' } });
	await handler(req, res, () => {});

	assert.equal(getStatus(), 200, 'must ack with 2xx so PayPal does not retry, even while the gate is closed');
	assert.equal(processPayoutWebhookEventSpy.mock.callCount(), 0, 'the payout pipeline must never be called while the gate is closed');
	assert.equal(completeFromWebhookSpy.mock.callCount(), 0);
	assert.equal(denyFromWebhookSpy.mock.callCount(), 0);
});

test('webhook: release gate does not affect deposit events — PAYMENT.CAPTURE.COMPLETED still processes normally while the payout gate is closed', async (t) => {
	const previous = process.env.PAYOUT_AUTOMATION_ENABLED;
	delete process.env.PAYOUT_AUTOMATION_ENABLED;
	t.after(() => {
		if (previous === undefined) delete process.env.PAYOUT_AUTOMATION_ENABLED;
		else process.env.PAYOUT_AUTOMATION_ENABLED = previous;
	});

	const { completeFromWebhookSpy } = mockDeps(t);
	const handler = await loadController(t);

	const { req, res, getStatus } = makeReqRes({
		event_type: 'PAYMENT.CAPTURE.COMPLETED',
		resource: { id: 'CAPTURE-1', amount: { currency_code: 'USD', value: '50.00' }, supplementary_data: { related_ids: { order_id: 'ORDER-1' } } }
	});
	await handler(req, res, () => {});

	assert.equal(getStatus(), 200);
	assert.equal(completeFromWebhookSpy.mock.callCount(), 1, 'deposit processing must be completely unaffected by the payout release gate');
});
