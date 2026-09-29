import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Payout P2-C: sendWithdrawalPayout()'s entire job is to be a thin pass-
// through to payoutService.sendPayout(withdrawalId) — no financial field of
// any kind may ever be read from req.body. This is tested by mocking
// payoutService itself (not the DB) so the exact arguments the controller
// passes can be asserted directly, independent of the service's own
// internal behavior (which payout.service.test.ts already covers).

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

async function loadController(t: TestContext, sendPayoutImpl: (id: string) => Promise<any>) {
  const sendPayoutSpy = t.mock.fn(sendPayoutImpl);
  t.mock.module('../services/payout.service', { namedExports: { payoutService: { sendPayout: sendPayoutSpy } } });
  const moduleUrl = `./withdrawal.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const controllerModule = await import(moduleUrl);
  return { sendWithdrawalPayout: controllerModule.sendWithdrawalPayout, sendPayoutSpy };
}

test('sendWithdrawalPayout: calls payoutService.sendPayout with ONLY the URL id — a malicious request body (amount/recipient/currency/senderBatchId overrides) is completely ignored', async (t) => {
	const { sendWithdrawalPayout, sendPayoutSpy } = await loadController(t, async (id: string) => ({
		outcome: 'ACCEPTED', withdrawalId: id, payoutAttemptId: 'attempt-1', payoutBatchId: 'PB-1', message: 'ok'
	}));

	const req: any = {
		params: { id: 'wd-1' },
		body: {
			amount: 999999,
			recipientEmail: 'attacker@evil.example',
			paypalEmail: 'attacker@evil.example',
			senderBatchId: 'attacker-controlled-batch',
			senderItemId: 'attacker-controlled-item',
			currency: 'EUR'
		}
	};
	const res = createMockRes();
	let passedError: any = null;
	await sendWithdrawalPayout(req, res, (err: any) => { passedError = err; });

	assert.equal(passedError, null);
	assert.equal(sendPayoutSpy.mock.callCount(), 1);
	assert.deepEqual(sendPayoutSpy.mock.calls[0].arguments, ['wd-1'], 'sendPayout must be called with ONLY the id string — nothing derived from req.body');
	assert.equal(res.body.success, true);
	assert.equal(res.body.data.outcome, 'ACCEPTED');
});

test('sendWithdrawalPayout: an empty/missing request body works identically — the endpoint needs no body at all', async (t) => {
	const { sendWithdrawalPayout, sendPayoutSpy } = await loadController(t, async (id: string) => ({
		outcome: 'UNKNOWN', withdrawalId: id, payoutAttemptId: 'attempt-1', message: 'pending'
	}));

	const req: any = { params: { id: 'wd-1' } }; // no body property at all
	const res = createMockRes();
	let passedError: any = null;
	await sendWithdrawalPayout(req, res, (err: any) => { passedError = err; });

	assert.equal(passedError, null);
	assert.deepEqual(sendPayoutSpy.mock.calls[0].arguments, ['wd-1']);
	assert.equal(res.body.data.outcome, 'UNKNOWN');
});

test('sendWithdrawalPayout: a thrown AppError from the service (e.g. local validation failure) propagates to next(), no response is sent', async (t) => {
	const { AppError } = await import('../utils/app-error');
	const { sendWithdrawalPayout } = await loadController(t, async () => {
		throw new AppError('طلب السحب ليس عبر PayPal — لا يمكن إرساله عبر بوابة PayPal', 400);
	});

	const req: any = { params: { id: 'wd-1' }, body: {} };
	const res = createMockRes();
	let passedError: any = null;
	await sendWithdrawalPayout(req, res, (err: any) => { passedError = err; });

	assert.notEqual(passedError, null);
	assert.equal(passedError.statusCode, 400);
	assert.equal(res.body, null, 'no response should be sent when the service throws');
});
