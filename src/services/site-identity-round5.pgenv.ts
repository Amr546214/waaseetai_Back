import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { env, opts, mkStaff } from '../testing/admin-team.pgenv';
import { chunk } from '../testing/site-identity.pgenv';
import { SITE_IDENTITY_REGISTRY, WIRED_KEYS, identityDef } from '../config/site-identity.registry';
import { validateIdentityUpload } from '../utils/site-identity-upload';
import { mount, reset, staged, publish, dbState } from './site-identity-round2.pgenv';

/**
 * Site identity ROUND 5 on REAL PostgreSQL over HTTP: design tokens (registry keys of group `token`) through the SAME pipeline, and all 14 Bebo atlases with the REAL default files.
 * Runs inside the process of site-identity.pg.test.ts (shared tables, one process). Isolated local database only.
 */
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const sv = async (m: any, who: string, key: string) => (await m.adm('GET', '/', who)).json.data.items.find((i: any) => i.key === key).state.stateVersion as number;
const tok = (m: any, who: string, key: string, value: unknown) => m.adm('POST', `/${key}/upload`, who, { value });
const pubTok = async (m: any, who: string, key: string, value: unknown) => {
	const up = await tok(m, who, key, value); assert.equal(up.status, 201, JSON.stringify(up.json));
	const pb = await publish(m, who, key, up.json.data.versionId, await sv(m, who, key)); assert.equal(pb.status, 200, JSON.stringify(pb.json)); return { up: up.json.data, pb: pb.json.data };
};

test('PG round5 tokens: json upload (body and multipart) -> staged with value -> publish -> manifest carries the sparse value + ready CSS inline -> immutable JSON asset -> restore -> default; audit has names only', opts, async () => {
	const e = await env(); await reset(e);
	const mg = (await mkStaff(e, ['site.manage'], 'tk')).user;
	const m = await mount(e, { isWired: (k) => WIRED_KEYS.includes(k) });
	const before = await m.pub(''); assert.deepEqual(before.json.data, { version: 0, items: {} }, 'nothing published: the manifest is exactly today\'s (no tokensCss key)');
	// overview: the four token keys, group token, kind json, token spec with resolved defaults, typography unwired
	const ov = (await m.adm('GET', '/', mg.id)).json.data;
	assert.ok(ov.groups.includes('token'));
	const dark = ov.items.find((i: any) => i.key === 'tokens.colors.dark'), light = ov.items.find((i: any) => i.key === 'tokens.colors.light');
	assert.equal(dark.kind, 'json'); assert.equal(dark.group, 'token'); assert.equal(dark.wired, true); assert.equal(dark.tokens.length, 34); assert.equal(light.tokens.length, 34);
	assert.equal(dark.tokens.find((t: any) => t.name === '--pg').default, '#070d24'); assert.equal(light.tokens.find((t: any) => t.name === '--pg').default, '#eef2fa');
	assert.equal(light.tokens.find((t: any) => t.name === '--teal').sharedWithDark, true); assert.equal(light.tokens.find((t: any) => t.name === '--txt').sharedWithDark, false);
	assert.equal(ov.items.find((i: any) => i.key === 'tokens.layout').tokens.length, 3);
	const ty = ov.items.find((i: any) => i.key === 'tokens.typography'); assert.equal(ty.wired, false); assert.equal(ty.editable, false); assert.ok(ty.notWiredReason.length > 20);
	assert.equal(dark.defaultFingerprint.sha256, sha('{}')); assert.equal(dark.state.isDefault, true);
	// typography cannot be changed while unwired
	const tw = await tok(m, mg.id, 'tokens.typography', { '--font-family': "'Cairo',sans-serif" }); assert.equal(tw.status, 409); assert.equal(tw.json.code, 'SITE_IDENTITY_KEY_NOT_WIRED');

	// upload by JSON body
	const up = await tok(m, mg.id, 'tokens.colors.dark', { '--teal': '#14B8A6', '--pg': '#070D24', '--header-bg': 'rgba(7, 13, 36, 0.80)' });
	assert.equal(up.status, 201, JSON.stringify(up.json)); const v1 = up.json.data;
	assert.equal(v1.mime, 'application/json'); assert.equal(v1.width, null); assert.equal(v1.status, 'STAGED'); assert.deepEqual(v1.value, { '--teal': '#14b8a6', '--header-bg': 'rgba(7,13,36,.8)' });
	assert.equal(v1.sha256, sha('{"--teal":"#14b8a6","--header-bg":"rgba(7,13,36,.8)"}')); assert.equal(v1.sanitized.removed, 1); assert.equal(v1.url, null);
	assert.deepEqual((await m.adm('GET', '/', mg.id)).json.data.items.find((i: any) => i.key === 'tokens.colors.dark').staged[0].value, v1.value, 'overview shows the staged value');
	assert.equal((await m.pub('')).json.data.items['tokens.colors.dark'], undefined, 'staged is invisible to the public');
	const prev = await m.adm('GET', `/tokens.colors.dark/versions/${v1.versionId}/preview`, mg.id); assert.equal(prev.status, 200); assert.equal(prev.headers.get('content-type')?.startsWith('application/json'), true); assert.equal(prev.headers.get('cache-control'), 'private, no-store');
	// publish
	const pb = await publish(m, mg.id, 'tokens.colors.dark', v1.versionId, 0); assert.equal(pb.status, 200, JSON.stringify(pb.json));
	assert.deepEqual(pb.json.data.active.value, v1.value); assert.equal(pb.json.data.isDefault, false);
	const man = await m.pub(''); const item = man.json.data.items['tokens.colors.dark'];
	assert.deepEqual(item.value, v1.value); assert.equal(item.mime, 'application/json'); assert.equal(item.width, null); assert.equal(item.sha256, v1.sha256);
	assert.equal(man.json.data.tokensCss, ':root:not(.theme-light):not(.light-theme){--teal:#14b8a6;--header-bg:rgba(7,13,36,.8)}\n.theme-light.theme-light,.light-theme.light-theme{--teal:#2bd4c7}', 'ready CSS: dark rule + the shared --teal pinned in light');
	assert.equal(man.headers.get('cache-control'), 'public, max-age=60'); assert.ok(man.headers.get('etag'));
	// immutable JSON asset
	const asset = await m.pub(`/assets/tokens.colors.dark/${v1.sha256}`); assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type')?.startsWith('application/json'), true); assert.equal(asset.headers.get('x-content-type-options'), 'nosniff'); assert.match(asset.headers.get('cache-control')!, /immutable/);
	assert.deepEqual(asset.json, v1.value);

	// second set by MULTIPART file; light and layout keys join the CSS
	const f = new FormData(); f.append('file', new Blob([JSON.stringify({ '--teal': '#0d9488', '--red': '#ff0000' })], { type: 'application/json' }), 'dark.json');
	const up2 = await m.adm('POST', '/tokens.colors.dark/upload', mg.id, f); assert.equal(up2.status, 201, JSON.stringify(up2.json));
	const pb2 = await publish(m, mg.id, 'tokens.colors.dark', up2.json.data.versionId, pb.json.data.stateVersion); assert.equal(pb2.status, 200);
	await pubTok(m, mg.id, 'tokens.colors.light', { '--pg': '#ffffff', '--txt': '#111111' });
	await pubTok(m, mg.id, 'tokens.layout', { '--container': '1100px', '--radius': '12px' });
	const css = (await m.pub('')).json.data.tokensCss as string;
	assert.equal(css, [':root{--container:1100px;--radius:12px}', ':root:not(.theme-light):not(.light-theme){--teal:#0d9488;--red:#ff0000}', '.theme-light.theme-light,.light-theme.light-theme{--pg:#ffffff;--txt:#111111;--teal:#2bd4c7}'].join('\n'));
	// persistence: a brand-new service object (restart) on the same database answers identically
	const { SiteIdentityService } = await import('./site-identity.service');
	const again = await new SiteIdentityService({ isWired: (k) => WIRED_KEYS.includes(k) }).publicManifest(); assert.equal(again.tokensCss, css); assert.deepEqual(again.items['tokens.layout'].value, { '--container': '1100px', '--radius': '12px' });

	// restore dark to the first version, then to default
	const rs = await m.adm('POST', '/tokens.colors.dark/restore', mg.id, { target: v1.versionId, expectedVersion: await sv(m, mg.id, 'tokens.colors.dark') }); assert.equal(rs.status, 200, JSON.stringify(rs.json)); assert.deepEqual(rs.json.data.active.value, v1.value);
	assert.deepEqual((await m.pub('')).json.data.items['tokens.colors.dark'].value, v1.value);
	const rd = await m.adm('POST', '/tokens.colors.dark/restore', mg.id, { target: 'default', expectedVersion: await sv(m, mg.id, 'tokens.colors.dark') }); assert.equal(rd.status, 200); assert.equal(rd.json.data.isDefault, true); assert.equal(rd.json.data.active, null);
	assert.equal((await m.pub('')).json.data.items['tokens.colors.dark'], undefined);
	// a superseded set is still served (open pages keep their URL)
	assert.equal((await m.pub(`/assets/tokens.colors.dark/${v1.sha256}`)).status, 200);
	// history carries values
	const h = (await m.adm('GET', '/history?key=tokens.colors.dark', mg.id)).json.data; assert.ok(h.versions.every((v: any) => typeof v.value === 'object')); assert.ok(h.versions.some((v: any) => v.value['--teal'] === '#0d9488'));
	// audit: names only, never values
	const rows = await e.prisma.accountAuditLog.findMany({ where: { eventType: { in: ['SITE_IDENTITY_UPLOADED', 'SITE_IDENTITY_PUBLISHED', 'SITE_IDENTITY_RESTORED'] } } });
	const mine = rows.filter((r: any) => String((r.metaData as any)?.identityKey ?? '').startsWith('tokens.'));
	assert.ok(mine.length >= 6, `audit rows for token keys: ${mine.length}`);
	const pubRow = mine.find((r: any) => r.eventType === 'SITE_IDENTITY_PUBLISHED' && (r.metaData as any).identityKey === 'tokens.colors.dark'); assert.match(String((pubRow!.metaData as any).overrideNames), /--teal/);
	for (const r of mine) { const j = JSON.stringify([r.metaData, r.summary, r.title, r.beforeData, r.afterData]); assert.ok(!/#14b8a6|#0d9488|rgba\(7/.test(j), 'no token VALUE in the audit details'); }
	await m.close();
});

test('PG round5 tokens: hostile uploads over HTTP are refused with the offending name and change nothing; unauthorised callers get 403; conflicts and private drafts behave as for files', opts, async () => {
	const e = await env(); await reset(e);
	const mg = (await mkStaff(e, ['site.manage'], 'tk1')).user, other = (await mkStaff(e, ['site.manage'], 'tk2')).user, viewer = (await mkStaff(e, ['site.view'], 'tk3')).user, none = (await mkStaff(e, ['users.view'], 'tk4')).user, legacy = (await mkStaff(e, ['site_control.manage'], 'tk5')).user;
	const m = await mount(e, { isWired: (k) => WIRED_KEYS.includes(k) });
	const base = await dbState(e);
	const attacks: Array<[any, string]> = [
		[{ '--teal': 'url(https://evil.test/x.png)' }, 'FORBIDDEN_SYNTAX'], [{ '--teal': '#fff;background:red' }, 'FORBIDDEN_SYNTAX'], [{ '--teal': '#fff}body{display:none' }, 'FORBIDDEN_SYNTAX'], [{ '--teal': '@import url(x)' }, 'FORBIDDEN_SYNTAX'],
		[{ '--teal': 'var(--txt)' }, 'FORBIDDEN_SYNTAX'], [{ '--teal': '/*x*/#fff' }, 'FORBIDDEN_SYNTAX'], [{ '--teal': 'expression(alert(1))' }, 'FORBIDDEN_SYNTAX'], [{ '--teal': '#fff</style><script>1</script>' }, 'FORBIDDEN_SYNTAX'],
		[{ '--evil': '#fff' }, 'UNKNOWN_TOKEN'], [{ 'background': '#fff' }, 'BAD_NAME'], [{ '--teal': 12 }, 'NOT_STRING'], [{ '--teal': '#' + 'f'.repeat(250) }, 'VALUE_TOO_LONG'], [{}, 'EMPTY_OVERRIDES'], [{ '--teal': '#2BD4C7' }, 'EMPTY_OVERRIDES'],
		[{ '--radius': '8px' }, 'UNKNOWN_TOKEN'], // a layout token in a colour set
	];
	for (const [value, reason] of attacks) {
		const r = await tok(m, mg.id, 'tokens.colors.dark', value); assert.equal(r.status, 400, `${JSON.stringify(value).slice(0, 50)} -> ${r.status}`); assert.equal(r.json.code, 'SITE_IDENTITY_FILE_REJECTED'); assert.equal(r.json.errors[0].reason, reason, JSON.stringify(r.json.errors));
		if (!['EMPTY_OVERRIDES'].includes(reason) && !('background' in value)) assert.ok(r.json.errors[0].name, 'the offending token is named');
	}
	const big = await tok(m, mg.id, 'tokens.colors.dark', { '--teal': '#fff', ...Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`--x${i}`, '#fff'])) }); assert.ok([400, 413].includes(big.status)); assert.notEqual(big.status, 201);
	const huge = await m.adm('POST', '/tokens.colors.dark/upload', mg.id, { value: { '--teal': '#fff' }, pad: 'x'.repeat(2000) }); assert.equal(huge.status, 201, 'extra body fields are ignored, only `value` is read');
	await m.adm('DELETE', `/tokens.colors.dark/versions/${huge.json.data.versionId}`, mg.id);
	const wrongType = await m.adm('POST', '/tokens.colors.dark/upload', mg.id, { value: ['#fff'] }); assert.equal(wrongType.status, 400); assert.equal(wrongType.json.errors[0].reason, 'NOT_OBJECT');
	const noValue = await m.adm('POST', '/tokens.colors.dark/upload', mg.id, {}); assert.equal(noValue.status, 400);
	const f = new FormData(); f.append('file', new Blob(['{"--teal":"#fff"'], { type: 'application/json' }), 'x.json'); const badJson = await m.adm('POST', '/tokens.colors.dark/upload', mg.id, f); assert.equal(badJson.status, 400); assert.equal(badJson.json.errors[0].reason, 'NOT_JSON');
	const png1 = new FormData(); png1.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48])], { type: 'image/png' }), 'x.png'); assert.equal((await m.adm('POST', '/tokens.colors.dark/upload', mg.id, png1)).status, 400, 'an image is not a token set');
	// a JSON body sent to an image key is not taken as a file
	assert.equal((await m.adm('POST', '/logo.mark/upload', mg.id, { value: { '--teal': '#fff' } })).status, 400);
	const after = await dbState(e); const cmp = JSON.parse(after); cmp.l = JSON.parse(base).l; // the only legitimate trace of the accepted+discarded extra body is its audit rows / assets; rejected ones leave nothing
	assert.equal(JSON.parse(after).s.length, 0, 'no state row'); assert.equal(JSON.parse(after).m, 0, 'no manifest row');
	assert.equal(await e.prisma.siteIdentityAsset.count({ where: { status: 'STAGED' } }), 0, 'no staged leftovers (the only accepted draft was discarded)');

	// unauthorised / read-only
	assert.equal((await tok(m, viewer.id, 'tokens.colors.dark', { '--teal': '#14b8a6' })).status, 403);
	assert.equal((await m.adm('GET', '/', none.id)).status, 403); assert.equal((await tok(m, none.id, 'tokens.layout', { '--radius': '8px' })).status, 403);
	assert.equal((await m.raw('POST', '/admin/site-identity/tokens.layout/upload', null, { value: { '--radius': '8px' } })).status, 401);
	assert.equal((await m.adm('GET', '/', viewer.id)).status, 200);
	// legacy holder = edit
	const lu = await tok(m, legacy.id, 'tokens.layout', { '--radius': '8px' }); assert.equal(lu.status, 201); assert.equal((await publish(m, legacy.id, 'tokens.layout', lu.json.data.versionId, 0)).status, 200);

	// private draft + conflict on the same key
	const d1 = await tok(m, mg.id, 'tokens.colors.dark', { '--teal': '#14b8a6' }); const d2 = await tok(m, other.id, 'tokens.colors.dark', { '--teal': '#0d9488' });
	const sup = await publish(m, e.sa.id, 'tokens.colors.dark', d1.json.data.versionId, 0); assert.equal(sup.status, 409); assert.equal(sup.json.code, 'SITE_IDENTITY_DRAFT_NOT_YOURS', 'SUPER_ADMIN cannot publish another admin\'s token draft');
	const [a, b] = await Promise.all([publish(m, mg.id, 'tokens.colors.dark', d1.json.data.versionId, 0), publish(m, other.id, 'tokens.colors.dark', d2.json.data.versionId, 0)]);
	assert.deepEqual([a.status, b.status].sort(), [200, 409]); const loser = a.status === 409 ? a : b; assert.equal(loser.json.code, 'SITE_IDENTITY_VERSION_CONFLICT'); assert.ok(loser.json.current.active.value['--teal'], 'conflict body carries the winner\'s value');
	assert.equal(await e.prisma.siteIdentityAsset.count({ where: { key: 'tokens.colors.dark', status: 'PUBLISHED' } }), 1);

	// set restore over a token key: preview carries the value, digest binds, restore-set to 0 clears tokens
	const pv = await m.adm('GET', '/restore-set/0/preview', mg.id); assert.equal(pv.status, 200);
	const row = pv.json.data.items.find((i: any) => i.key === 'tokens.colors.dark'); assert.equal(row.change, 'to-default'); assert.ok(row.current.value['--teal']); assert.deepEqual(row.target.value, {}); assert.equal(row.target.source, 'default');
	assert.equal(pv.json.data.items.find((i: any) => i.key === 'tokens.layout').current.value['--radius'], '8px');
	assert.ok(!pv.json.data.items.some((i: any) => i.key === 'tokens.typography'), 'unwired keys are not part of a set preview');
	const stale = await m.adm('POST', '/restore-set', mg.id, { manifestVersion: 0, expectedManifestVersion: pv.json.data.currentManifestVersion, previewDigest: 'f'.repeat(64) }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'SITE_IDENTITY_PREVIEW_STALE'); assert.deepEqual(stale.json.current.items.find((i: any) => i.key === 'tokens.layout').target.value, {});
	const ok = await m.adm('POST', '/restore-set', mg.id, { manifestVersion: 0, expectedManifestVersion: pv.json.data.currentManifestVersion, previewDigest: pv.json.data.previewDigest }); assert.equal(ok.status, 200, JSON.stringify(ok.json));
	assert.deepEqual((await m.pub('')).json.data, { version: ok.json.data.manifestVersion, items: {} }, 'everything default again: no items, no tokensCss');
	await m.close();
});

test('PG round5 tokens: a tampered / corrupt stored token row never reaches the public CSS (re-validated on every read) and never breaks the manifest', opts, async () => {
	const e = await env(); await reset(e);
	const mg = (await mkStaff(e, ['site.manage'], 'tk6')).user; const m = await mount(e, { isWired: (k) => WIRED_KEYS.includes(k) });
	await pubTok(m, mg.id, 'tokens.layout', { '--radius': '8px' });
	// write hostile bytes straight into the database for the dark key and make them the active version
	const evil = Buffer.from('{"--teal":"url(https://evil.test/x)","--pg":"#fff;}body{display:none"}'); const id = (await import('node:crypto')).randomUUID();
	await e.prisma.siteIdentityAsset.create({ data: { id, key: 'tokens.colors.dark', version: 1, status: 'PUBLISHED', mime: 'application/json', bytes: evil, sha256: sha(evil), width: null, height: null, byteSize: evil.length, createdById: mg.id } });
	await e.prisma.siteIdentityState.create({ data: { key: 'tokens.colors.dark', activeAssetId: id, version: 1, updatedById: mg.id } });
	const man = (await m.pub('')).json.data; assert.equal(man.items['tokens.colors.dark'], undefined, 'the tampered set is ignored');
	assert.equal(man.tokensCss, ':root{--radius:8px}'); assert.ok(!/evil|url\(|body\{/.test(man.tokensCss));
	const ov = (await m.adm('GET', '/', mg.id)); assert.equal(ov.status, 200); assert.deepEqual(ov.json.data.items.find((i: any) => i.key === 'tokens.colors.dark').state.active.value, {}, 'the admin view shows {} for an unreadable set instead of crashing');
	await m.close();
});

// ---------------------------------------------------------------------------------------------------------------- Bebo: ALL 14 keys with the REAL default atlases
const BEBO = SITE_IDENTITY_REGISTRY.filter(d => d.key.startsWith('character.bebo.'));
const FE_PUBLIC = [process.env.SITE_IDENTITY_FE_PUBLIC, path.resolve(__dirname, '../../../wt-fe-id/public'), path.resolve(__dirname, '../../../sc-fe-team/public')].filter(Boolean) as string[];
const fePublic = FE_PUBLIC.find(p => fs.existsSync(path.join(p, 'bebo', 'robot-sprites.png')));
const realFile = (def: any): Buffer => fs.readFileSync(path.join(fePublic!, def.defaultAsset.path));
/** a valid copy of a PNG that differs from it: an extra tEXt chunk right after IHDR (correct CRC) */
const variantOf = (b: Buffer, tag: string): Buffer => Buffer.concat([b.subarray(0, 33), chunk('tEXt', Buffer.from(`ws-variant\0${tag}`)), b.subarray(33)]);

test('PG round5 bebo (registry, no FE needed): exactly 14 keys, all wired, each PNG-only exact 1774x887, <= 2MB, fingerprint size within the cap', opts, async () => {
	assert.equal(BEBO.length, 14); assert.deepEqual(BEBO.map(d => d.key).filter(k => !WIRED_KEYS.includes(k)), []);
	for (const d of BEBO) { assert.deepEqual(d.allowedMimes, ['image/png']); assert.deepEqual(d.dimensions, { exact: { width: 1774, height: 887 } }); assert.equal(d.group, 'character'); assert.equal(d.defaultFingerprint.width, 1774); assert.equal(d.defaultFingerprint.height, 887); assert.ok(d.defaultFingerprint.byteSize > 0 && d.defaultFingerprint.byteSize <= d.maxBytes, `${d.key} default fits its own cap`); }
	assert.equal(new Set(BEBO.map(d => d.defaultAsset.type === 'file' ? d.defaultAsset.path : '')).size, 14, 'fourteen distinct default files');
});

test('PG round5 bebo (REAL default atlases): every default file has exactly its registered size/sha and is ACCEPTED by its own upload rule (a default re-publish works); wrong sizes/types are refused per key', { ...opts, skip: fePublic ? false : 'FE public/ folder not reachable (set SITE_IDENTITY_FE_PUBLIC)' }, async () => {
	for (const d of BEBO) {
		const b = realFile(d); assert.equal(b.length, d.defaultFingerprint.byteSize, `${d.key} byte size`); assert.equal(sha(b), d.defaultFingerprint.sha256, `${d.key} sha256`);
		const v = await validateIdentityUpload(d, b, 'image/png'); assert.equal(v.width, 1774, d.key); assert.equal(v.height, 887, d.key); assert.equal(v.mime, 'image/png'); assert.equal(v.sha256, d.defaultFingerprint.sha256); assert.equal(v.bytes.equals(b), true, 'stored byte for byte');
		// the same file one pixel wider/narrower, or not a PNG, is refused for this key (IHDR patched with a valid CRC)
		for (const [w, h] of [[1775, 887], [1774, 888], [887, 1774]] as const) { const bad = Buffer.from(b); bad.writeUInt32BE(w, 16); bad.writeUInt32BE(h, 20); const { crc } = await import('../testing/site-identity.pgenv'); bad.writeUInt32BE(crc(bad.subarray(12, 29)), 29); await assert.rejects(validateIdentityUpload(d, bad, 'image/png'), (er: any) => er.code === 'SITE_IDENTITY_FILE_REJECTED' && ['WRONG_DIMENSIONS', 'PNG_CRC'].includes(er.reason), `${d.key} ${w}x${h}`); }
		await assert.rejects(validateIdentityUpload(d, b.subarray(0, b.length - 100), 'image/png'), (er: any) => er.code === 'SITE_IDENTITY_FILE_REJECTED', `${d.key} truncated`);
	}
});

test('PG round5 bebo (REAL default atlases): upload -> publish -> public serve -> restore for ALL 14 keys (default re-publish, then a changed copy, restore to the first, restore default), then one restore-set back to all defaults', { ...opts, skip: fePublic ? false : 'FE public/ folder not reachable (set SITE_IDENTITY_FE_PUBLIC)', timeout: 280_000 }, async () => {
	const e = await env(); await reset(e);
	const mg = (await mkStaff(e, ['site.manage'], 'bb')).user; const m = await mount(e, { isWired: (k) => WIRED_KEYS.includes(k) });
	const published: Record<string, string> = {};
	for (const d of BEBO) {
		const real = realFile(d); const variant = variantOf(real, d.key);
		// 1. the unmodified default file is accepted as a custom version and published
		const u1 = await m.upload(mg.id, d.key, real, 'image/png', 'default.png'); assert.equal(u1.status, 201, `${d.key} default upload: ${JSON.stringify(u1.json)}`); assert.equal(u1.json.data.sha256, d.defaultFingerprint.sha256);
		const p1 = await publish(m, mg.id, d.key, u1.json.data.versionId, 0); assert.equal(p1.status, 200, `${d.key}: ${JSON.stringify(p1.json)}`);
		// 2. a changed copy replaces it; the public route serves exactly its bytes
		const u2 = await m.upload(mg.id, d.key, variant, 'image/png', 'variant.png'); assert.equal(u2.status, 201, `${d.key} variant upload: ${JSON.stringify(u2.json)}`); assert.equal(u2.json.data.width, 1774);
		const p2 = await publish(m, mg.id, d.key, u2.json.data.versionId, p1.json.data.stateVersion); assert.equal(p2.status, 200);
		const man = (await m.pub('')).json.data.items[d.key]; assert.equal(man.sha256, sha(variant), `${d.key} manifest`); assert.equal(man.width, 1774); assert.equal(man.height, 887); assert.equal(man.mime, 'image/png'); assert.equal(man.url, `/public/site-identity/assets/${d.key}/${sha(variant)}`);
		const a = await m.pub(`/assets/${d.key}/${sha(variant)}`); assert.equal(a.status, 200, d.key); assert.equal(a.headers.get('content-type'), 'image/png'); assert.equal(sha(a.buf), sha(variant), `${d.key} served bytes`); assert.equal(a.buf.length, variant.length);
		assert.equal(a.headers.get('x-content-type-options'), 'nosniff'); assert.match(a.headers.get('cache-control')!, /immutable/);
		// 3. restore the first (default-identical) custom version, then the built-in default
		const r1 = await m.adm('POST', `/${d.key}/restore`, mg.id, { target: u1.json.data.versionId, expectedVersion: p2.json.data.stateVersion }); assert.equal(r1.status, 200, `${d.key} restore v1`);
		assert.equal((await m.pub('')).json.data.items[d.key].sha256, d.defaultFingerprint.sha256); assert.equal(sha((await m.pub(`/assets/${d.key}/${d.defaultFingerprint.sha256}`)).buf), d.defaultFingerprint.sha256);
		// the superseded variant is still served (an open page keeps its URL)
		assert.equal((await m.pub(`/assets/${d.key}/${sha(variant)}`)).status, 200);
		const r2 = await m.adm('POST', `/${d.key}/restore`, mg.id, { target: 'default', expectedVersion: r1.json.data.stateVersion }); assert.equal(r2.status, 200); assert.equal(r2.json.data.isDefault, true);
		assert.equal((await m.pub('')).json.data.items[d.key], undefined, `${d.key} back to the built-in default: not listed`);
		// leave the variant published for the set-restore step
		const u3 = await m.upload(mg.id, d.key, variantOf(real, d.key + '-final'), 'image/png', 'final.png'); const p3 = await publish(m, mg.id, d.key, u3.json.data.versionId, r2.json.data.stateVersion); assert.equal(p3.status, 200); published[d.key] = sha(variantOf(real, d.key + '-final'));
	}
	const all = (await m.pub('')).json.data; assert.deepEqual(Object.keys(all.items).sort(), BEBO.map(d => d.key).sort(), 'all 14 listed'); for (const d of BEBO) assert.equal(all.items[d.key].sha256, published[d.key]);
	const pv = await m.adm('GET', '/restore-set/0/preview', mg.id); assert.equal(pv.json.data.items.filter((i: any) => i.change === 'to-default' && i.key.startsWith('character.bebo.')).length, 14);
	const rs = await m.adm('POST', '/restore-set', mg.id, { manifestVersion: 0, expectedManifestVersion: pv.json.data.currentManifestVersion, previewDigest: pv.json.data.previewDigest }); assert.equal(rs.status, 200, JSON.stringify(rs.json).slice(0, 300));
	assert.deepEqual((await m.pub('')).json.data.items, {}, 'all 14 back to the built-in defaults');
	await m.close();
});

test('PG round5 bebo: png polyglot guard - an embedded <svg> thumbnail inside the C2PA caBX chunk is tolerated (the real default atlases carry one), anywhere else it is refused', opts, async () => {
	const { png } = await import('../testing/site-identity.pgenv');
	const def = identityDef('character.bebo.traffic')!; const base = png(1774, 887);
	const withChunk = (type: string, data: string) => Buffer.concat([base.subarray(0, 33), chunk(type, Buffer.from(data, 'latin1')), base.subarray(33)]);
	assert.equal((await validateIdentityUpload(def, withChunk('caBX', 'jumb....<svg width="1"></svg>'), 'image/png')).width, 1774);
	for (const [type, data] of [['tEXt', 'k\0<svg onload=alert(1)>'], ['iTXt', 'x<svg>'], ['caBX', 'x<script>alert(1)</script>'], ['caBX', 'javascript:alert(1)'], ['caBX', '<!DOCTYPE html>'], ['zzZz', '<svg>']] as const)
		await assert.rejects(validateIdentityUpload(def, withChunk(type, data), 'image/png'), (er: any) => er.reason === 'POLYGLOT', `${type}: ${data.slice(0, 20)}`);
});

// ---------------------------------------------------------------------------------------------------------------- rollback.sql guard
test('PG round5 rollback.sql: the guard block raises while ANY site_identity_* table has rows, passes on empty tables, and sits before the first DROP (the DROPs are never run here)', opts, async () => {
	const e = await env(); await reset(e);
	const file = fs.readFileSync(path.resolve(__dirname, '../../prisma/migrations/20261027150000_site_identity/rollback.sql'), 'utf8');
	const guardStart = file.indexOf('DO $guard$'); const guardEnd = file.indexOf('$guard$;', guardStart) + '$guard$;'.length;
	assert.ok(guardStart > 0 && guardEnd > guardStart, 'guard block present'); assert.ok(guardEnd < file.indexOf('DROP TABLE'), 'guard precedes every DROP');
	assert.ok(/^BEGIN;/m.test(file) && /COMMIT;\s*$/.test(file.trim()), 'one transaction: a raised guard drops nothing');
	assert.match(file, /DO NOT RUN THIS AFTER THE FEATURE WAS USED/); assert.match(file, /swapping the code containers only/);
	const guard = file.slice(guardStart, guardEnd).replace('$guard$;', '$guard$');
	const run = () => e.prisma.$executeRawUnsafe(guard);
	await run(); // empty: no throw
	const mg = (await mkStaff(e, ['site.manage'], 'rb')).user; const m = await mount(e, { isWired: (k) => WIRED_KEYS.includes(k) });
	const up = await m.upload(mg.id, 'logo.mark', (await import('../testing/site-identity.pgenv')).png(300, 200, { text: 'rb' })); assert.equal(up.status, 201);
	await assert.rejects(run(), /rollback\.sql refused: table site_identity_assets has 1 row/, 'a single STAGED row is enough');
	await m.adm('DELETE', `/logo.mark/versions/${up.json.data.versionId}`, mg.id); // discarded row stays (bytes dropped) -> still refuses
	await assert.rejects(run(), /rollback\.sql refused/);
	await e.prisma.siteIdentityAsset.deleteMany({}); await run();
	await e.prisma.siteIdentityManifest.create({ data: { version: 1, snapshot: {}, reason: 'x' } }); await assert.rejects(run(), /site_identity_manifest/);
	await e.prisma.siteIdentityManifest.deleteMany({}); await e.prisma.siteIdentityState.create({ data: { key: 'logo.mark', version: 1 } }); await assert.rejects(run(), /site_identity_state/);
	await reset(e); await run();
	await m.close();
});
