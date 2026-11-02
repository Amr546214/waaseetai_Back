#!/usr/bin/env node
// READ-ONLY inventory helper for the site-identity registry (src/config/site-identity.registry.ts).
// Usage: node scripts/site-identity-fingerprints.cjs <FE-repo-root> [--check]
// Prints the real mime / dimensions / size / sha256 of every default asset the registry names, and the consumers found by grep.
// With --check it exits 1 when a fingerprint recorded in the registry differs from the file (used when the FE repo is available).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = process.argv[2];
if (!root) { console.error('usage: site-identity-fingerprints.cjs <FE-repo-root> [--check]'); process.exit(2); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function dims(buf) {
	if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	if (buf[0] === 0xff && buf[1] === 0xd8) { let o = 2; while (o < buf.length) { if (buf[o] !== 0xff) { o++; continue; } const m = buf[o + 1]; if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { mime: 'image/jpeg', height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) }; o += 2 + buf.readUInt16BE(o + 2); } }
	if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) { let w = 0, h = 0; for (let i = 0; i < buf.readUInt16LE(4); i++) { const ew = buf[6 + i * 16] || 256, eh = buf[7 + i * 16] || 256; if (ew * eh > w * h) { w = ew; h = eh; } } return { mime: 'image/x-icon', width: w, height: h, entries: buf.readUInt16LE(4) }; }
	const t = buf.toString('utf8', 0, 4000); if (/<svg/i.test(t)) { const vb = /viewBox="([\d.\s-]+)"/.exec(t); const [, , w, h] = vb ? vb[1].trim().split(/\s+/).map(Number) : [0, 0, NaN, NaN]; return { mime: 'image/svg+xml', width: w, height: h }; }
	return { mime: 'unknown' };
}
const FILES = JSON.parse(fs.readFileSync(path.join(__dirname, 'site-identity-default-files.json'), 'utf8'));
let bad = 0; const out = {};
for (const [key, rel] of Object.entries(FILES)) {
	const p = path.join(root, 'public', rel);
	if (!fs.existsSync(p)) { console.error('MISSING', rel); bad++; continue; }
	const b = fs.readFileSync(p); out[key] = { path: rel, ...dims(b), byteSize: b.length, sha256: sha(b) };
}
console.log(JSON.stringify(out, null, 1));
if (process.argv.includes('--check')) {
	const reg = require('child_process').execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config/site-identity.registry.ts').then(m=>console.log(JSON.stringify(m.SITE_IDENTITY_REGISTRY.map(k=>({key:k.key,fp:k.defaultFingerprint}))))) "], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
	for (const r of JSON.parse(reg)) { const f = out[r.key]; if (f && r.fp && (f.sha256 !== r.fp.sha256 || f.byteSize !== r.fp.byteSize)) { console.error('DRIFT', r.key); bad++; } }
}
process.exit(bad ? 1 : 0);
