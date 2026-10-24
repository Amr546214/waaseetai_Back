import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostedPayment, inquire, isAllowedBankUrl, readReturnTrandata } from './arb-client';
import { SimBank, TEST_HOST, TEST_KEY, testConfig } from './arb-sim-bank.testutil';
import { decryptTrandata, encryptTrandata } from '../utils/arb-crypto';

// API contract against the guide (v1.32). The bank is SIMULATED (arb-sim-bank.testutil.ts); nothing leaves the machine.
const params = { amountSar: '412.50', trackId: '1792000000000123', responseUrl: 'https://app.test/api/payments/arb/response', errorUrl: 'https://app.test/api/payments/arb/error', customerIp: '203.0.113.7', udf1: 'att-1', udf2: '682', udf3: 'user-1' };

test('Bank Hosted create request: shape, encrypted fields and the mandatory customer-IP header (guide p.13, p.18-20)', async () => {
	const bank = new SimBank(); const cfg = testConfig();
	const r = await createHostedPayment(cfg, bank, params);
	assert.equal(r.kind, 'OK');
	const call = bank.log[0];
	assert.equal(call.url, cfg.hostedTokenUrl);
	assert.equal(call.headers['X-FORWARDED-FOR'], '203.0.113.7'); // customer address FIRST (p.13)
	assert.equal(call.headers['Content-Type'], 'application/json');
	// the plain trandata carries exactly the documented fields with the documented values
	assert.deepEqual(call.plain, {
		amt: '412.50', action: '1', password: 'test-password', id: 'TESTTRANPORTALID', currencyCode: '682', trackId: '1792000000000123',
		responseURL: params.responseUrl, errorURL: params.errorUrl, udf1: 'att-1', udf2: '682', udf3: 'user-1', langid: 'ar',
	});
});

test('the outer request is [{id, trandata, responseURL, errorURL}] and trandata alone is encrypted (p.20)', async () => {
	let seen: any;
	const http = { post: async (_u: string, b: string) => { seen = JSON.parse(b); return { status: 200, text: JSON.stringify([{ status: '2', error: 'IPAY0100001', errorText: 'x', result: null }]) }; } };
	await createHostedPayment(testConfig(), http, params);
	assert.ok(Array.isArray(seen) && seen.length === 1);
	assert.deepEqual(Object.keys(seen[0]).sort(), ['errorURL', 'id', 'responseURL', 'trandata']);
	assert.equal(seen[0].id, 'TESTTRANPORTALID');
	assert.match(seen[0].trandata, /^[0-9A-F]+$/);
	assert.ok(!JSON.stringify(seen).includes('test-password')); // the password only travels inside the encrypted blob
	assert.equal(JSON.parse(decryptTrandata(seen[0].trandata, TEST_KEY))[0].password, 'test-password');
});

test('initial response (p.26-27): paymentId:url split on the FIRST colon, page URL framed as ?PaymentID=', async () => {
	const bank = new SimBank();
	const r: any = await createHostedPayment(testConfig(), bank, params);
	assert.match(r.paymentId, /^\d{10,25}$/);
	assert.equal(r.pageUrl, `https://${TEST_HOST}/pg/paymentpage.htm?PaymentID=${r.paymentId}`);
});

test('destination is checked BEFORE the user is sent there: other host, http, userinfo, bad payment id', async () => {
	const cfg = testConfig();
	for (const dest of ['https://evil.example/pg/paymentpage.htm', 'http://sim-bank.test/pg/paymentpage.htm', 'https://u:p@sim-bank.test/pg/paymentpage.htm', 'javascript:alert(1)']) {
		const bank = new SimBank(); bank.badDestination = dest;
		const r = await createHostedPayment(cfg, bank, params);
		assert.equal(r.kind, 'REJECTED', dest);
	}
	assert.equal(isAllowedBankUrl('https://SIM-BANK.test/x', cfg)?.hostname, 'sim-bank.test');
	assert.equal(isAllowedBankUrl('https://sim-bank.test.evil.com/x', cfg), null);
	const http = { post: async () => ({ status: 200, text: JSON.stringify([{ status: '1', result: `12:https://${TEST_HOST}/p`, error: null }]) }) };
	assert.equal((await createHostedPayment(cfg, http, params)).kind, 'REJECTED'); // payment id must be 10-25 digits
});

test('bank refusal is REJECTED with its code; every unclear answer is UNKNOWN (never a failure)', async () => {
	const bank = new SimBank(); bank.rejectCreate = 'IPAY0100024';
	assert.deepEqual(await createHostedPayment(testConfig(), bank, params), { kind: 'REJECTED', code: 'IPAY0100024' });
	const cases = [
		{ post: async () => { throw new Error('ETIMEDOUT'); } },
		{ post: async () => ({ status: 502, text: 'bad gateway' }) },
		{ post: async () => ({ status: 200, text: '<html>' }) },
		{ post: async () => ({ status: 200, text: JSON.stringify([{ status: '1', result: null }]) }) },
	];
	for (const h of cases) assert.equal((await createHostedPayment(testConfig(), h as any, params)).kind, 'UNKNOWN');
	assert.equal((await createHostedPayment(testConfig({ hostedTokenUrl: 'http://sim-bank.test/x' }), new SimBank(), params)).kind, 'REJECTED'); // plain http endpoint refused
});

test('Inquiry request: action 8 with udf5 + transId by PaymentID / TRANID / TrackID (p.130-132)', async () => {
	const bank = new SimBank(); const cfg = testConfig();
	await inquire(cfg, bank, { by: 'PaymentID', paymentId: '700111' }, '412.50', 'T1');
	await inquire(cfg, bank, { by: 'TRANID', transId: '2019' }, '412.50', 'T1');
	await inquire(cfg, bank, { by: 'TrackID', trackId: 'T1' }, '412.50', 'T1');
	assert.deepEqual(bank.log.map(l => [l.plain.action, l.plain.udf5, l.plain.transId, l.plain.amt, l.plain.currencyCode, l.url]), [
		['8', 'PaymentID', '700111', '412.50', '682', cfg.inquiryUrl], ['8', 'TRANID', '2019', '412.50', '682', cfg.inquiryUrl], ['8', 'TrackID', 'T1', '412.50', '682', cfg.inquiryUrl],
	]);
	assert.equal(bank.log[0].plain.password, 'test-password');
});

test('Inquiry answers: decrypted record, bank error, and UNKNOWN for network / garbage / wrong key', async () => {
	const bank = new SimBank(); const cfg = testConfig();
	await createHostedPayment(cfg, bank, params);
	const t = bank.last(); bank.settle(t.paymentId, 'CAPTURED', '201935166561122');
	const ok: any = await inquire(cfg, bank, { by: 'PaymentID', paymentId: t.paymentId }, '412.50', t.trackId);
	assert.equal(ok.kind, 'TXN'); assert.equal(ok.txn.result, 'CAPTURED'); assert.equal(ok.txn.transId, '201935166561122'); assert.equal(ok.txn.amt, '412.50');
	assert.equal((await inquire(cfg, bank, { by: 'TrackID', trackId: 'nope' }, '1.00', 'nope') as any).kind, 'BANK_ERROR');
	bank.failInquiry = 'timeout'; assert.equal((await inquire(cfg, bank, { by: 'TrackID', trackId: t.trackId }, '1.00', t.trackId)).kind, 'UNKNOWN');
	bank.failInquiry = 'garbage'; assert.equal((await inquire(cfg, bank, { by: 'TrackID', trackId: t.trackId }, '1.00', t.trackId)).kind, 'UNKNOWN');
	const wrongKey = { post: async () => ({ status: 200, text: JSON.stringify([{ status: '1', trandata: encryptTrandata('[{"result":"CAPTURED"}]', 'ZZZZZZZZZZZZZZZZ') }]) }) };
	assert.equal((await inquire(cfg, wrongKey as any, { by: 'TrackID', trackId: 'x' }, '1.00', 'x')).kind, 'UNKNOWN');
});

test('return trandata: unreadable / wrong key / not a string = null (untrusted), readable = normalized record', () => {
	const cfg = testConfig();
	assert.equal(readReturnTrandata(cfg, undefined), null);
	assert.equal(readReturnTrandata(cfg, 'GARBAGE'), null);
	assert.equal(readReturnTrandata(cfg, encryptTrandata('[{"result":"CAPTURED"}]', 'ZZZZZZZZZZZZZZZZ')), null);
	assert.equal(readReturnTrandata(cfg, encryptTrandata('[{"result":"CAPTURED","amt":"1.00","trackId":"5"}]', TEST_KEY))?.result, 'CAPTURED');
});

test('parseBankJson keeps 16+ digit ids exact (the gateway sends paymentId / transId as JSON numbers, guide p.182-190) and leaves strings and decimals alone', async () => {
	const { parseBankJson } = await import('./arb-client');
	const j = parseBankJson('[{"paymentId":100201935166676970,"transId":"201935166561122","amt":70.0,"note":"id 123456789012345678 inside a string","n":-1234567890123456789}]')[0];
	assert.equal(j.paymentId, '100201935166676970'); assert.equal(j.transId, '201935166561122'); assert.equal(j.amt, 70);
	assert.equal(j.note, 'id 123456789012345678 inside a string'); assert.equal(j.n, '-1234567890123456789');
});
