import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { resolveTrustProxy } from '../config/trust-proxy';
import { trustedClientIp, trustFunction, cameThroughTrustedProxy, trustProxyDescription } from './client-ip';

/**
 * Express and the shared address rule must give the SAME client address for every TRUST_PROXY form. proxyaddr.compile() alone throws on a hop COUNT or on `false`; trustFunction() reproduces
 * Express's own semantics. Each case sends a real HTTP request with a forged / multi-hop X-Forwarded-For to a real Express app configured exactly as app.ts does.
 */
async function ask(trustEnv: string | undefined, xff: string | undefined): Promise<{ express: string; shared: string; peerTrusted: boolean }> {
	const env = (trustEnv === undefined ? {} : { TRUST_PROXY: trustEnv }) as NodeJS.ProcessEnv;
	const app = express();
	app.set('trust proxy', resolveTrustProxy(env.TRUST_PROXY));
	app.get('/', (req, res) => { res.json({ express: String(req.ip), shared: trustedClientIp(req, env), peerTrusted: cameThroughTrustedProxy(req, env) }); });
	const server = await new Promise<http.Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
	try {
		const port = (server.address() as { port: number }).port;
		return await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/', headers: xff ? { 'x-forwarded-for': xff } : {} }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject); });
	} finally { server.close(); }
}
const norm = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);
const XFF = '203.0.113.9, 198.51.100.4, 10.1.2.3'; // client, proxy-1 (public), proxy-2 (private); the real peer is 127.0.0.1

for (const [label, trust] of [['unset (default uniquelocal)', undefined], ['1 hop', '1'], ['2 hops', '2'], ['3 hops', '3'], ['false', 'false'], ['off', 'off'], ['loopback', 'loopback'], ['loopback + CIDR list', 'loopback,198.51.100.0/24'], ['CIDR that does not include the peer', '10.0.0.0/8'], ['uniquelocal', 'uniquelocal'], ['true is never honoured as blanket trust', 'true']] as const) {
	test(`TRUST_PROXY ${label}: the shared rule equals Express req.ip`, async () => {
		const r = await ask(trust, XFF);
		assert.equal(norm(r.shared), norm(r.express), `express=${r.express} shared=${r.shared}`);
		const noHeader = await ask(trust, undefined);
		assert.equal(norm(noHeader.shared), norm(noHeader.express));
	});
}

test('what each setting means (hop counts count from the socket; false and an untrusted peer ignore the header)', async () => {
	assert.equal(norm((await ask('1', XFF)).shared), '10.1.2.3');
	assert.equal(norm((await ask('2', XFF)).shared), '198.51.100.4');
	assert.equal(norm((await ask('3', XFF)).shared), '203.0.113.9');
	assert.equal(norm((await ask('false', XFF)).shared), '127.0.0.1', 'false: the socket address, a header is never read');
	assert.equal(norm((await ask(undefined, XFF)).shared), '127.0.0.1', 'default uniquelocal: loopback is not a trusted proxy, so a forged header sent straight to the port is ignored');
	assert.equal(norm((await ask('loopback,198.51.100.0/24,10.0.0.0/8', XFF)).shared), '203.0.113.9');
});
test('the trust function: hop counts and false never throw (proxyaddr.compile alone does), lists and presets work', () => {
	assert.equal(trustFunction(1)('x', 0), true); assert.equal(trustFunction(1)('x', 1), false); assert.equal(trustFunction(2)('x', 1), true);
	assert.equal(trustFunction(false)('127.0.0.1', 0), false);
	assert.equal(trustFunction('loopback')('127.0.0.1', 0), true); assert.equal(trustFunction(['10.0.0.0/8'])('10.4.4.4', 0), true); assert.equal(trustFunction(['10.0.0.0/8'])('8.8.8.8', 0), false);
});
test('peer trusted for edge headers only through a trusted hop; the unset setting is described as the default, not as "no trust"', () => {
	const mk = (peer: string) => ({ headers: {}, socket: { remoteAddress: peer } }) as any;
	assert.equal(cameThroughTrustedProxy(mk('172.18.0.1'), {} as NodeJS.ProcessEnv), true);
	assert.equal(cameThroughTrustedProxy(mk('8.8.8.8'), {} as NodeJS.ProcessEnv), false);
	assert.equal(cameThroughTrustedProxy(mk('8.8.8.8'), { TRUST_PROXY: '1' } as NodeJS.ProcessEnv), true, 'with a hop count the nearest peer is the trusted proxy');
	assert.equal(cameThroughTrustedProxy(mk('8.8.8.8'), { TRUST_PROXY: 'false' } as NodeJS.ProcessEnv), false);
	assert.deepEqual(trustProxyDescription({} as NodeJS.ProcessEnv), { effective: 'uniquelocal', source: 'default' });
	assert.deepEqual(trustProxyDescription({ TRUST_PROXY: '2' } as NodeJS.ProcessEnv), { effective: '2', source: 'env' });
});
