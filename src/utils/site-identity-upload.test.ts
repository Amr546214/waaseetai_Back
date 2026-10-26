import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { identityDef, SITE_IDENTITY_REGISTRY } from '../config/site-identity.registry';
import { validateIdentityUpload, sniffKind, sha256Of, UploadRejected } from './site-identity-upload';
import { sanitizeSvg, SvgRejected } from './svg-sanitizer';

const FIX = path.join(__dirname, '..', 'testing', 'fixtures', 'site-identity');
const fx = (n: string) => fs.readFileSync(path.join(FIX, n));
const def = (k: string) => identityDef(k)!;

import { png, jpeg, webpLossless, ico, chunk } from '../testing/site-identity.pgenv';
const rejects = async (p: Promise<unknown>, reason: string | RegExp) => {
	await assert.rejects(p, (e: any) => { assert.ok(e instanceof UploadRejected || e instanceof SvgRejected, `unexpected ${e?.constructor?.name}: ${e?.message}`); assert.equal(e.statusCode >= 400 && e.statusCode < 500, true); assert.equal(e.code, 'SITE_IDENTITY_FILE_REJECTED'); assert.match(e.errors[0].message, /[؀-ۿ]/, 'Arabic message'); if (typeof reason === 'string') assert.equal(e.reason, reason); else assert.match(e.reason, reason); return true; });
};

// ---------------------------------------------------------------- the REAL current assets are accepted and unchanged
test('the real current default files satisfy the rules of their own key and are stored byte-for-byte (raster / ico are never re-encoded)', async () => {
	for (const [key, file] of [['logo.mark', 'waseet-mark.png'], ['logo.boot', 'waseet-mark.png'], ['logo.email', 'waseet-mark.png'], ['favicon.tab', 'waseet-mark.png'], ['favicon.ico', 'favicon.ico'], ['social.og', 'waseetai-og-v3.jpg']] as const) {
		const d = def(key); const buf = fx(file); const r = await validateIdentityUpload(d, buf);
		assert.equal(r.sha256, d.defaultFingerprint.sha256, `${key}: stored bytes == default bytes`); assert.equal(r.byteSize, d.defaultFingerprint.byteSize); assert.equal(r.mime, d.defaultFingerprint.mime);
		assert.equal(r.width, d.defaultFingerprint.width); assert.equal(r.height, d.defaultFingerprint.height); assert.ok(r.bytes.equals(buf));
	}
});

// ---------------------------------------------------------------- SVG: real icons and logos survive with the drawing intact
/** independent tag/attribute sequence of an SVG (no DOM library): the "meaning" of a drawing */
const tagSeq = (svg: string) => [...svg.replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').matchAll(/<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g)].map(m => {
	const attrs = [...m[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(a => [a[1], (a[2] ?? a[3]).replace(/\s+/g, ' ').trim()]).filter(a => !/^xmlns/.test(a[0])).sort((a, b) => a[0].localeCompare(b[0])).map(a => `${a[0]}=${a[1]}`);
	return `${m[1]}|${attrs.join(';')}`;
});
test('the REAL AI icon and the REAL full logo SVG pass with the drawing intact (sanitising is a no-op in meaning)', async () => {
	for (const f of ['i-ai.svg', 'waseetai.svg']) {
		const src = fx(f); const r = await sanitizeSvg(src);
		assert.equal(r.changed, false, `${f}: nothing removed`); assert.equal(r.removed, 0);
		assert.deepEqual(tagSeq(r.svg), tagSeq(src.toString('utf8')), `${f}: same elements, same attributes, same order`);
		assert.match(r.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/); assert.ok(!r.svg.includes('<?xml'));
	}
	const r = await validateIdentityUpload(def('icon.ai'), fx('i-ai.svg'));
	assert.equal(r.mime, 'image/svg+xml'); assert.equal(r.width, 24); assert.equal(r.height, 24); assert.equal(r.note, null);
	// the sanitised output is a fixed point: a second pass changes nothing
	assert.equal((await sanitizeSvg(r.bytes)).svg, r.bytes.toString('utf8'));
	// the AI mark inner geometry as the app draws it today (ai-icon.ts) survives as an upload too
	const inner = '<circle cx="12" cy="12" r="2"/><circle cx="4" cy="6" r="1.5"/><circle cx="20" cy="6" r="1.5"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="18" r="1.5"/><circle cx="12" cy="3" r="1.5"/><circle cx="12" cy="21" r="1.5"/><path d="M12 10V5M12 19v-5M10 12H5M19 12h-5M5.6 7.4l3.5 3.5M14.9 14.9l3.5 3.5M5.6 16.6l3.5-3.5M14.9 9.1l3.5-3.5"/>';
	assert.equal(sha256Of(Buffer.from(inner)), def('icon.ai').defaultFingerprint.sha256, 'the registry fingerprint is the sha256 of this exact markup');
	const sym = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`);
	const rs = await validateIdentityUpload(def('icon.ai'), sym); assert.equal(rs.sanitized.changed, false); assert.deepEqual(tagSeq(rs.bytes.toString()), tagSeq(sym.toString()));
});

const HOSTILE: Array<[string, string, (out: string) => void]> = [
	['script element', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><circle cx="12" cy="12" r="5"/></svg>', o => assert.ok(!/script|alert/i.test(o))],
	['script in CDATA / entity-encoded', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script><![CDATA[alert(1)]]></script><circle r="5" cx="1" cy="1"/></svg>', o => assert.ok(!/script|alert/i.test(o))],
	['onload / onclick / onerror handlers', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)"><circle cx="1" cy="1" r="5" onclick="alert(2)" onmouseover="x()"/><image href="#a" onerror="alert(3)"/></svg>', o => assert.ok(!/\son\w+\s*=|alert/i.test(o))],
	['foreignObject with HTML', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="javascript:alert(1)"></iframe></body></foreignObject><rect width="5" height="5"/></svg>', o => assert.ok(!/foreignobject|iframe|<body|javascript/i.test(o))],
	['javascript: href on a link and on use', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><a xlink:href="javascript:alert(1)"><rect width="5" height="5"/></a><use xlink:href="javascript:alert(2)"/></svg>', o => assert.ok(!/javascript|<a[\s>]|<use/i.test(o))],
	['external href and xlink:href', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><image href="https://evil.example/p.png" width="5" height="5"/><image xlink:href="//evil.example/q.png" width="5" height="5"/><use href="https://evil.example/s.svg#x"/><rect width="5" height="5"/></svg>', o => assert.ok(!/evil|https?:|\/\//i.test(o.replace('http://www.w3.org/2000/svg', '').replace('http://www.w3.org/1999/xlink', '')))],
	['nested use pointing at an external file', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><defs><g id="a"><use xlink:href="http://evil.example/x.svg#b"/></g></defs><use xlink:href="#a"/><use href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>', o => assert.ok(!/evil|data:/i.test(o))],
	['url(http...) in attributes and style attribute', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="5" height="5" fill="url(http://evil.example/p)" style="fill:url(https://evil.example/q);stroke:red"/><rect width="2" height="2" filter="url(//evil.example/f)"/></svg>', o => assert.ok(!/evil|url\(\s*['"]?\s*(?!#)/i.test(o))],
	['@import and external url in <style>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>@import url("http://evil.example/x.css"); rect{fill:red}</style><rect width="5" height="5"/></svg>', o => assert.ok(!/evil|@import|<style/i.test(o))],
	['CSS escape and expression tricks', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>rect{fill:u\\72l(http://evil.example/x)}</style><style>rect{width:expression(alert(1))}</style><rect width="5" height="5"/></svg>', o => assert.ok(!/evil|expression|<style/i.test(o))],
	['SMIL set / animate that rewrites href', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><a><set attributeName="href" to="javascript:alert(1)"/><rect width="5" height="5"/></a><animate attributeName="xlink:href" values="javascript:alert(1)"/></svg>', o => assert.ok(!/javascript|<set|<animate/i.test(o))],
	['xml:base and foreign namespaces', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://evil.example/ns" xml:base="http://evil.example/" viewBox="0 0 24 24"><x:foo/><rect width="5" height="5" x:bar="1"/></svg>', o => assert.ok(!/evil|x:foo|x:bar|xml:base/i.test(o.replace('http://www.w3.org', '')))],
	['comment and PI payloads', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><!-- <script>alert(1)</script> --><?xml-stylesheet href="http://evil.example/x.css"?><rect width="5" height="5"/></svg>', o => assert.ok(!/evil|script|<!--|<\?/i.test(o))],
	['inline raster data URI image is kept, an svg/html data URI is not', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><image href="data:image/png;base64,iVBORw0KGgo=" width="5" height="5"/><image href="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" width="5" height="5"/><image href="data:text/html;base64,PHNjcmlwdD4=" width="5" height="5"/></svg>', o => { assert.equal((o.match(/<image/g) ?? []).length, 1); assert.ok(o.includes('data:image/png;base64')); assert.ok(!/svg\+xml;base64|text\/html/.test(o)); }],
];
for (const [name, svg, check] of HOSTILE) {
	test(`hostile SVG: ${name} - removed, never stored, output is a stable fixed point`, async () => {
		const r = await sanitizeSvg(Buffer.from(svg));
		check(r.svg); assert.equal(r.changed, true, 'the sanitiser reports it changed the file'); assert.ok(r.removed > 0);
		assert.ok(/<svg\b/.test(r.svg) && /<\/svg>$/.test(r.svg));
		assert.equal((await sanitizeSvg(Buffer.from(r.svg))).svg, r.svg, 'fixed point');
		// through the full upload path the staged note records what was removed
		const up = await validateIdentityUpload(def('icon.ai'), Buffer.from(svg)); assert.equal(up.sanitized.changed, true); assert.match(up.note ?? '', /أُزيل \d+/); check(up.bytes.toString());
	});
}
const SVG_REJECTS: Array<[string, string, string]> = [
	['mXSS-style nesting (style/title/noscript tricks): the whole file is refused, not repaired', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style><img src=x onerror=alert(1)></style><title><img src=x onerror=alert(2)></title><noscript><p title="</noscript><img src=x onerror=alert(3)>"></noscript><rect width="5" height="5"/></svg>', 'NO_SVG_ROOT'],
	['entity bomb (billion laughs)', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>&b;</text></svg>', 'ENTITY_DECLARATION'],
	['external entity (XXE)', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>&x;</text></svg>', 'ENTITY_DECLARATION'],
	['doctype with an internal subset', '<!DOCTYPE svg [ ]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="5" height="5"/></svg>', 'DOCTYPE_SUBSET'],
	['custom entity reference without declaration', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>&evil;</text></svg>', 'ENTITY_REFERENCE'],
	['not utf-8', '', 'NOT_UTF8'],
	['no viewBox and no size', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>', 'NO_DIMENSIONS'],
	['non-square for the square key', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><rect width="5" height="5"/></svg>', 'WRONG_ASPECT'],
];
for (const [name, svg, reason] of SVG_REJECTS) {
	test(`SVG rejected: ${name}`, async () => {
		const buf = reason === 'NOT_UTF8' ? Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>'), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from('</title></svg>')]) : Buffer.from(svg);
		await rejects(validateIdentityUpload(def('icon.ai'), buf), reason);
	});
}
test('plain DOCTYPE without a subset is dropped (not rejected), the drawing stays', async () => {
	const r = await sanitizeSvg(Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="5" height="5"/></svg>'));
	assert.ok(!/DOCTYPE|w3\.org\/Graphics/.test(r.svg)); assert.match(r.svg, /<rect width="5" height="5"><\/rect>/);
});
test('an SVG whose only content is hostile is rejected as empty rather than stored hollow', async () => {
	await assert.rejects(sanitizeSvg(Buffer.from('<html><body><script>alert(1)</script></body></html>')), (e: any) => e instanceof SvgRejected);
	await rejects(validateIdentityUpload(def('icon.ai'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">')), /NO_DIMENSIONS|NO_SVG_ROOT|EMPTY_AFTER_CLEAN/);
});

// ---------------------------------------------------------------- not-an-image, polyglots, spoofing, truncation, size, dimensions
test('HTML / PHP / script / plain text renamed to .png is refused by its BYTES (the extension and Content-Type are never trusted)', async () => {
	for (const body of ['<!DOCTYPE html><html><body><script>alert(1)</script></body></html>', '<html><script>alert(1)</script></html>', '<?php system($_GET[0]); ?>', '<script>alert(1)</script>', 'hello, I am a text file']) {
		await rejects(validateIdentityUpload(def('logo.mark'), Buffer.from(body), 'image/png'), /UNSUPPORTED_TYPE|MARKUP_NOT_SVG/);
	}
	assert.equal(sniffKind(Buffer.from('<html></html>')), 'markup'); assert.equal(sniffKind(Buffer.from('plain')), null);
});
test('a declared image type that disagrees with the bytes is a spoof; a generic declaration is ignored (bytes decide)', async () => {
	await rejects(validateIdentityUpload(def('logo.mark'), png(200, 100), 'image/jpeg'), 'MIME_MISMATCH');
	await rejects(validateIdentityUpload(def('logo.mark'), fx('i-ai.svg'), 'image/png'), 'MIME_MISMATCH');
	assert.equal((await validateIdentityUpload(def('logo.mark'), png(200, 100), 'application/octet-stream')).mime, 'image/png');
	assert.equal((await validateIdentityUpload(def('logo.mark'), png(200, 100))).mime, 'image/png');
});
test('polyglots: markup or script appended / hidden inside a valid image is refused (trailing data after IEND/EOI, or markers inside chunks)', async () => {
	await rejects(validateIdentityUpload(def('logo.mark'), png(200, 100, { extra: Buffer.from('<script>alert(1)</script>') })), 'POLYGLOT');
	await rejects(validateIdentityUpload(def('logo.mark'), png(200, 100, { text: '<html><script>alert(1)</script></html>' })), 'POLYGLOT');
	await rejects(validateIdentityUpload(def('logo.mark'), png(200, 100, { extra: Buffer.from([1, 2, 3, 4]) })), 'TRAILING_DATA');
	await rejects(validateIdentityUpload(def('social.og'), jpeg(1200, 630, { extra: Buffer.from('<?php echo 1; ?>') })), 'POLYGLOT');
	await rejects(validateIdentityUpload(def('social.og'), jpeg(1200, 630, { extra: Buffer.from([9, 9, 9]) })), 'TRAILING_DATA');
	await rejects(validateIdentityUpload(def('logo.mark'), webpLossless(200, 100, { extra: Buffer.from([0, 0]) })), 'TRAILING_DATA');
	await rejects(validateIdentityUpload(def('favicon.ico'), ico(32, { extra: Buffer.from('<svg onload=alert(1)>') })), 'POLYGLOT');
	await rejects(validateIdentityUpload(def('logo.mark'), Buffer.concat([Buffer.from('GIF89a'), Buffer.from('<script>alert(1)</script>')])), 'UNSUPPORTED_TYPE');
	await rejects(validateIdentityUpload(def('logo.mark'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40)])), 'UNSUPPORTED_TYPE');
});
test('truncated / corrupt files are refused', async () => {
	const good = png(200, 100);
	await rejects(validateIdentityUpload(def('logo.mark'), good.subarray(0, good.length - 20)), 'TRUNCATED');
	await rejects(validateIdentityUpload(def('logo.mark'), good.subarray(0, 40)), 'TRUNCATED');
	await rejects(validateIdentityUpload(def('logo.mark'), png(200, 100, { noEnd: true })), 'TRUNCATED');
	const corrupt = Buffer.from(good); corrupt[40] ^= 0xff; await rejects(validateIdentityUpload(def('logo.mark'), corrupt), /PNG_CRC|PNG_CHUNK_TYPE|TRUNCATED/);
	const flipped = Buffer.from(good); flipped[52] ^= 0xff; await rejects(validateIdentityUpload(def('logo.mark'), flipped), /PNG_CRC|TRUNCATED/);
	const real = fx('waseet-mark.png'); await rejects(validateIdentityUpload(def('logo.mark'), real.subarray(0, real.length >> 1)), 'TRUNCATED');
	const j = jpeg(1200, 630); await rejects(validateIdentityUpload(def('social.og'), jpeg(1200, 630, { noEoi: true })), 'TRUNCATED'); await rejects(validateIdentityUpload(def('social.og'), j.subarray(0, 30)), 'TRUNCATED');
	await rejects(validateIdentityUpload(def('logo.mark'), webpLossless(200, 100, { cut: 3 })), 'TRUNCATED');
	await rejects(validateIdentityUpload(def('favicon.ico'), ico(32).subarray(0, 60)), 'TRUNCATED');
	await rejects(validateIdentityUpload(def('logo.mark'), Buffer.alloc(0)), 'EMPTY');
	const realOg = fx('waseetai-og-v3.jpg'); await rejects(validateIdentityUpload(def('social.og'), realOg.subarray(0, realOg.length - 5000)), 'TRUNCATED');
});
test('size limits: raster / ico over the key cap and svg over 64 KB are refused (413); atlas keys have their own 2 MB cap', async () => {
	const big = png(200, 100, { text: 'x'.repeat(600 * 1024) });
	await rejects(validateIdentityUpload(def('logo.mark'), big), 'TOO_BIG');
	const bigSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>${'a'.repeat(70 * 1024)}</title><rect width="5" height="5"/></svg>`);
	await assert.rejects(validateIdentityUpload(def('logo.mark'), bigSvg), (e: any) => e.statusCode === 413 && e.reason === 'TOO_BIG');
	assert.ok(def('character.bebo.classic.sprites').maxBytes > fx('waseet-mark.png').length);
});
test('real dimensions are read from the header and enforced: wrong size, wrong aspect, too small, too large, bombs', async () => {
	await rejects(validateIdentityUpload(def('social.og'), png(1200, 629)), 'WRONG_DIMENSIONS');
	await rejects(validateIdentityUpload(def('social.og'), png(630, 1200)), 'WRONG_DIMENSIONS');
	assert.equal((await validateIdentityUpload(def('social.og'), png(1200, 630))).width, 1200);
	assert.equal((await validateIdentityUpload(def('character.bebo.classic.sprites'), png(1774, 887))).height, 887);
	await rejects(validateIdentityUpload(def('character.bebo.classic.sprites'), png(1774, 888)), 'WRONG_DIMENSIONS');
	await rejects(validateIdentityUpload(def('logo.mark'), png(32, 16)), 'TOO_SMALL');
	await rejects(validateIdentityUpload(def('logo.mark'), png(100, 300)), 'WRONG_ASPECT');
	await rejects(validateIdentityUpload(def('logo.mark'), png(3000, 1500, { fakeW: 3000, fakeH: 1500 })), 'TOO_LARGE_DIMENSIONS');
	await rejects(validateIdentityUpload(def('logo.mark'), png(10, 10, { fakeW: 60000, fakeH: 60000 })), 'DIMENSIONS_TOO_LARGE');
	await rejects(validateIdentityUpload(def('logo.mark'), png(10, 10, { fakeW: 0x7fffffff, fakeH: 0x7fffffff })), 'DIMENSIONS_TOO_LARGE');
	await rejects(validateIdentityUpload(def('logo.mark'), webpLossless(16000, 16000)), 'DIMENSIONS_TOO_LARGE');
	await rejects(validateIdentityUpload(def('logo.mark'), jpeg(20000, 20000)), 'FORMAT_NOT_ALLOWED');
	await rejects(validateIdentityUpload(def('social.og'), jpeg(20000, 20000)), 'DIMENSIONS_TOO_LARGE');
	assert.equal((await validateIdentityUpload(def('logo.mark'), webpLossless(300, 200))).height, 200);
	// icon.ai must be square even though an SVG has no pixel size
	await rejects(validateIdentityUpload(def('icon.ai'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><rect width="5" height="5"/></svg>')), 'WRONG_ASPECT');
});
test('formats are per key: GIF / animated images / wrong family are refused with the allowed list', async () => {
	await rejects(validateIdentityUpload(def('logo.email'), fx('i-ai.svg')), 'FORMAT_NOT_ALLOWED');
	await rejects(validateIdentityUpload(def('logo.email'), webpLossless(200, 100)), 'FORMAT_NOT_ALLOWED');
	await rejects(validateIdentityUpload(def('favicon.ico'), png(32, 32)), 'FORMAT_NOT_ALLOWED');
	await rejects(validateIdentityUpload(def('icon.ai'), png(24, 24)), 'FORMAT_NOT_ALLOWED');
	await rejects(validateIdentityUpload(def('logo.mark'), Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1')), 'UNSUPPORTED_TYPE');
	await rejects(validateIdentityUpload(def('logo.mark'), webpLossless(200, 100, { animated: true })), 'ANIMATED');
	const apng = png(200, 100); const withAct = Buffer.concat([apng.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), apng.subarray(33)]); await rejects(validateIdentityUpload(def('logo.mark'), withAct), 'ANIMATED');
	const e = await validateIdentityUpload(def('favicon.ico'), ico(32)); assert.equal(e.mime, 'image/x-icon'); assert.equal(e.width, 32);
	await rejects(validateIdentityUpload(def('favicon.ico'), ico(32, { entries: 1 }).subarray(0, 6)), /TRUNCATED|UNSUPPORTED_TYPE/);
});
test('registry: every key has a real fingerprint, a stable shape and constraints its own default satisfies', () => {
	assert.ok(SITE_IDENTITY_REGISTRY.length >= 20);
	for (const d of SITE_IDENTITY_REGISTRY) {
		assert.match(d.defaultFingerprint.sha256, /^[0-9a-f]{64}$/, d.key); assert.ok(d.allowedMimes.includes(d.defaultFingerprint.mime) || d.defaultAsset.type === 'inline-symbol', `${d.key}: default mime is allowed for the key`);
		if (d.defaultAsset.type === 'file' && d.defaultFingerprint.mime !== 'image/svg+xml') { assert.ok(d.defaultFingerprint.byteSize <= d.maxBytes, `${d.key}: default size within cap`); }
	}
});

test('realistic exporter files (Illustrator with <style> classes + gradient + use, Inkscape with metadata / sodipodi / inkscape namespaces) keep their drawing; only the editor-only parts are removed', async () => {
	const ill = `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 25.0.0 -->\n<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 100 100" xml:space="preserve">\n<style type="text/css">\n\t.st0{fill:#2BD4C7;}\n\t.st1{fill:url(#SVGID_1_);}\n</style>\n<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"><stop offset="0" style="stop-color:#00FF00"/><stop offset="1" style="stop-color:#0000FF"/></linearGradient>\n<path class="st0" d="M10,10h80v80H10z"/><rect class="st1" x="20" y="20" width="10" height="10"/>\n<g><use xlink:href="#SVGID_1_"/></g>\n</svg>`;
	const a = await sanitizeSvg(Buffer.from(ill)); assert.equal(a.changed, false); assert.deepEqual(tagSeq(a.svg), tagSeq(ill)); assert.match(a.svg, /<style type="text\/css">[\s\S]*\.st1\{fill:url\(#SVGID_1_\);\}/); assert.match(a.svg, /<use xlink:href="#SVGID_1_">/);
	const ink = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="48" height="48" viewBox="0 0 48 48" id="svg8" inkscape:version="1.0" sodipodi:docname="x.svg"><metadata id="m"><rdf:RDF><dc:format>image/svg+xml</dc:format></rdf:RDF></metadata><sodipodi:namedview id="base" pagecolor="#ffffff"/><g inkscape:label="Layer 1" id="layer1"><circle style="fill:#ff0000;stroke:none" cx="24" cy="24" r="10" id="c1"/></g></svg>`;
	const b = await sanitizeSvg(Buffer.from(ink)); assert.equal(b.changed, true); assert.ok(!/inkscape|sodipodi|rdf|metadata|purl/i.test(b.svg)); assert.match(b.svg, /<circle style="fill:#ff0000;stroke:none" cx="24" cy="24" r="10" id="c1"><\/circle>/);
	const up = await validateIdentityUpload(def('icon.ai'), Buffer.from(ink)); assert.equal(up.width, 48); assert.match(up.note ?? '', /أُزيل/);
});
