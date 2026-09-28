import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Regression guard for the "USD is now the canonical wallet currency"
// follow-up: Moyasar's own deposit flow was deliberately left untouched
// (see paypal-finance.service.ts's currency-mixing blocker) and must keep
// verifying SAR exactly as before — this locks that in with a real test,
// since no test previously existed for moyasar.service.ts at all.

function mockFetchJson(t: TestContext, body: any, status = 200) {
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

async function loadService() {
	const moduleUrl = `./moyasar.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { MoyasarService } = await import(moduleUrl);
	return new MoyasarService();
}

test('MoyasarService.verifyDeposit: a payment in a currency other than SAR is rejected', async (t) => {
	process.env.MOYASAR_SECRET_KEY = 'test-secret';
	process.env.MOYASAR_PUBLISHABLE_KEY = 'test-pub';
	mockFetchJson(t, { id: 'pay_1', status: 'paid', amount: 5000, currency: 'USD' });

	const service = await loadService();
	const result = await service.verifyDeposit('pay_1', 50);

	assert.equal(result.valid, false);
	assert.match(result.reason || '', /الريال السعودي/);
});

test('MoyasarService.verifyDeposit: a SAR payment matching the expected amount is accepted', async (t) => {
	process.env.MOYASAR_SECRET_KEY = 'test-secret';
	process.env.MOYASAR_PUBLISHABLE_KEY = 'test-pub';
	mockFetchJson(t, { id: 'pay_1', status: 'paid', amount: 5000, currency: 'SAR' }); // 5000 halalas = 50 SAR

	const service = await loadService();
	const result = await service.verifyDeposit('pay_1', 50);

	assert.equal(result.valid, true);
	assert.equal(result.payment?.currency, 'SAR');
});

test('MoyasarService.verifyDeposit: a SAR payment whose amount does not match the expected amount is rejected', async (t) => {
	process.env.MOYASAR_SECRET_KEY = 'test-secret';
	process.env.MOYASAR_PUBLISHABLE_KEY = 'test-pub';
	mockFetchJson(t, { id: 'pay_1', status: 'paid', amount: 4000, currency: 'SAR' }); // 40 SAR, expected 50

	const service = await loadService();
	const result = await service.verifyDeposit('pay_1', 50);

	assert.equal(result.valid, false);
});
