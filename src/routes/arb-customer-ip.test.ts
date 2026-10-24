import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The customer address the bank requires in X-FORWARDED-FOR (guide p.13) must come from the TRUSTED proxy chain, never from a header a user can write.
// Production topology: nginx appends the real peer (`proxy_add_x_forwarded_for`, seen in /etc/nginx/sites-available/dev.waseetai.com) and the app trusts the private proxy hop ('uniquelocal').
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';

async function ipSeen(headers: Record<string, string>, trustProxy?: string) {
	const express = (await import('express')).default;
	const { resolveTrustProxy } = await import('../config/trust-proxy');
	const { customerIpOf } = await import('../controllers/arb.controller');
	const app = express(); app.set('trust proxy', resolveTrustProxy(trustProxy));
	app.get('/ip', (req, res) => { res.json({ ip: customerIpOf(req) }); });
	const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	try { const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ip`, { headers: { connection: 'close', ...headers } }); return (await res.json() as any).ip as string; }
	finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}

test('a forged left-hand X-FORWARDED-FOR entry is ignored: the address nginx appended (the real peer) wins', async () => {
	// the test socket is loopback, so 'loopback' stands for the trusted nginx hop (production trusts the private Docker gateway the same way)
	assert.equal(await ipSeen({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, 'loopback'), '203.0.113.9');
	assert.equal(await ipSeen({ 'x-forwarded-for': '10.0.0.1, 6.6.6.6, 203.0.113.9' }, 'loopback'), '203.0.113.9');
	assert.equal(await ipSeen({ 'x-forwarded-for': '203.0.113.9' }, 'loopback'), '203.0.113.9');
});

test('a caller that is NOT a trusted proxy (direct hit on the published port) cannot choose its address: the header is ignored', async () => {
	assert.equal(await ipSeen({ 'x-forwarded-for': '203.0.113.9' }), '127.0.0.1'); // default 'uniquelocal' does not trust this socket
});

test('with no proxy header the socket address is used (here loopback, which the service then refuses as not public)', async () => {
	assert.equal(await ipSeen({}), '127.0.0.1');
	const { isPublicIp } = await import('../services/arb-payment.service');
	assert.equal(isPublicIp('127.0.0.1'), false);
	assert.equal(isPublicIp('203.0.113.9'), true); assert.equal(isPublicIp('2001:db8::1'), true); assert.equal(isPublicIp('::ffff:7f00:1'.replace('::ffff:', '')), false);
});
