import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The bank-facing endpoints: public, exact answers, nothing from the request is echoed or trusted. The payment service is replaced by a recorder
// (the real logic is proven in arb-payment.pg.test.ts on an isolated PostgreSQL with a simulated bank).
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
process.env.FRONTEND_URL = 'https://front.test';

const calls: any[] = [];
let mode: 'ok' | 'unknown' | 'throw' = 'ok';
let ack = true;
mock.module('../services/arb-payment.service', {
	namedExports: {
		arbPaymentService: {
			isAvailable: () => false,
			handleReturn: async (i: any) => { calls.push(['return', i]); if (mode === 'throw') throw new Error('boom <script>'); return { reference: mode === 'unknown' ? null : 'ref-123' }; },
			handleError: async (i: any) => { calls.push(['error', i]); return { reference: 'ref-err' }; },
			handleWebhook: async (i: any) => { calls.push(['webhook', i]); if (mode === 'throw') throw new Error('boom'); return { ack: Array.isArray(i) && i.length > 0 }; },
			handleNotification: async (i: any) => { calls.push(['notify', i]); if (mode === 'throw') throw new Error('boom'); return ack ? { ack: true, responseUrl: 'https://app.test/api/payments/arb/response' } : { ack: false, responseUrl: null }; },
		},
	},
});

async function call(method: string, url: string, body?: string, ctype?: string) {
	const express = (await import('express')).default;
	const router = (await import('./arb-payments.routes.ts')).default;
	const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: true })); app.use('/api/payments/arb', router);
	const server = http.createServer(app);
	await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	try {
		const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`, { method, body, headers: { connection: 'close', ...(ctype ? { 'content-type': ctype } : {}) }, redirect: 'manual' });
		return { status: res.status, location: res.headers.get('location'), text: await res.text() };
	} finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}

test('responseURL by GET and by POST form: 303 to the wallet page with only the opaque reference; nothing from the request is echoed', async () => {
	calls.length = 0; mode = 'ok';
	const g = await call('GET', '/api/payments/arb/response?PaymentID=100201931620827468&trandata=ABCDEF&x=%3Cscript%3E');
	assert.equal(g.status, 303); assert.equal(g.location, 'https://front.test/client-overview/finance/wallet?arb=ref-123');
	assert.ok(!g.text.includes('script') && !(g.location || '').includes('ABCDEF'));
	assert.deepEqual(calls[0], ['return', { paymentId: '100201931620827468', trandata: 'ABCDEF' }]);
	const p = await call('POST', '/api/payments/arb/response', 'paymentId=100201931620827468&trandata=ABCDEF&error=&errorText=', 'application/x-www-form-urlencoded');
	assert.equal(p.status, 303); assert.equal(p.location, 'https://front.test/client-overview/finance/wallet?arb=ref-123');
	const j = await call('POST', '/api/payments/arb/response', JSON.stringify([{ paymentId: '1' }]), 'application/json'); // an array body is not a field map: still a safe redirect
	assert.equal(j.status, 303);
});

test('unknown attempt and service failure both end on the wallet page (no stack, no error text, no 500)', async () => {
	mode = 'unknown'; const a = await call('GET', '/api/payments/arb/response?paymentId=1');
	assert.equal(a.status, 303); assert.equal(a.location, 'https://front.test/client-overview/finance/wallet?arb=unknown');
	mode = 'throw'; const b = await call('GET', '/api/payments/arb/response?paymentId=1');
	assert.equal(b.status, 303); assert.equal(b.location, 'https://front.test/client-overview/finance/wallet?arb=unknown'); assert.ok(!b.text.includes('boom'));
	mode = 'ok';
});

test('errorURL goes through the error handler, not the success one', async () => {
	calls.length = 0; mode = 'ok';
	const r = await call('POST', '/api/payments/arb/error', 'paymentId=100201931620827468&error=IPAY0100045', 'application/x-www-form-urlencoded');
	assert.equal(r.status, 303); assert.equal(r.location, 'https://front.test/client-overview/finance/wallet?arb=ref-err');
	assert.equal(calls[0][0], 'error');
});

test('notification: exact acknowledgement [{status:"1",result:<responseURL>}] (guide p.191); anything else is NOT an acknowledgement', async () => {
	mode = 'ok'; ack = true;
	const a = await call('POST', '/api/payments/arb/notify', JSON.stringify({ paymentId: '100201931620827468', trandata: 'AB' }), 'application/json');
	assert.equal(a.status, 200); assert.deepEqual(JSON.parse(a.text), [{ status: '1', result: 'https://app.test/api/payments/arb/response' }]);
	// the bank really sends an ARRAY with one object (guide p.189): its fields must reach the service, and the redirect URL is ours, never taken from the request
	calls.length = 0;
	const arr = await call('POST', '/api/payments/arb/notify', JSON.stringify([{ paymentId: '100201931620827468', trandata: 'AB', responseURL: 'https://evil.example/x' }]), 'application/json');
	assert.equal(arr.status, 200); assert.deepEqual(calls[0][1], { paymentId: '100201931620827468', trandata: 'AB' });
	assert.deepEqual(JSON.parse(arr.text), [{ status: '1', result: 'https://app.test/api/payments/arb/response' }]); assert.ok(!arr.text.includes('evil'));
	ack = false;
	const n = await call('POST', '/api/payments/arb/notify', JSON.stringify({ paymentId: 'x', trandata: 'AB' }), 'application/json');
	assert.equal(n.status, 400); assert.notEqual(JSON.parse(n.text)[0].status, '1');
	mode = 'throw';
	const t = await call('POST', '/api/payments/arb/notify', JSON.stringify({}), 'application/json');
	assert.equal(t.status, 500); assert.notEqual(JSON.parse(t.text)[0].status, '1'); assert.ok(!t.text.includes('boom'));
	assert.equal((await call('GET', '/api/payments/arb/notify')).status, 404); // notification is POST only
	mode = 'ok'; ack = true;
});

test('webhook (guide p.179-186): exact acknowledgement `[{status:"1"}]`; unreadable body or a storage failure is NOT acknowledged so the gateway resends', async () => {
	mode = 'ok';
	const a = await call('POST', '/api/payments/arb/webhook', JSON.stringify([{ type: 'PAYMENT', result: [{ status: 'CAPTURED' }], payLoad: [{ paymentId: '1' }] }]), 'application/json');
	assert.equal(a.status, 200); assert.deepEqual(JSON.parse(a.text), [{ status: '1' }]);
	const g = await call('POST', '/api/payments/arb/webhook', JSON.stringify([]), 'application/json');
	assert.equal(g.status, 400); assert.notEqual(JSON.parse(g.text)[0].status, '1');
	mode = 'throw';
	const t = await call('POST', '/api/payments/arb/webhook', JSON.stringify([{ x: 1 }]), 'application/json');
	assert.equal(t.status, 500); assert.notEqual(JSON.parse(t.text)[0].status, '1'); assert.ok(!t.text.includes('boom'));
	mode = 'ok';
});

test('the browser request DTO carries only the net USD: extra fields (amount, currency, status) are refused, bounds enforced', async () => {
	const { initiateArbPaymentSchema: s } = await import('../dtos/arb.dto');
	assert.equal(s.safeParse({ netUsd: 100 }).success, true);
	for (const bad of [{ netUsd: 100, amount: 1 }, { netUsd: 100, currency: 'USD' }, { netUsd: 100, currencyCode: '840', status: 'CAPTURED' }, { netUsd: 100, acknowledgePreviousRisk: true }, { netUsd: 49.99 }, { netUsd: 100001 }, { netUsd: '100' }, {}, { netUsd: NaN }]) {
		assert.equal(s.safeParse(bad).success, false, JSON.stringify(bad));
	}
});
