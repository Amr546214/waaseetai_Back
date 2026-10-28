import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_COUNTS, TOKEN_KEYS, TOKEN_REGISTRY, tokenDefault, tokensOfKey } from '../config/site-identity-tokens';
import { SITE_IDENTITY_REGISTRY, WIRED_KEYS, identityDef, describeRules } from '../config/site-identity.registry';
import { TOKEN_MAX_BYTES, TokenRejected, buildTokensCss, LIGHT_SELECTOR, canonValue, validateTokenBytes, validateTokenUpload, validateTokenValue } from './site-identity-tokens';
import { validateIdentityUpload } from './site-identity-upload';

const reasonOf = (fn: () => unknown): string => { try { fn(); } catch (e) { assert.ok(e instanceof TokenRejected, `expected TokenRejected, got ${String(e)}`); return (e as TokenRejected).reason; } return 'ACCEPTED'; };
const val = (key: string, v: unknown) => validateTokenValue(key, v);
const bytes = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8');

test('tokens: registry shape and exact counts (37 declared in :root + the new --font-family, 34 colour-like of which 33 redefined in light (styles.css + design system) and only --grad shared, 3 layout, 1 typography)', () => {
	assert.deepEqual(TOKEN_COUNTS, { declaredInRoot: 37, colorLike: 34, redefinedByThemeLight: 33, sharedWithDark: 1, layout: 3, typography: 1 });
	assert.deepEqual(TOKEN_REGISTRY.filter(t => t.scope === 'color' && t.light === undefined).map(t => t.name).sort(), ['--grad']);
	assert.equal(new Set(TOKEN_REGISTRY.map(t => t.name)).size, TOKEN_REGISTRY.length, 'names unique');
	for (const t of TOKEN_REGISTRY) assert.match(t.name, /^--[a-z0-9-]{1,40}$/);
	// registry keys: group token, kind json, 4 keys, all four wired
	const keys = SITE_IDENTITY_REGISTRY.filter(d => d.group === 'token');
	assert.deepEqual(keys.map(d => d.key), [...TOKEN_KEYS]);
	for (const d of keys) { assert.equal(d.kind, 'json'); assert.deepEqual(d.allowedMimes, ['application/json']); assert.equal(d.maxBytes, TOKEN_MAX_BYTES); assert.equal(d.defaultFingerprint.byteSize, 2); assert.equal(d.defaultFingerprint.mime, 'application/json'); assert.ok(describeRules(d).length >= 2); }
	assert.deepEqual(keys.filter(d => WIRED_KEYS.includes(d.key)).map(d => d.key), ['tokens.colors.light', 'tokens.colors.dark', 'tokens.layout', 'tokens.typography']);
	assert.ok(keys.every(d => d.notWiredReason.length > 20));
	assert.equal(tokensOfKey('tokens.colors.light').length, 34); assert.equal(tokensOfKey('tokens.colors.dark').length, 34); assert.equal(tokensOfKey('tokens.layout').length, 3); assert.equal(tokensOfKey('tokens.typography').length, 1);
});

test('tokens: every default is already in canonical form and satisfies its own grammar (so a default can never be "changed" by canonicalisation)', () => {
	for (const t of TOKEN_REGISTRY) for (const v of [t.dark, t.light]) if (v !== undefined) assert.equal(canonValue(t, v), v, `${t.name}: ${v}`);
});

/** the SOURCE of the defaults is the EFFECTIVE computed value of the production build (FE golden: styles.css + waseet-design-system.css, default state, per theme). Skipped (never passed) when unreachable. */
const GOLDEN = [process.env.SITE_IDENTITY_FE_GOLDEN, path.resolve(__dirname, '../../../wt-fe-id/src/app/core/identity/identity-tokens.effective.golden.json'), path.resolve(__dirname, '../../../sc-fe-team/src/app/core/identity/identity-tokens.effective.golden.json')].filter(Boolean) as string[];
const goldenPath = GOLDEN.find(p => fs.existsSync(p));
const norm = (v: string) => v.toLowerCase().replace(/\s+/g, '').replace(/(\.\d*?)0+(?![\d])/g, '$1').replace(/^"tajawal"$/, "'tajawal'");
test('tokens: EVERY default (dark and light) equals the effective computed value of the production build', { skip: goldenPath ? false : 'FE effective golden is not reachable (set SITE_IDENTITY_FE_GOLDEN)' }, () => {
	const g = JSON.parse(fs.readFileSync(goldenPath!, 'utf8')) as { dark: Record<string, string>; light: Record<string, string> };
	assert.equal(Object.keys(g.dark).length, TOKEN_REGISTRY.length); assert.equal(Object.keys(g.light).length, TOKEN_REGISTRY.length);
	for (const t of TOKEN_REGISTRY) {
		assert.equal(norm(g.dark[t.name] ?? '<missing>'), norm(t.dark), `${t.name} dark`);
		if (t.scope === 'color') assert.equal(norm(g.light[t.name] ?? '<missing>'), norm(t.light ?? t.dark), `${t.name} light`);
	}
});

test('tokens: accepted values are canonicalised (case, spaces, alpha) and entries equal to the default are dropped', () => {
	const r = val('tokens.colors.dark', { '--teal': '#14B8A6', '--pg': 'RGBA( 11 , 16 , 32 , 0.50 )', '--txt': '#FFF000', '--grad': 'linear-gradient( 90deg , #fff 0% , rgba(1,2,3,.5) 100% )', '--card-shadow': '0 4px 12px rgba(0, 0, 0, 0.25), 0 1px 2px #000', '--header-bg': 'hsla(220, 40%, 10%, 0.7)' });
	assert.deepEqual(r.value, { '--pg': 'rgba(11,16,32,.5)', '--teal': '#14b8a6', '--txt': '#fff000', '--grad': 'linear-gradient(90deg,#fff 0%,rgba(1,2,3,.5) 100%)', '--header-bg': 'hsla(220,40%,10%,.7)', '--card-shadow': '0 4px 12px rgba(0,0,0,.25),0 1px 2px #000' });
	// key order = registry order, JSON compact
	assert.equal(r.canonicalJson, JSON.stringify(r.value)); assert.deepEqual(Object.keys(r.value), ['--pg', '--card-shadow', '--txt', '--teal', '--grad', '--header-bg']);
	const d = val('tokens.colors.dark', { '--teal': '#2BD4C7', '--pg': '#070D24', '--red': '#000' });
	assert.deepEqual(d.value, { '--red': '#000' }); assert.deepEqual(d.dropped.sort(), ['--pg', '--teal']);
	assert.deepEqual(val('tokens.layout', { '--container': '1100px', '--radius': '1rem', '--radius-sm': '10px' }).value, { '--container': '1100px', '--radius': '1rem' });
	assert.deepEqual(val('tokens.typography', { '--font-family': 'Cairo, "IBM Plex Sans Arabic", sans-serif' }).value, { '--font-family': "'Cairo','IBM Plex Sans Arabic',sans-serif" });
	assert.deepEqual(val('tokens.typography', { '--font-family': "'خط عربي',serif" }).value, { '--font-family': "'خط عربي',serif" });
	// a light-theme "default" of a shared name (--grad) is the DARK default; --teal has its own light value
	assert.equal(tokenDefault('tokens.colors.light', TOKEN_REGISTRY.find(t => t.name === '--grad')!), 'linear-gradient(135deg,#2bd4c7,#2b7fff)');
	assert.equal(tokenDefault('tokens.colors.light', TOKEN_REGISTRY.find(t => t.name === '--teal')!), '#0f8a7f');
	assert.equal(reasonOf(() => val('tokens.colors.light', { '--teal': '#0F8A7F' })), 'EMPTY_OVERRIDES');
	assert.equal(val('tokens.colors.light', { '--teal': '#14b8a6' }).value['--teal'], '#14b8a6');
});

test('tokens: attacks are rejected (url(), expression(), var() injection, ;, braces, comments, @import, backslash, tags, !important, newlines, oversize, hostile names)', () => {
	const bad: Array<[string, string, string]> = [
		['url()', 'url(https://evil.example/x.png)', 'FORBIDDEN_SYNTAX'], ['url() in gradient', 'linear-gradient(90deg,url(//x),#fff)', 'FORBIDDEN_SYNTAX'], ['expression()', 'expression(alert(1))', 'FORBIDDEN_SYNTAX'],
		['var() injection', 'var(--txt)', 'FORBIDDEN_SYNTAX'], ['var() with fallback', 'var(--x,red)', 'FORBIDDEN_SYNTAX'], ['semicolon break-out', '#fff;background:url(x)', 'FORBIDDEN_SYNTAX'],
		['close brace break-out', '#fff}body{display:none', 'FORBIDDEN_SYNTAX'], ['open brace', '#fff{', 'FORBIDDEN_SYNTAX'], ['css comment', '#fff/*x*/', 'FORBIDDEN_SYNTAX'], ['line comment', '#fff//x', 'FORBIDDEN_SYNTAX'],
		['@import', '@import url(x)', 'FORBIDDEN_SYNTAX'], ['@ rule', '#fff @media', 'FORBIDDEN_SYNTAX'], ['backslash escape', '\\75rl(x)', 'FORBIDDEN_SYNTAX'], ['style close tag', '#fff</style><script>alert(1)</script>', 'FORBIDDEN_SYNTAX'],
		['!important', '#fff !important', 'FORBIDDEN_SYNTAX'], ['newline', '#fff\nbackground:red', 'FORBIDDEN_SYNTAX'], ['carriage return', '#fff\rx', 'FORBIDDEN_SYNTAX'], ['NUL', '#fff\u0000', 'FORBIDDEN_SYNTAX'],
		['calc()', 'calc(1px+2px)', 'FORBIDDEN_SYNTAX'], ['env()', 'env(safe-area-inset-top)', 'FORBIDDEN_SYNTAX'], ['attr()', 'attr(x)', 'FORBIDDEN_SYNTAX'],
		['named colour', 'red', 'BAD_VALUE'], ['css-wide keyword', 'inherit', 'BAD_VALUE'], ['bad hex', '#ggg', 'BAD_VALUE'], ['hex 5 digits', '#12345', 'BAD_VALUE'], ['rgb out of range', 'rgb(300,0,0)', 'OUT_OF_RANGE'],
		['alpha > 1', 'rgba(0,0,0,1.5)', 'OUT_OF_RANGE'], ['space syntax', 'rgb(0 0 0)', 'BAD_VALUE'], ['empty', '', 'BAD_VALUE'], ['too long', '#' + 'a'.repeat(300), 'VALUE_TOO_LONG'], ['rgb unclosed', 'rgb(0,0,0', 'BAD_VALUE'],
	];
	for (const [label, v, reason] of bad) assert.equal(reasonOf(() => val('tokens.colors.dark', { '--teal': v })), reason, `${label}: ${JSON.stringify(v).slice(0, 40)}`);
	for (const [label, v] of [['url', 'url(x)'], ['two stops needed', 'linear-gradient(90deg,#fff)'], ['6 stops', 'linear-gradient(90deg,#111,#222,#333,#444,#555,#666)'], ['radial', 'radial-gradient(#fff,#000)'], ['angle', 'linear-gradient(to right,#fff,#000)'], ['pct > 100', 'linear-gradient(90deg,#fff 120%,#000)']] as const) assert.notEqual(reasonOf(() => val('tokens.colors.dark', { '--grad': v })), 'ACCEPTED', `paint ${label}`);
	for (const [label, v] of [['url in shadow', '0 0 1px url(x)'], ['inset', 'inset 0 0 1px #000'], ['unitless', '1 2 3 #000'], ['4 layers', '0 0 1px #000,0 0 1px #000,0 0 1px #000,0 0 1px #000'], ['huge', '0 0 999px #000'], ['negative blur', '0 0 -2px #000'], ['no colour', '0 2px 3px'], ['semicolon', '0 0 1px #000;x']] as const) assert.notEqual(reasonOf(() => val('tokens.colors.dark', { '--card-shadow': v })), 'ACCEPTED', `shadow ${label}`);
	for (const [label, v] of [['em', '1em'], ['vw', '90vw'], ['percent', '50%'], ['var', 'var(--x)'], ['calc', 'calc(1px)'], ['too big', '9999px'], ['too small container', '100px'], ['negative', '-4px'], ['no unit', '16']] as const) assert.notEqual(reasonOf(() => val('tokens.layout', { '--container': v })), 'ACCEPTED', `length ${label}`);
	assert.equal(reasonOf(() => val('tokens.layout', { '--radius': '65px' })), 'OUT_OF_RANGE');
	for (const [label, v] of [['url', "url(x),sans-serif"], ['inherit', 'inherit,sans-serif'], ['7 entries', 'a,b,c,d,e,f,serif'], ['brace', "'a{',serif"], ['semicolon', "Cairo;color:red,serif"], ['quote break', "'a\\'b',serif"], ['digit first', "'9x',serif"], ['empty entry', "a,,serif"], ['long name', `'${'x'.repeat(41)}',serif`]] as const) assert.notEqual(reasonOf(() => val('tokens.typography', { '--font-family': v })), 'ACCEPTED', `font ${label}`);
	// names / structure
	assert.equal(reasonOf(() => val('tokens.colors.dark', { '--nope': '#fff' })), 'UNKNOWN_TOKEN');
	assert.equal(reasonOf(() => val('tokens.colors.dark', { '--radius': '10px' })), 'UNKNOWN_TOKEN', 'a layout token is not valid in a colour set');
	assert.equal(reasonOf(() => val('tokens.layout', { '--teal': '#fff' })), 'UNKNOWN_TOKEN');
	assert.equal(reasonOf(() => val('tokens.colors.dark', { 'color': '#fff' })), 'BAD_NAME');
	assert.equal(reasonOf(() => val('tokens.colors.dark', { '--TEAL': '#fff' })), 'BAD_NAME');
	assert.equal(reasonOf(() => val('tokens.colors.dark', { '--teal;x': '#fff' })), 'BAD_NAME');
	assert.equal(reasonOf(() => val('tokens.colors.dark', { '--teal:#fff;--x': '#fff' })), 'BAD_NAME');
	assert.equal(reasonOf(() => val('tokens.colors.dark', JSON.parse('{"__proto__":"#fff"}'))), 'BAD_NAME');
	assert.equal(reasonOf(() => val('tokens.colors.dark', { '--teal': 5 })), 'NOT_STRING');
	assert.equal(reasonOf(() => val('tokens.colors.dark', { '--teal': { a: 1 } })), 'NOT_STRING');
	assert.equal(reasonOf(() => val('tokens.colors.dark', { '--teal': ['#fff'] })), 'NOT_STRING');
	assert.equal(reasonOf(() => val('tokens.colors.dark', [])), 'NOT_OBJECT'); assert.equal(reasonOf(() => val('tokens.colors.dark', null)), 'NOT_OBJECT'); assert.equal(reasonOf(() => val('tokens.colors.dark', 'x')), 'NOT_OBJECT');
	assert.equal(reasonOf(() => val('tokens.colors.dark', {})), 'EMPTY_OVERRIDES');
	assert.equal(reasonOf(() => val('logo.mark', { '--teal': '#fff' })), 'UNKNOWN_TOKEN', 'not a token key');
	// bytes level
	assert.equal(reasonOf(() => validateTokenBytes('tokens.colors.dark', bytes('{not json'))), 'NOT_JSON');
	assert.equal(reasonOf(() => validateTokenBytes('tokens.colors.dark', Buffer.from([0xff, 0xfe, 0x7b, 0x7d]))), 'NOT_UTF8');
	assert.equal(reasonOf(() => validateTokenBytes('tokens.colors.dark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes({ '--teal': '#fff' })]))), 'NOT_JSON');
	assert.equal(reasonOf(() => validateTokenBytes('tokens.colors.dark', bytes('{"--teal":"#111","--teal":"#222"}'))), 'BAD_NAME', 'duplicate names');
	assert.equal(reasonOf(() => validateTokenBytes('tokens.colors.dark', bytes('[1]'))), 'NOT_OBJECT');
	const huge = bytes({ '--teal': '#fff', pad: 'x'.repeat(TOKEN_MAX_BYTES) }); assert.equal(reasonOf(() => validateTokenBytes('tokens.colors.dark', huge)), 'TOO_BIG');
	try { validateTokenBytes('tokens.colors.dark', huge); } catch (e) { assert.equal((e as TokenRejected).statusCode ?? (e as any).status, 413); }
	assert.equal(reasonOf(() => validateTokenBytes('tokens.colors.dark', bytes('{' + Array.from({ length: 80 }, (_, i) => `"--a${i}":"#fff"`).join(',') + '}'))), 'TOO_MANY_ENTRIES');
	// the offending token is named in the error body
	try { val('tokens.colors.dark', { '--teal': 'url(x)' }); assert.fail('should throw'); } catch (e) { assert.equal((e as any).errors[0].name, '--teal'); assert.equal((e as any).errors[0].field, 'value'); assert.equal((e as any).code, 'SITE_IDENTITY_FILE_REJECTED'); }
});

test('tokens: the upload pipeline (validateIdentityUpload) stores canonical JSON with application/json, no dimensions, deterministic sha256; files are untouched', async () => {
	const def = identityDef('tokens.colors.dark')!;
	const a = await validateIdentityUpload(def, bytes('{ "--teal" : "#14B8A6", "--pg":"#070D24" }'), 'application/json');
	const b = validateTokenUpload('tokens.colors.dark', bytes({ '--teal': '#14b8a6' }));
	assert.equal(a.mime, 'application/json'); assert.equal(a.width, null); assert.equal(a.height, null); assert.equal(a.bytes.toString('utf8'), '{"--teal":"#14b8a6"}'); assert.equal(a.sha256, b.sha256); assert.equal(a.byteSize, a.bytes.length);
	assert.equal(a.sanitized.removed, 1); assert.ok(a.note?.includes('--pg'));
	await assert.rejects(validateIdentityUpload(def, Buffer.alloc(0)), /الملف فارغ/);
	await assert.rejects(validateIdentityUpload(def, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), (e: any) => e.code === 'SITE_IDENTITY_FILE_REJECTED');
	// a token JSON is not accepted for an image key and vice versa
	await assert.rejects(validateIdentityUpload(identityDef('logo.mark')!, bytes({ '--teal': '#fff' })), (e: any) => e.code === 'SITE_IDENTITY_FILE_REJECTED');
});

test('tokens: CSS builder - empty = "", exact shape, dark scoped away from light, shared names pinned in light, unsafe stored data never reaches the CSS', () => {
	assert.equal(buildTokensCss({}), ''); assert.equal(buildTokensCss({ 'tokens.colors.dark': {}, 'tokens.layout': {} }), '');
	const css = buildTokensCss({
		'tokens.layout': { '--container': '1100px' }, 'tokens.typography': { '--font-family': "'Cairo',sans-serif" },
		'tokens.colors.dark': { '--pg': '#0b1020', '--grad': 'linear-gradient(90deg,#111,#222)' }, 'tokens.colors.light': { '--pg': '#ffffff' },
	});
	assert.equal(css, [
		":root{--container:1100px;--font-family:'Cairo',sans-serif}",
		':root:not(.theme-light):not(.light-theme){--pg:#0b1020;--grad:linear-gradient(90deg,#111,#222)}',
		`${LIGHT_SELECTOR}{--pg:#ffffff;--grad:linear-gradient(135deg,#2bd4c7,#2b7fff)}`, // --grad is the one name light does not redefine: light keeps the platform value when only dark overrides it
	].join('\n'));
	// light override of a shared name wins over the pin
	assert.equal(buildTokensCss({ 'tokens.colors.dark': { '--grad': 'linear-gradient(90deg,#111,#222)' }, 'tokens.colors.light': { '--grad': 'linear-gradient(90deg,#333,#444)' } }).split('\n')[1], `${LIGHT_SELECTOR}{--grad:linear-gradient(90deg,#333,#444)}`);
	// a dark-only override of a name light DOES redefine never restates a light value
	assert.equal(buildTokensCss({ 'tokens.colors.dark': { '--teal': '#14b8a6' } }), ':root:not(.theme-light):not(.light-theme){--teal:#14b8a6}');
	// only-light override: no dark rule, no pins
	assert.equal(buildTokensCss({ 'tokens.colors.light': { '--txt': '#111111' } }), `${LIGHT_SELECTOR}{--txt:#111111}`);
	// poisoned input (as if read from a tampered row) is dropped block-wise
	const poisoned = buildTokensCss({ 'tokens.colors.dark': { '--teal': 'url(x);}body{x:y' }, 'tokens.layout': { '--radius': '8px' } });
	assert.equal(poisoned, ':root{--radius:8px}');
	for (const bad of ['<', '>', '@', 'url(', '\\', '/*', '!important', 'var(']) assert.ok(!css.includes(bad), `css must not contain ${bad}`);
});
