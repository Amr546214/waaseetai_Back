import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ICON_ID_PATTERN, ICON_PREFIX, MAX_CUSTOM_ICONS, iconEntry, iconExcluded, iconKeyOf, iconLibraryOnly, iconSymbols, isIconWired, symbolIdOf, allowlistRevision } from './site-identity-icons';
import { KEY_PATTERN, SITE_IDENTITY_REGISTRY, describeRules, identityDef, isKnownIdentityKey, isWiredKey } from './site-identity.registry';
import { validateIdentityUpload, UploadRejected } from '../utils/site-identity-upload';
import { validateTokenBytes, validateTokenValue, TokenRejected } from '../utils/site-identity-tokens';
import { SvgRejected } from '../utils/svg-sanitizer';

/** the FE worktree beside this one (or SITE_IDENTITY_FE_ROOT); the guard against the real sprite is skipped (never passed) when it is unreachable */
const FE = [process.env.SITE_IDENTITY_FE_ROOT, path.resolve(__dirname, '../../../wt-fe-id')].filter((p): p is string => !!p).find(p => fs.existsSync(path.join(p, 'src', 'app')));
const SCRIPT = path.resolve(__dirname, '../../scripts/site-identity-icon-allowlist.cjs');
const svg = (inner: string, root = 'viewBox="0 0 24 24"') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${root}>${inner}</svg>`);
const BELL = '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>';

test('icon allow-list: well formed, unique ids that obey the key pattern, the notifications icon is present and wired', () => {
	const ids = iconSymbols().map(s => s.id);
	assert.equal(new Set(ids).size, ids.length); assert.ok(ids.length > 100);
	for (const s of iconSymbols()) { assert.match(s.id, ICON_ID_PATTERN); assert.match(iconKeyOf(s.id), KEY_PATTERN); assert.equal(symbolIdOf(iconKeyOf(s.id)), s.id); assert.match(s.sha256, /^[0-9a-f]{64}$/); assert.ok(s.defs >= 1); assert.ok(s.reason === null || s.reason === 'NO_CONSUMER'); }
	const bell = iconEntry('i-bell')!; assert.ok(bell); assert.equal(bell.reason, null); assert.equal(isIconWired('icon.fn.i-bell'), true); assert.equal(isWiredKey('icon.fn.i-bell'), true);
	// the AI mark is never a member of the family; excluded / library-only ids are not keys
	for (const e of iconExcluded()) { assert.equal(isKnownIdentityKey(iconKeyOf(e.id)), false, e.id); assert.equal(iconEntry(e.id), null); }
	assert.equal(iconEntry('i-ai'), null); assert.ok(iconExcluded().some(e => e.id === 'i-ai' && e.reason === 'MANAGED_BY_ICON_AI'));
	for (const l of iconLibraryOnly()) assert.equal(isKnownIdentityKey(iconKeyOf(l.id)), l.reason === 'MANAGED_BY_ICON_AI' ? false : iconEntry(l.id) !== null, l.id);
	assert.match(allowlistRevision(), /^[0-9a-f]{12}$/);
});

test('icon family keys: definition shape, not part of the static registry, unknown ids refused, NO_CONSUMER known but not wired', () => {
	assert.equal(SITE_IDENTITY_REGISTRY.some(d => d.key.startsWith(ICON_PREFIX)), false, 'the static registry (the page payload) does not grow with the icons');
	const d = identityDef('icon.fn.i-bell')!; assert.ok(d);
	assert.equal(d.group, 'icon'); assert.equal(d.kind, 'svg'); assert.deepEqual(d.allowedMimes, ['image/svg+xml']); assert.equal(d.maxBytes, 64 * 1024); assert.equal(d.family, 'icon.fn'); assert.equal(d.symbolId, 'i-bell');
	assert.equal(d.defaultAsset.type, 'inline-symbol'); assert.equal(d.defaultFingerprint.mime, 'image/svg+xml'); assert.match(d.defaultFingerprint.sha256, /^[0-9a-f]{64}$/); assert.ok(d.usages.length >= 1);
	assert.ok(describeRules(d).some(r => r.includes('viewBox')));
	assert.equal(identityDef('icon.fn.nope-not-a-symbol'), null); assert.equal(identityDef('icon.fn.'), null); assert.equal(identityDef('icon.fn.I-BELL'), null); assert.equal(identityDef('icon.fn.i-bell/../x'), null); assert.equal(identityDef('icon.fn.i-ai'), null);
	const nc = iconSymbols().find(s => s.reason === 'NO_CONSUMER')!; assert.ok(nc, 'there is at least one id nothing references today');
	assert.ok(identityDef(iconKeyOf(nc.id))); assert.equal(isWiredKey(iconKeyOf(nc.id)), false);
	assert.ok(MAX_CUSTOM_ICONS >= iconSymbols().filter(x => !x.reason).length + 64, 'the cap covers EVERY wired icon id plus a margin');
});

test('GUARD: the checked-in icon allow-list equals what the generator reads from the REAL FE sprite right now', { skip: FE ? false : 'FE worktree not reachable (set SITE_IDENTITY_FE_ROOT)' }, () => {
	const out = execFileSync(process.execPath, [SCRIPT, FE!, '--check'], { encoding: 'utf8' });
	assert.match(out, /matches the FE/);
	// and independently: every symbol id of the allow-list is really written as <symbol id="…"> somewhere in the FE sources
	const all: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(html|ts)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) all.push(fs.readFileSync(p, 'utf8')); } };
	walk(path.join(FE!, 'src')); const text = all.join('\n');
	for (const s of iconSymbols()) assert.ok(new RegExp(`<symbol\\b[^>]*\\bid="${s.id}"`).test(text), `${s.id} is not a <symbol> in the FE any more`);
});

test('icon upload: a plain bell icon is accepted, sanitised, and stored as SVG (viewBox kept)', async () => {
	const d = identityDef('icon.fn.i-bell')!;
	const r = await validateIdentityUpload(d, svg(`<g fill="none" stroke="currentColor" stroke-width="2">${BELL}</g>`), 'image/svg+xml');
	assert.equal(r.mime, 'image/svg+xml'); assert.equal(r.width, 24); assert.equal(r.height, 24); assert.match(r.bytes.toString('utf8'), /viewBox="0 0 24 24"/);
});

test('icon upload: hostile / unfit SVGs are refused or cleaned, never stored raw', async () => {
	const d = identityDef('icon.fn.i-bell')!;
	const bad = async (buf: Buffer, reason: string | RegExp, mime = 'image/svg+xml') => assert.rejects(validateIdentityUpload(d, buf, mime), (e: any) => { assert.ok(e instanceof UploadRejected || e instanceof SvgRejected, e?.message); assert.match(e.errors[0].reason, typeof reason === 'string' ? new RegExp(`^${reason}$`) : reason); return true; });
	await bad(svg(BELL, 'width="24" height="24"'), /ICON_NO_VIEWBOX|NO_DIMENSIONS/); // size without viewBox
	await bad(svg(`<g>${BELL}</g><use href="#i-bell"/>`), 'ICON_FORBIDDEN_ELEMENT'); // recursion / page reference
	await bad(svg(`<image href="data:image/png;base64,iVBORw0KGgo="/>${BELL}`), 'ICON_FORBIDDEN_ELEMENT'); // raster inside an icon
	await bad(svg(BELL, 'viewBox="0 0 100 10"'), 'WRONG_ASPECT');
	await bad(Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">&x;</svg>'), /ENTIT|DOCTYPE/);
	await bad(Buffer.from('<html><body><script>alert(1)</script></body></html>'), 'MARKUP_NOT_SVG');
	await bad(Buffer.from(svg(BELL).toString() + 'A'.repeat(70 * 1024)), 'TOO_BIG');
	await bad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), /.+/, 'image/png');
	// script / handlers / javascript: links / foreignObject are removed by the sanitiser; what is left is the drawing
	const cleaned = await validateIdentityUpload(d, svg(`<script>alert(1)</script><foreignObject><div onclick="x()"/></foreignObject><g onclick="alert(1)">${BELL}</g>`), 'image/svg+xml');
	const out = cleaned.bytes.toString('utf8'); assert.ok(!/script|foreignObject|onclick|alert/i.test(out), out); assert.ok(cleaned.sanitized.changed); assert.ok(cleaned.sanitized.removed >= 2);
});

test('token value errors: value-worded, name the token, never "choose another file"; wording differs by source (value body vs uploaded file)', () => {
	const msgs: string[] = [];
	const rej = (fn: () => unknown): TokenRejected => { try { fn(); } catch (e) { assert.ok(e instanceof TokenRejected); msgs.push(e.message); return e; } throw new Error('expected a rejection'); };
	let e = rej(() => validateTokenValue('tokens.colors.dark', { '--teal': 'banana' })); assert.equal(e.reason, 'BAD_VALUE'); assert.match(e.message, /^«.+ \(--teal\)»: لون غير صالح/); assert.equal(e.errors?.[0].field, 'value'); assert.equal((e.errors as any)[0].name, '--teal');
	e = rej(() => validateTokenValue('tokens.layout', { '--radius': '999px' })); assert.equal(e.reason, 'OUT_OF_RANGE'); assert.match(e.message, /--radius/);
	e = rej(() => validateTokenValue('tokens.colors.dark', { '--teal': 'url(http://x)' })); assert.equal(e.reason, 'FORBIDDEN_SYNTAX'); assert.match(e.message, /اكتب القيمة المجرّدة/);
	e = rej(() => validateTokenValue('tokens.colors.dark', { '--nope': '#fff' })); assert.equal(e.reason, 'UNKNOWN_TOKEN'); assert.match(e.message, /^الرمز «--nope»/);
	e = rej(() => validateTokenValue('tokens.colors.dark', { '--teal': 5 as any })); assert.equal(e.reason, 'NOT_STRING');
	e = rej(() => validateTokenValue('tokens.colors.dark', ['x'] as any)); assert.equal(e.reason, 'NOT_OBJECT'); assert.match(e.message, /القيم المرسلة/);
	e = rej(() => validateTokenValue('tokens.colors.dark', { '--teal': '#14b8a6' }, {}) && validateTokenValue('tokens.colors.dark', {})); assert.equal(e.reason, 'EMPTY_OVERRIDES');
	const bytes = (s: string) => new TextEncoder().encode(s);
	assert.match(rej(() => validateTokenBytes('tokens.colors.dark', bytes('{bad'), { source: 'value' })).message, /^القيم المرسلة ليست JSON/);
	assert.match(rej(() => validateTokenBytes('tokens.colors.dark', bytes('{bad'), { source: 'file' })).message, /^محتوى الملف ليس JSON/);
	assert.match(rej(() => validateTokenBytes('tokens.colors.dark', new Uint8Array([0xff, 0xfe, 0x00]), { source: 'value' })).message, /^القيم المرسلة ليست نصًا/);
	assert.match(rej(() => validateTokenBytes('tokens.colors.dark', new Uint8Array(9000), { source: 'value' })).message, /^القيم المرسلة أكبر/);
	for (const m of msgs) { assert.ok(!/اختر ملف/.test(m), m); assert.ok(!/ملفًا آخر|ملف آخر/.test(m), m); }
	for (const m of msgs.filter((_, i) => i < 7)) assert.ok(!/الملف/.test(m), `value rejection must not talk about a file: ${m}`);
});

test('token value errors over the upload entry point: the JSON body source never says «الملف»', async () => {
	const d = identityDef('tokens.colors.dark')!;
	const msg = async (buf: Buffer, source: 'value' | 'file') => { try { await validateIdentityUpload(d, buf, 'application/json', { source }); } catch (e: any) { return String(e.message); } throw new Error('expected rejection'); };
	assert.equal(await msg(Buffer.alloc(0), 'value'), 'لم تُرسَل أي قيمة للرموز.');
	assert.equal(await msg(Buffer.alloc(0), 'file'), 'الملف فارغ.');
	assert.ok(!/الملف/.test(await msg(Buffer.from('{"--teal":"nope"}'), 'value')));
});

// ---------------------------------------------------------------- Round 7: families
import { parseFamilies, iconFamilies, familyOfKey, iconFamily } from './site-identity-icon-families';
import { DEFAULT_ASSETS } from './site-identity-default-assets.generated';
import { createHash } from 'node:crypto';
test('icon families: the shipped definition is valid (every member on the allow-list and wired, one family per symbol, one primary), the notifications bell is a family', () => {
	const fams = iconFamilies(); assert.ok(fams.length >= 1);
	for (const f of fams) { assert.ok(f.members.length >= 2); assert.equal(f.members.filter(m => m.role === 'primary').length, 1); for (const m of f.members) { assert.equal(isIconWired(m.key), true, m.key); assert.equal(familyOfKey(m.key)?.id, f.id); } }
	const bell = iconFamily('notifications-bell')!; assert.ok(bell.members.some(m => m.symbolId === 'i-bell' && m.role === 'primary'));
});
test('icon families: a hostile / inconsistent definition throws instead of being dropped silently', () => {
	const ok = (over: any = {}) => ({ families: [{ id: 'f-one', label: 'L', description: 'D', members: [{ symbolId: 'i-bell', role: 'primary' }, { symbolId: 'ws-bell', role: 'copy' }], ...over }] });
	assert.equal(parseFamilies(ok()).length, 1);
	const bad = (raw: unknown, re: RegExp) => assert.throws(() => parseFamilies(raw), re);
	bad(null, /families/); bad({ families: 'x' }, /array/); bad(ok({ id: 'Bad Id' }), /bad family id/); bad(ok({ label: '' }), /label/);
	bad(ok({ members: [{ symbolId: 'i-bell', role: 'primary' }] }), /members/); bad(ok({ members: [{ symbolId: 'i-bell', role: 'primary' }, { symbolId: 'zzz-nope', role: 'copy' }] }), /allow-list/);
	bad(ok({ members: [{ symbolId: 'i-bell', role: 'primary' }, { symbolId: iconSymbols().find(s => s.reason === 'NO_CONSUMER')!.id, role: 'copy' }] }), /not wired/);
	bad(ok({ members: [{ symbolId: 'i-bell', role: 'primary' }, { symbolId: 'i-bell', role: 'copy' }] }), /two families/);
	bad(ok({ members: [{ symbolId: 'i-bell', role: 'copy' }, { symbolId: 'ws-bell', role: 'copy' }] }), /primary/); bad(ok({ members: [{ symbolId: 'i-bell', role: 'primary' }, { symbolId: 'ws-bell', role: 'primary' }] }), /primary/);
	bad(ok({ members: [{ symbolId: 'i-bell', role: 'boss' }, { symbolId: 'ws-bell', role: 'primary' }] }), /role/); bad(ok({ members: [{ symbolId: 'I BELL', role: 'primary' }, { symbolId: 'ws-bell', role: 'copy' }] }), /symbolId/);
	const two = ok(); two.families.push({ ...two.families[0], members: [{ symbolId: 'ws-bell', role: 'primary' }, { symbolId: 'hwp-bell', role: 'copy' }] }); bad(two, /duplicate family|two families/);
	bad(ok({ members: [{ symbolId: 'i-ai', role: 'primary' }, { symbolId: 'ws-bell', role: 'copy' }] }), /allow-list/);
});
test('alias defaults: the embedded copies of the social image and favicon.ico are byte-identical to the registry fingerprints', () => {
	for (const k of ['social.og', 'favicon.ico'] as const) { const d = DEFAULT_ASSETS[k]; const fp = identityDef(k)!.defaultFingerprint; const b = Buffer.from(d.base64, 'base64'); assert.equal(createHash('sha256').update(b).digest('hex'), fp.sha256); assert.equal(d.sha256, fp.sha256); assert.equal(b.length, fp.byteSize); assert.equal(d.mime, fp.mime); }
});
