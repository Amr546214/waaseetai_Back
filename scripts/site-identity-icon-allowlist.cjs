#!/usr/bin/env node
// Generates src/config/site-identity-icon-allowlist.generated.json = the ALLOW-LIST of the dynamic key family `icon.fn.<symbolId>` (see IDENTITY-ICONS-CONTRACT-2026-10-28.md).
// Usage: node scripts/site-identity-icon-allowlist.cjs <FE-repo-root> [--write | --check]
//   (no flag) prints the JSON; --write replaces the checked-in file; --check exits 1 when the checked-in file differs from what the FE produces now.
// READ-ONLY on the FE repo. Deterministic: sorted, no timestamps, no absolute paths.
//
// What counts as "the sprite": the platform has no single sprite file. Icons are `<symbol id="...">` blocks written literally inside component templates (src/**/*.html, *.ts without .spec) and src/index.html;
// `<use href="#id">` resolves to the symbol of that id that lives in the document. Every STATIC id found this way is a candidate. A candidate is WIRED (editable) only when something else in the FE refers to it
// (`#id` or a quoted 'id' / "id" outside its own definition); otherwise it is listed as NO_CONSUMER (never offered as editable). Ids that match the official AI mark rule (/(^|-)ai$/) belong to the key `icon.ai`.
// Library slots of public/assets/site-control/icons.json that have NO symbol anywhere are listed as libraryOnly (a sandbox entry: nothing draws them, so nothing could follow a change).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = process.argv[2];
const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : 'print';
if (!root) { console.error('usage: site-identity-icon-allowlist.cjs <FE-repo-root> [--write|--check]'); process.exit(2); }
const OUT = path.join(__dirname, '..', 'src', 'config', 'site-identity-icon-allowlist.generated.json');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function walk(dir, acc) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, acc);
		else if (/\.(html|ts)$/.test(e.name) && !/\.spec\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) acc.push(p);
	}
	return acc;
}
const srcRoot = path.join(root, 'src');
if (!fs.existsSync(srcRoot)) { console.error('FE src not found at', srcRoot); process.exit(2); }
const files = walk(srcRoot, []).sort();
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const texts = files.map(f => [rel(f), fs.readFileSync(f, 'utf8')]);

const norm = (s) => s.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
const defs = new Map(); // id -> { files:Set, shapes:Set(sha of normalised inner), viewBox:Set, first:{inner, viewBox} }
const dynamicDefinitions = new Set();
const SYMBOL = /<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g;
for (const [f, t] of texts) {
	let m;
	while ((m = SYMBOL.exec(t))) {
		const attrs = m[1]; const idm = /\bid\s*=\s*"([^"]*)"/.exec(attrs) || /\bid\s*=\s*'([^']*)'/.exec(attrs);
		if (!idm) continue;
		const id = idm[1];
		if (/[${}]/.test(id) || id === '') { dynamicDefinitions.add(f); continue; }
		const vb = (/\bviewBox\s*=\s*"([^"]*)"/.exec(attrs) || [])[1] || null;
		const e = defs.get(id) || { files: new Set(), shapes: new Set(), vbs: new Set(), first: null };
		e.files.add(f); const inner = norm(m[2]); e.shapes.add(sha(vb + '|' + inner)); if (vb) e.vbs.add(vb.trim().replace(/\s+/g, ' '));
		if (!e.first) e.first = { inner, vb: vb ? vb.trim().replace(/\s+/g, ' ') : null };
		e.defs = (e.defs || 0) + 1;
		defs.set(id, e);
	}
}
// references are counted outside the identity runtime and the admin identity/library pages themselves (they mention ids as DATA, not as consumers)
const NOT_CONSUMERS = [/^src\/app\/core\/identity\//, /^src\/app\/pages\/dashboard\/supper-admin-overview\/site-control\//];
const all = texts.filter(([f]) => !NOT_CONSUMERS.some(r => r.test(f))).map(([, t]) => t).join('\n');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refsOf = (id) => {
	const re = new RegExp('#' + esc(id) + '(?![A-Za-z0-9_-])|[\'"`]' + esc(id) + '[\'"`]', 'g');
	const own = new RegExp('\\bid\\s*=\\s*[\'"]' + esc(id) + '[\'"]', 'g');
	const total = (all.match(re) || []).length;
	// a definition written as id="x" is not a reference; (the quoted pattern above would count it)
	const defsCount = (all.match(own) || []).length;
	return Math.max(0, total - defsCount);
};
const isAi = (id) => /(^|-)ai$/.test(id);
const ID_OK = /^[a-z][a-z0-9-]{0,63}$/;

const symbols = []; const excluded = [];
for (const id of [...defs.keys()].sort()) {
	const d = defs.get(id);
	if (isAi(id)) { excluded.push({ id, reason: 'MANAGED_BY_ICON_AI' }); continue; }
	if (!ID_OK.test(id)) { excluded.push({ id, reason: 'BAD_ID_CHARS' }); continue; }
	const [w, h] = d.first.vb ? d.first.vb.split(' ').slice(2).map(Number) : [NaN, NaN];
	const refs = refsOf(id);
	symbols.push({
		id, viewBox: d.first.vb, width: Number.isFinite(w) ? w : null, height: Number.isFinite(h) ? h : null,
		defs: d.defs, variants: d.shapes.size, reason: refs > 0 ? null : 'NO_CONSUMER',
		sha256: sha(d.first.vb + '|' + d.first.inner), byteSize: Buffer.byteLength(d.first.inner), files: [...d.files].sort().slice(0, 3),
	});
}
let lib = { libraries: [] };
const libPath = path.join(root, 'public', 'assets', 'site-control', 'icons.json');
if (fs.existsSync(libPath)) lib = JSON.parse(fs.readFileSync(libPath, 'utf8'));
const symbolIds = new Set(defs.keys());
const libraryLabels = {}; const libraryOnly = [];
for (const l of lib.libraries || []) for (const i of l.icons || []) {
	if (symbolIds.has(i.slot)) libraryLabels[i.slot] = i.label;
	else libraryOnly.push({ id: i.slot, library: l.id, label: i.label, reason: isAi(i.slot) ? 'MANAGED_BY_ICON_AI' : 'LIBRARY_ONLY' });
}
for (const s of symbols) if (libraryLabels[s.id]) s.label = libraryLabels[s.id];
libraryOnly.sort((a, b) => a.id.localeCompare(b.id));
const out = {
	generatedBy: 'scripts/site-identity-icon-allowlist.cjs',
	note: 'GENERATED - do not edit by hand. Regenerate with: node scripts/site-identity-icon-allowlist.cjs <FE-repo> --write',
	counts: { symbols: symbols.length, wired: symbols.filter(s => !s.reason).length, noConsumer: symbols.filter(s => s.reason).length, excluded: excluded.length, libraryOnly: libraryOnly.length },
	symbols, excluded, libraryOnly,
	dynamicSymbolDefinitionFiles: [...dynamicDefinitions].sort(),
};
const json = JSON.stringify(out, null, 1) + '\n';
if (mode === 'print') process.stdout.write(json);
else if (mode === 'write') { fs.writeFileSync(OUT, json); console.log('wrote', path.relative(process.cwd(), OUT), JSON.stringify(out.counts)); }
else {
	const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
	if (cur !== json) { console.error('DRIFT: the checked-in icon allow-list differs from the FE sprite. Run with --write and review the diff.'); process.exit(1); }
	console.log('icon allow-list matches the FE', JSON.stringify(out.counts));
}
