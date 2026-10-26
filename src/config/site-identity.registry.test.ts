import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
	ATLAS_MAX_BYTES, IDENTITY_GROUPS, IDENTITY_KEYS, KEY_PATTERN, NOT_IDENTITY_NOTES, RASTER_MAX_BYTES, SITE_IDENTITY_REGISTRY, SVG_MAX_BYTES, UNREGISTERED_PRESENT_ASSETS, WIRED_KEYS,
	describeRules, identityDef, isWiredKey, maxBytesFor,
} from './site-identity.registry';

const SRC = path.join(__dirname, '..');
const walk = (d: string, out: string[] = []) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p, out); } else if (f.name.endsWith('.ts')) out.push(p); } return out; };

test('registry: stable unique keys, the design groups, Arabic labels, real fingerprints, real usages, caps within the design (atlases are the one documented exception)', () => {
	assert.equal(new Set(IDENTITY_KEYS).size, IDENTITY_KEYS.length);
	for (const d of SITE_IDENTITY_REGISTRY) {
		assert.match(d.key, KEY_PATTERN, d.key); assert.ok(IDENTITY_GROUPS.includes(d.group), d.key); assert.match(d.label, /[؀-ۿ]/, `${d.key}: Arabic label`); assert.match(d.description, /[؀-ۿ]/);
		assert.match(d.defaultFingerprint.sha256, /^[0-9a-f]{64}$/); assert.ok(d.defaultFingerprint.byteSize > 0); assert.ok(d.usages.length >= 1, `${d.key}: at least one real consumer`);
		for (const u of d.usages) { assert.ok(u.where.length > 5 && u.ref.length > 3, d.key); }
		assert.match(d.notWiredReason, /[؀-ۿ]/); assert.ok(d.allowedMimes.length >= 1);
		if (d.group === 'character') { assert.equal(d.maxBytes, ATLAS_MAX_BYTES, d.key); assert.deepEqual(d.dimensions.exact, { width: 1774, height: 887 }); } else assert.ok(d.maxBytes <= RASTER_MAX_BYTES, `${d.key}: <= 512KB`);
		for (const m of d.allowedMimes) assert.ok(maxBytesFor(d, m) <= (m === 'image/svg+xml' ? SVG_MAX_BYTES : d.maxBytes));
		assert.ok(describeRules(d).length >= 2);
		// the constraints must admit the key's OWN current default (we never ship a rule today's identity breaks); the atlas default is larger than 512KB by design
		const fp = d.defaultFingerprint; assert.ok(d.defaultAsset.type === 'inline-symbol' || d.allowedMimes.includes(fp.mime), `${d.key}: default mime allowed`);
		if (d.defaultAsset.type === 'file') { assert.ok(fp.byteSize <= d.maxBytes, `${d.key}: default within its own cap`); const r = d.dimensions, w = fp.width!, h = fp.height!; if (r.exact) assert.deepEqual({ width: w, height: h }, r.exact); else { if (r.minWidth) assert.ok(w >= r.minWidth); if (r.minHeight) assert.ok(h >= r.minHeight); if (r.maxWidth) assert.ok(w <= r.maxWidth); if (r.maxHeight) assert.ok(h <= r.maxHeight); if (r.aspectMin) assert.ok(w / h >= r.aspectMin); if (r.aspectMax) assert.ok(w / h <= r.aspectMax + 1e-9); } }
	}
	for (const k of ['logo.mark', 'logo.boot', 'logo.email', 'social.og', 'favicon.tab', 'favicon.ico', 'icon.ai', 'character.bebo.classic.sprites', 'character.bebo.scout.sprites']) assert.ok(identityDef(k), k);
	assert.equal(identityDef('icon.ai')!.defaultAsset.type, 'inline-symbol'); assert.deepEqual(identityDef('logo.mark')!.defaultAsset, { type: 'file', path: '/images/waseet-mark.png' });
	assert.ok(!SITE_IDENTITY_REGISTRY.some(d => /platform.?name|name$/.test(d.key)), 'the platform NAME is not an identity key');
	assert.ok(NOT_IDENTITY_NOTES.some(n => /اسم المنصة/.test(n)) && NOT_IDENTITY_NOTES.some(n => /#i-ai/.test(n)));
	for (const a of UNREGISTERED_PRESENT_ASSETS) assert.match(a.sha256, /^[0-9a-f]{64}$/);
});

test('wired: ONE list (WIRED_KEYS) of known keys; there is no other source and no way to edit it from the API', () => {
	for (const k of WIRED_KEYS) assert.ok(identityDef(k), `${k} is a registry key`); assert.equal(new Set(WIRED_KEYS).size, WIRED_KEYS.length);
	assert.equal(isWiredKey('logo.mark', ['logo.mark']), true); assert.equal(isWiredKey('logo.mark', []), false); assert.equal(isWiredKey('nope.nope', ['nope.nope']), false, 'an unknown key is never wired');
	assert.ok(!SITE_IDENTITY_REGISTRY.some(d => 'wired' in d), 'no key carries its own `wired` flag');
	// the only module that may mention WIRED_KEYS besides the registry is the service (read-only); no route, no body field, nothing writes it
	const users = walk(SRC).filter(f => !/\.test\.ts$|registry\.ts$/.test(f) && fs.readFileSync(f, 'utf8').includes('WIRED_KEYS')).map(f => path.relative(SRC, f));
	assert.deepEqual(users, ['services/site-identity.service.ts']);
	const svc = fs.readFileSync(path.join(SRC, 'services', 'site-identity.service.ts'), 'utf8'); assert.ok(!/WIRED_KEYS\s*(=|\.push|\.splice|\.length\s*=)/.test(svc.replace(/export const WIRED_KEYS/g, '')));
	for (const f of ['admin-site-identity.routes.ts', 'public-site-identity.routes.ts']) { const src = fs.readFileSync(path.join(SRC, 'routes', f), 'utf8'); assert.ok(!/req\.body\??\.wired|body\.wired|\bwired\b\s*[:=]/.test(src), `${f}: no route accepts a wired flag`); }
	assert.ok(Object.isFrozen(WIRED_KEYS) || Array.isArray(WIRED_KEYS));
});

// ---- fingerprints against the FE repo, when it is checked out next to this one (the coordinator's CI has it; a lone checkout skips)
const FE_ROOT = process.env.SITE_IDENTITY_FE_ROOT || path.join(SRC, '..', '..', 'sc-fe-team');
const hasFe = fs.existsSync(path.join(FE_ROOT, 'public', 'images', 'waseet-mark.png'));
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
test('registry fingerprints equal the real FE default files (sha256 + size) and the inline AI icon markup', { skip: hasFe ? false : 'FE repo not found next to this checkout (set SITE_IDENTITY_FE_ROOT)' }, () => {
	const files = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'site-identity-default-files.json'), 'utf8')) as Record<string, string>;
	for (const [key, rel] of Object.entries(files)) { const d = identityDef(key)!; const b = fs.readFileSync(path.join(FE_ROOT, 'public', rel)); assert.equal(sha(b), d.defaultFingerprint.sha256, `${key} (${rel})`); assert.equal(b.length, d.defaultFingerprint.byteSize, key); }
	for (const a of UNREGISTERED_PRESENT_ASSETS) assert.equal(sha(fs.readFileSync(path.join(FE_ROOT, a.path))), a.sha256, a.path);
	const ai = fs.readFileSync(path.join(FE_ROOT, 'src/app/core/constants/ai-icon.ts'), 'utf8');
	const circles = /AI_ICON_CIRCLES =\s*([\s\S]*?);\n/.exec(ai)![1], links = /AI_ICON_LINKS =\s*'([^']+)'/.exec(ai)![1];
	const inner = `${[...circles.matchAll(/'([^']*)'/g)].map(m => m[1]).join('')}<path d="${links}"/>`;
	assert.equal(sha(Buffer.from(inner)), identityDef('icon.ai')!.defaultFingerprint.sha256); assert.equal(Buffer.byteLength(inner), identityDef('icon.ai')!.defaultFingerprint.byteSize);
});
