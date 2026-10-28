import { test, beforeEach, afterEach, mock } from 'node:test';
import { logger } from '../config/logger';
import assert from 'node:assert/strict';
import { siteIdentityCacheTestKit } from '../services/site-identity-cache';
import { renderEmailShell } from './email-shell';
import { emailPublicApiUrl, resetEmailAssetHostWarning } from './site-url';

/**
 * logo.email URL matrix (round 5): <emailAssetBaseUrl()>/api/public/site-identity/assets/logo.email/<sha256> for a custom logo; the long-standing <assetBase>/images/waseet-mark.png otherwise.
 * EMAIL_ASSET_BASE_URL on a DIFFERENT host than the site is used for the custom logo only when EMAIL_ASSET_SERVES_API says it proxies /api (a static CDN cannot serve the public asset route).
 */
const SHA = 'a'.repeat(64);
const saved = { f: process.env.FRONTEND_URL, a: process.env.EMAIL_ASSET_BASE_URL, s: process.env.EMAIL_ASSET_SERVES_API };
const kit = siteIdentityCacheTestKit;
const env = (front: string | null, asset: string | null, serves?: string) => {
	if (front) process.env.FRONTEND_URL = front; else delete process.env.FRONTEND_URL;
	if (asset) process.env.EMAIL_ASSET_BASE_URL = asset; else delete process.env.EMAIL_ASSET_BASE_URL;
	if (serves) process.env.EMAIL_ASSET_SERVES_API = serves; else delete process.env.EMAIL_ASSET_SERVES_API;
};
const imgSrc = (custom: boolean): string | null => { kit.reset(); kit.setWired(() => true); kit.set(custom ? SHA : null); const m = renderEmailShell({ docTitle: 't', bodyHtml: '<p>x</p>' }).match(/<img src="([^"]*)"/); return m ? m[1] : null; };
const html = (custom: boolean) => { kit.reset(); kit.setWired(() => true); kit.set(custom ? SHA : null); return renderEmailShell({ docTitle: 't', bodyHtml: '<p>x</p>' }); };

beforeEach(() => { resetEmailAssetHostWarning(); });
afterEach(() => { kit.reset(); for (const [k, v] of [['FRONTEND_URL', saved.f], ['EMAIL_ASSET_BASE_URL', saved.a], ['EMAIL_ASSET_SERVES_API', saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const PUB = `/api/public/site-identity/assets/logo.email/${SHA}`;
const DEF = '/images/waseet-mark.png';

test('email logo matrix: front only (no asset base) - default and custom', () => {
	env('https://front.test', null);
	assert.equal(imgSrc(false), `https://front.test${DEF}`);
	assert.equal(imgSrc(true), `https://front.test${PUB}`);
});

test('email logo matrix: asset base on the SAME origin as the site honours EMAIL_ASSET_BASE_URL', () => {
	env('https://front.test', 'https://front.test/');
	assert.equal(imgSrc(false), `https://front.test${DEF}`);
	assert.equal(imgSrc(true), `https://front.test${PUB}`);
});

test('email logo matrix: asset base on a DIFFERENT host - default uses it; custom falls back to the default image there (the CDN cannot serve /api) unless EMAIL_ASSET_SERVES_API=true', () => {
	env('https://front.test', 'https://cdn.test/');
	assert.equal(imgSrc(false), `https://cdn.test${DEF}`);
	assert.equal(imgSrc(true), `https://cdn.test${DEF}`, 'safe fallback to the default, same markup as the default state');
	assert.equal(html(true), html(false), 'fallback is byte-identical to the default rendering');
	for (const on of ['true', '1', 'yes', 'TRUE']) { env('https://front.test', 'https://cdn.test/', on); assert.equal(imgSrc(true), `https://cdn.test${PUB}`, `serves=${on}`); assert.equal(imgSrc(false), `https://cdn.test${DEF}`); }
	for (const off of ['false', '0', '', 'no']) { env('https://front.test', 'https://cdn.test/', off); assert.equal(imgSrc(true), `https://cdn.test${DEF}`, `serves=${off}`); }
});

test('email logo matrix: no FRONTEND_URL - asset base only (default, custom without/with opt-in) and nothing at all', () => {
	env(null, 'https://cdn.test');
	assert.equal(imgSrc(false), `https://cdn.test${DEF}`);
	assert.equal(imgSrc(true), `https://cdn.test${DEF}`);
	env(null, 'https://cdn.test', 'true'); assert.equal(imgSrc(true), `https://cdn.test${PUB}`);
	env(null, null);
	assert.equal(imgSrc(false), null, 'no host configured: no image at all, never a host-less URL');
	assert.equal(imgSrc(true), null);
	env(null, 'not a url'); assert.equal(imgSrc(true), null);
});

test('email logo: a custom logo that is not wired, or an unsafe path, never produces a URL', () => {
	env('https://front.test', null); kit.reset(); kit.set(SHA); kit.setWired(() => false);
	assert.ok(renderEmailShell({ docTitle: 't', bodyHtml: '' }).includes(`https://front.test${DEF}`));
	assert.equal(emailPublicApiUrl('/public/x y'), null); assert.equal(emailPublicApiUrl('/public/a\\b'), null);
	assert.equal(emailPublicApiUrl('/public/ok'), 'https://front.test/api/public/ok');
});

test('email logo: the fallback warning is logged once, not per mail', () => {
	env('https://front.test', 'https://cdn.test');
	const warn = mock.method(logger, 'warn', () => logger);
	try { for (let i = 0; i < 5; i++) assert.equal(emailPublicApiUrl('/public/x'), null); assert.equal(warn.mock.callCount(), 1); assert.match(String(warn.mock.calls[0].arguments[0]), /EMAIL_ASSET_SERVES_API/); } finally { warn.mock.restore(); }
});
