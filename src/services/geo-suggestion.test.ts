import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { geoSuggestion, isPublicIp, clearGeoCache } from './geo-suggestion.service';
import { trustedClientIp, cameThroughTrustedProxy } from '../utils/client-ip';
import { geoSourceStatus } from './geo-suggestion.service';

beforeEach(clearGeoCache);
const E = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const resp = (j: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => j })) as unknown as typeof fetch;

test('private, loopback and malformed addresses are never looked up', async () => {
	for (const ip of ['', '10.0.0.4', '127.0.0.1', '192.168.1.9', '172.20.1.1', '::1', 'fd00::1', 'nonsense']) { assert.equal(isPublicIp(ip), false, ip); assert.equal((await geoSuggestion(ip, {}, E({ GEOIP_PROVIDER: 'ipinfo', GEOIP_TOKEN: 't' }), resp({ country: 'SA' }))).source, 'none'); }
});
test('nothing configured => none (manual fields keep working); CDN headers count ONLY when explicitly trusted', async () => {
	const h = { 'cf-ipcountry': 'EG', 'cf-ipcity': 'Cairo' };
	assert.equal((await geoSuggestion('8.8.8.8', h, E({}), resp({}))).source, 'none');
	assert.equal((await geoSuggestion('8.8.8.8', h, E({ GEOIP_TRUST_CDN_HEADERS: 'cloudflare' }), resp({}))).source, 'none', 'a request that did not come through a trusted proxy hop cannot vouch for CDN headers');
	assert.deepEqual(await geoSuggestion('8.8.8.8', h, E({ GEOIP_TRUST_CDN_HEADERS: 'cloudflare' }), resp({}), true), { countryCode: 'EG', city: 'Cairo', timezone: null, source: 'cdn-header', approximate: true });
	assert.equal((await geoSuggestion('8.8.8.8', { 'cf-ipcountry': 'XX' }, E({ GEOIP_TRUST_CDN_HEADERS: 'cloudflare' }), resp({}), true)).source, 'none');
});
test('provider: country + city + a valid zone, cached; a failing or slow provider degrades to none without throwing', async () => {
	let n = 0; const f = (async () => { n++; return { ok: true, status: 200, json: async () => ({ country: 'sa', city: 'Riyadh', timezone: 'Asia/Riyadh' }) }; }) as unknown as typeof fetch;
	const env = E({ GEOIP_PROVIDER: 'ipinfo', GEOIP_TOKEN: 'secret' });
	const a = await geoSuggestion('8.8.4.4', {}, env, f), b = await geoSuggestion('8.8.4.4', {}, env, f);
	assert.deepEqual(a, { countryCode: 'SA', city: 'Riyadh', timezone: 'Asia/Riyadh', source: 'geoip-provider', approximate: true }); assert.deepEqual(b, a); assert.equal(n, 1);
	assert.equal((await geoSuggestion('1.1.1.1', {}, env, resp({}, false))).source, 'none');
	assert.equal((await geoSuggestion('1.0.0.1', {}, env, (async () => { throw new Error('timeout'); }) as unknown as typeof fetch)).source, 'none');
	assert.equal((await geoSuggestion('9.9.9.9', {}, env, resp({ country: 'zzz', timezone: 'Not/AZone' }))).source, 'none');
	assert.equal((await geoSuggestion('9.9.9.10', {}, env, resp({ country: 'TR', timezone: 'Not/AZone' }))).timezone, null, 'an invalid zone is dropped, never guessed');
});
test('socket address: X-Forwarded-For is believed only behind a trusted proxy hop (forged header from a public peer is ignored)', () => {
	const mk = (peer: string, xff?: string) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: peer } }) as any;
	assert.equal(trustedClientIp(mk('172.18.0.1', '203.0.113.9'), E({})), '203.0.113.9');
	assert.equal(trustedClientIp(mk('198.51.100.7', '6.6.6.6'), E({})), '198.51.100.7');
	assert.equal(trustedClientIp(mk('::ffff:198.51.100.8'), E({})), '198.51.100.8');
});

test('HTTP and Socket.IO use the same address rule; the peer must be a trusted hop for edge headers; source status names what is missing', () => {
	const mk = (peer: string, xff?: string) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: peer } }) as any;
	assert.equal(cameThroughTrustedProxy(mk('172.18.0.1'), E({})), true);
	assert.equal(cameThroughTrustedProxy(mk('198.51.100.7'), E({})), false);
	assert.equal(cameThroughTrustedProxy(mk('198.51.100.7'), E({ TRUST_PROXY: '198.51.100.7' })), true);
	assert.equal(trustedClientIp(mk('198.51.100.7', '6.6.6.6'), E({ TRUST_PROXY: 'loopback' })), '198.51.100.7', 'a forged header from an untrusted peer never becomes the client address');
	assert.equal(geoSourceStatus(E({})).configured, false);
	assert.ok(geoSourceStatus(E({})).missing.length >= 1);
	assert.equal(geoSourceStatus(E({ GEOIP_PROVIDER: 'ipinfo', GEOIP_TOKEN: 'x' })).source, 'geoip-provider');
	assert.equal(JSON.stringify(geoSourceStatus(E({ GEOIP_PROVIDER: 'ipinfo', GEOIP_TOKEN: 'sekret' }))).includes('sekret'), false);
});
