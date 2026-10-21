import test from 'node:test';
import assert from 'node:assert/strict';
import { siteBaseUrl, siteUrl, emailAssetBaseUrl, resetSiteUrlWarning } from './site-url';

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
	const prev: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
	try { fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
};

test('a valid FRONTEND_URL gives absolute links (trailing slash and path ignored, origin only)', () => {
	withEnv({ FRONTEND_URL: 'https://dev.waseetai.com/' }, () => {
		assert.equal(siteBaseUrl(), 'https://dev.waseetai.com');
		assert.equal(siteUrl('/provider-overview/explore-requests/1/apply'), 'https://dev.waseetai.com/provider-overview/explore-requests/1/apply');
		assert.equal(siteUrl('support/help-center'), 'https://dev.waseetai.com/support/help-center');
		assert.equal(siteUrl('/a?b=1#c'), 'https://dev.waseetai.com/a?b=1#c');
	});
});

test('no host-less link is ever produced: missing / invalid FRONTEND_URL -> null (and a single warning)', () => {
	for (const v of [undefined, '', '   ', 'dev.waseetai.com', '/relative', 'ftp://x.test', 'javascript:alert(1)', 'https://']) {
		withEnv({ FRONTEND_URL: v }, () => {
			resetSiteUrlWarning();
			assert.equal(siteBaseUrl(), null, String(v));
			assert.equal(siteUrl('/x'), null, String(v));
		});
	}
});

test('only plain app paths become links: absolute URLs, //host, other schemes, backslashes and whitespace are refused', () => {
	withEnv({ FRONTEND_URL: 'https://dev.waseetai.com' }, () => {
		for (const p of ['https://evil.test/x', '//evil.test/x', 'javascript:alert(1)', 'mailto:a@b.c', '/a\\b', '/a b', '/a\nb', '', '   ', null, undefined]) assert.equal(siteUrl(p as any), null, String(p));
	});
});

test('the image host is independent of the link host', () => {
	withEnv({ FRONTEND_URL: 'https://dev.waseetai.com', EMAIL_ASSET_BASE_URL: 'https://cdn.test' }, () => {
		assert.equal(emailAssetBaseUrl(), 'https://cdn.test');
		assert.equal(siteBaseUrl(), 'https://dev.waseetai.com');
	});
	withEnv({ FRONTEND_URL: 'https://dev.waseetai.com', EMAIL_ASSET_BASE_URL: undefined }, () => assert.equal(emailAssetBaseUrl(), 'https://dev.waseetai.com'));
	withEnv({ FRONTEND_URL: undefined, EMAIL_ASSET_BASE_URL: 'not a url' }, () => assert.equal(emailAssetBaseUrl(), null));
});
