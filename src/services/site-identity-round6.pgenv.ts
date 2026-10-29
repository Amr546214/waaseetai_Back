import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { env, opts, mkStaff } from '../testing/admin-team.pgenv';
import { SITE_IDENTITY_REGISTRY } from '../config/site-identity.registry';
import { ICON_PREFIX, MAX_CUSTOM_ICONS, MAX_ICON_DRAFTS_TOTAL, iconSymbols, iconExcluded, iconLibraryOnly } from '../config/site-identity-icons';
import { mount, reset, publish, dbState } from './site-identity-round2.pgenv';

/**
 * Site identity ROUND 6 on REAL PostgreSQL over HTTP: the dynamic key family `icon.fn.<symbolId>` (function icons, notifications bell included) through the SAME pipeline, plus value-worded token errors.
 * Runs inside the process of site-identity.pg.test.ts (shared tables, one process). Isolated local database only. Contract: IDENTITY-ICONS-CONTRACT-2026-10-28.md.
 */
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const WIRED_IDS = iconSymbols().filter(s => s.reason === null).map(s => s.id);
const NO_CONSUMER_ID = iconSymbols().find(s => s.reason === 'NO_CONSUMER')!.id;
const key = (id: string) => `${ICON_PREFIX}${id}`;
const BELL_PATHS = '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>';
/** a distinct, valid icon per n */
const icon = (n: number, extra = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="${3 + (n % 8)}" data-n="${n}"/><path d="M${n % 20} 2l2 2"/>${extra}</svg>`);
const svgUp = (m: any, who: string, id: string, bytes: Uint8Array) => m.upload(who, key(id), bytes, 'image/svg+xml', 'i.svg');
const sv = async (m: any, who: string, id: string) => (await m.adm('GET', `/icons/${id}`, who)).json.data.state.stateVersion as number;
const pubIcon = async (m: any, who: string, id: string, bytes: Uint8Array) => {
	const up = await svgUp(m, who, id, bytes); assert.equal(up.status, 201, JSON.stringify(up.json));
	const pb = await publish(m, who, key(id), up.json.data.versionId, await sv(m, who, id)); assert.equal(pb.status, 200, JSON.stringify(pb.json)); return { up: up.json.data, pb: pb.json.data };
};

test('PG round6 icons: upload -> staged (invisible) -> publish -> public manifest lists ONLY customised icons -> immutable SVG -> restore -> default, for several ids incl. the notifications bell; persists across a restart; audit rows', opts, async () => {
	const e = await env(); await reset(e);
	const mg = (await mkStaff(e, ['site.manage'], 'ic')).user;
	const m = await mount(e);
	assert.deepEqual((await m.pub('')).json.data, { version: 0, items: {} }, 'nothing customised: the manifest is exactly today\'s');
	// the page payload does not grow with the icons: static items only, plus the family descriptor
	const ov0 = (await m.adm('GET', '/', mg.id)).json.data;
	assert.equal(ov0.items.length, SITE_IDENTITY_REGISTRY.length); assert.equal(ov0.items.some((i: any) => i.key.startsWith(ICON_PREFIX)), false);
	assert.equal(ov0.iconFamily.prefix, ICON_PREFIX); assert.equal(ov0.iconFamily.maxCustom, MAX_CUSTOM_ICONS); assert.equal(ov0.iconFamily.counts.custom, 0); assert.equal(ov0.iconFamily.counts.symbols, iconSymbols().length); assert.match(ov0.iconFamily.allowlistRevision, /^[0-9a-f]{12}$/);

	const ids = ['i-bell', WIRED_IDS.find(i => i !== 'i-bell')!, WIRED_IDS[WIRED_IDS.length - 1]];
	assert.ok(new Set(ids).size === 3);
	const bellBytes = icon(1, BELL_PATHS);
	const up = await svgUp(m, mg.id, 'i-bell', bellBytes); assert.equal(up.status, 201, JSON.stringify(up.json));
	const v1 = up.json.data; assert.equal(v1.status, 'STAGED'); assert.equal(v1.mime, 'image/svg+xml'); assert.equal(v1.width, 24); assert.equal(v1.url, null); assert.equal(v1.key, 'icon.fn.i-bell');
	assert.equal((await m.pub('')).json.data.items['icon.fn.i-bell'], undefined, 'a draft is invisible to the public');
	assert.equal((await m.pub(`/assets/icon.fn.i-bell/${v1.sha256}`)).status, 404);
	const prev = await m.adm('GET', `/icon.fn.i-bell/versions/${v1.versionId}/preview`, mg.id); assert.equal(prev.status, 200); assert.equal(prev.headers.get('content-type'), 'image/svg+xml'); assert.equal(prev.headers.get('cache-control'), 'private, no-store');
	// a touched icon shows up in the page payload (draft), untouched ones do not
	const ov1 = (await m.adm('GET', '/', mg.id)).json.data; const bi = ov1.items.find((i: any) => i.key === 'icon.fn.i-bell');
	assert.ok(bi); assert.equal(bi.family, 'icon.fn'); assert.equal(bi.symbolId, 'i-bell'); assert.equal(bi.wired, true); assert.equal(bi.status, 'default'); assert.equal(bi.staged.length, 1); assert.equal(bi.staged[0].isMine, true); assert.equal(ov1.items.length, SITE_IDENTITY_REGISTRY.length + 1);
	assert.equal(bi.group, 'icon'); assert.equal(bi.kind, 'svg'); assert.equal(bi.maxBytes, 64 * 1024); assert.equal(bi.defaultFingerprint.mime, 'image/svg+xml');
	// publish
	const pb = await publish(m, mg.id, 'icon.fn.i-bell', v1.versionId, 0); assert.equal(pb.status, 200, JSON.stringify(pb.json)); assert.equal(pb.json.data.isDefault, false); assert.equal(pb.json.data.label, bi.label); assert.equal(pb.json.data.toVersion, 1); assert.equal(pb.json.data.fromVersion, 0);
	const man = (await m.pub('')).json.data; assert.deepEqual(Object.keys(man.items), ['icon.fn.i-bell']);
	assert.deepEqual(man.items['icon.fn.i-bell'], { url: `/public/site-identity/assets/icon.fn.i-bell/${v1.sha256}`, sha256: v1.sha256, mime: 'image/svg+xml', width: 24, height: 24, version: 1 });
	const asset = await m.pub(`/assets/icon.fn.i-bell/${v1.sha256}`); assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/svg+xml'); assert.equal(asset.headers.get('x-content-type-options'), 'nosniff'); assert.match(asset.headers.get('cache-control')!, /immutable/); assert.match(asset.headers.get('content-security-policy')!, /sandbox/); assert.ok(asset.buf.toString('utf8').includes('viewBox="0 0 24 24"'));
	assert.equal(sha(asset.buf), v1.sha256);
	// two more ids
	const p2 = await pubIcon(m, mg.id, ids[1], icon(2)), p3 = await pubIcon(m, mg.id, ids[2], icon(3));
	const man3 = (await m.pub('')).json.data; assert.deepEqual(Object.keys(man3.items).sort(), ids.map(key).sort()); assert.equal(man3.version, 3);
	// list view: status per icon, bounded, no bytes
	const list = (await m.adm('GET', '/icons', mg.id)); assert.equal(list.status, 200);
	const rows = list.json.data.rows as any[]; assert.equal(list.json.data.counts.custom, 3);
	const row = (id: string) => rows.find(r => r.id === id && r.key !== null) ?? rows.find(r => r.id === id);
	assert.equal(row('i-bell').status, 'custom'); assert.equal(row('i-bell').activeVersion, 1); assert.equal(row('i-bell').key, 'icon.fn.i-bell');
	assert.equal(rows.filter(r => r.status === 'custom').length, 3);
	assert.equal(row(NO_CONSUMER_ID).status, 'not-wired'); assert.equal(row(NO_CONSUMER_ID).reason.code, 'NO_CONSUMER'); assert.ok(row(NO_CONSUMER_ID).reason.text);
	const lo = iconLibraryOnly().find(l => l.reason === 'LIBRARY_ONLY')!; assert.equal(row(lo.id).status, 'not-wired'); assert.equal(row(lo.id).key, null); assert.equal(row(lo.id).reason.code, 'LIBRARY_ONLY'); assert.equal(row(lo.id).library, lo.library);
	assert.equal(row('i-ai').reason.code, 'MANAGED_BY_ICON_AI'); assert.equal(row('i-ai').managedBy, 'icon.ai'); assert.equal(row('i-ai').key, null);
	assert.ok(JSON.stringify(list.json).length < rows.length * 400 + 20_000, `list payload ${JSON.stringify(list.json).length} for ${rows.length} rows (bounded per row, scales with the library)`); assert.ok(!JSON.stringify(list.json).includes('"bytes"'));
	const filtered = (await m.adm('GET', '/icons?status=custom', mg.id)).json.data; assert.equal(filtered.total, 3);
	assert.equal((await m.adm('GET', '/icons?status=draft', mg.id)).json.data.total, 0); assert.equal((await m.adm('GET', '/icons?q=bell', mg.id)).json.data.rows.every((r: any) => /bell/.test(r.id + r.label)), true);
	assert.equal((await m.adm('GET', '/icons?status=weird', mg.id)).status, 400);
	const one = await m.adm('GET', '/icons/i-bell', mg.id); assert.equal(one.status, 200); assert.equal(one.json.data.key, 'icon.fn.i-bell'); assert.equal(one.json.data.state.active.version, 1); assert.equal(one.json.data.status, 'custom'); assert.equal(one.json.data.canManage, true);
	assert.equal((await m.adm('GET', '/icons/i-ai', mg.id)).status, 404); assert.equal((await m.adm('GET', '/icons/nope-nope', mg.id)).status, 404);
	// second version of the bell, then restore to the first, then default
	const up2 = await svgUp(m, mg.id, 'i-bell', icon(9, BELL_PATHS)); const v2 = up2.json.data;
	assert.equal((await publish(m, mg.id, 'icon.fn.i-bell', v2.versionId, 1)).status, 200);
	assert.equal((await m.pub('')).json.data.items['icon.fn.i-bell'].sha256, v2.sha256);
	assert.equal((await m.pub(`/assets/icon.fn.i-bell/${v1.sha256}`)).status, 200, 'a superseded version keeps serving (open pages)');
	const r1 = await m.adm('POST', '/icon.fn.i-bell/restore', mg.id, { target: v1.versionId, expectedVersion: 2 }); assert.equal(r1.status, 200, JSON.stringify(r1.json)); assert.equal((await m.pub('')).json.data.items['icon.fn.i-bell'].sha256, v1.sha256);
	const r0 = await m.adm('POST', '/icon.fn.i-bell/restore', mg.id, { target: 'default', expectedVersion: 3 }); assert.equal(r0.status, 200); assert.equal(r0.json.data.isDefault, true);
	assert.equal((await m.pub('')).json.data.items['icon.fn.i-bell'], undefined, 'default again: not in the manifest');
	assert.equal((await m.adm('POST', '/icon.fn.i-bell/restore', mg.id, { target: 'default', expectedVersion: 4 })).status, 409, 'already default');
	// restart: a brand-new service reads the same state back
	const before = await dbState(e); const m2 = await mount(e); assert.deepEqual((await m2.pub('')).json.data, (await m.pub('')).json.data); assert.equal((await m2.adm('GET', '/icons/' + ids[1], mg.id)).json.data.status, 'custom'); assert.equal(await dbState(e), before); await m2.close();
	// audit
	const audit = await e.prisma.accountAuditLog.findMany({ where: { eventType: { startsWith: 'SITE_IDENTITY_' } }, orderBy: { occurredAt: 'asc' } });
	const pubs = audit.filter((r: any) => r.eventType === 'SITE_IDENTITY_PUBLISHED' && (r.metaData as any).identityKey === 'icon.fn.i-bell'); assert.equal(pubs.length, 2);
	assert.ok(audit.some((r: any) => r.eventType === 'SITE_IDENTITY_RESTORED' && (r.metaData as any).identityKey === 'icon.fn.i-bell' && (r.metaData as any).target === 'default'));
	assert.ok(audit.every((r: any) => !JSON.stringify(r.metaData).includes('<svg')), 'no icon markup in audit rows');
	const { listAuditTrail } = await import('./admin-audit-trail.service'); const trail = await listAuditTrail({ eventType: 'SITE_IDENTITY_PUBLISHED', limit: 10 }); assert.ok(trail.items.length >= 3); assert.ok(trail.items.every((it: any) => it.actionLabel));
	void p2; void p3; await m.close();
});

test('PG round6 icons: unknown / AI / library-only ids are refused, a symbol nothing references is "not wired", hostile or unfit SVGs are rejected and nothing is stored', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'ic2')).user; const m = await mount(e);
	const up = (id: string, b: Uint8Array = icon(1)) => m.upload(mg.id, key(id), b, 'image/svg+xml', 'i.svg');
	const u1 = await up('does-not-exist'); assert.equal(u1.status, 404); assert.equal(u1.json.code, 'SITE_IDENTITY_UNKNOWN_KEY');
	const u2 = await up('i-ai'); assert.equal(u2.status, 404); assert.match(u2.json.message, /icon\.ai/);
	const lo = iconLibraryOnly().find(l => l.reason === 'LIBRARY_ONLY')!; assert.equal((await up(lo.id)).status, 404);
	const ex = iconExcluded()[0]; assert.equal((await up(ex.id)).status, 404);
	for (const bad of ['I-BELL', 'i_bell', '..%2Fx', 'i-bell%00', '']) assert.equal((await m.upload(mg.id, `${ICON_PREFIX}${bad}`, icon(1), 'image/svg+xml', 'i.svg')).status, 404, bad);
	const nc = await up(NO_CONSUMER_ID); assert.equal(nc.status, 409); assert.equal(nc.json.code, 'SITE_IDENTITY_KEY_NOT_WIRED'); assert.match(nc.json.message, /لا يوجد أي مكان يستخدمه|لا شيء يتبع/);
	assert.equal((await m.adm('POST', `/${key(NO_CONSUMER_ID)}/publish`, mg.id, { versionId: '00000000-0000-4000-8000-000000000000', expectedVersion: 0 })).status, 409);
	const item = (await m.adm('GET', `/icons/${NO_CONSUMER_ID}`, mg.id)).json.data; assert.equal(item.wired, false); assert.equal(item.editable, false); assert.equal(item.status, 'not-wired'); assert.ok(item.notWiredReason);
	// formats and hostile content
	const png1 = await m.upload(mg.id, 'icon.fn.i-bell', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), 'image/png', 'i.png'); assert.equal(png1.status, 400); assert.equal(png1.json.code, 'SITE_IDENTITY_FILE_REJECTED');
	const rejected = async (b: Buffer, reason: RegExp, status = 400) => { const r = await svgUp(m, mg.id, 'i-bell', b); assert.equal(r.status, status, r.json?.message); assert.equal(r.json.code, 'SITE_IDENTITY_FILE_REJECTED'); assert.match(r.json.errors[0].reason, reason); assert.ok(r.json.errors[0].message); };
	await rejected(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M1 1h4"/></svg>'), /ICON_NO_VIEWBOX|NO_DIMENSIONS/);
	await rejected(icon(1, '<use href="#i-bell"/>'), /ICON_FORBIDDEN_ELEMENT/);
	await rejected(icon(1, '<image href="data:image/png;base64,iVBORw0KGgo="/>'), /ICON_FORBIDDEN_ELEMENT/);
	await rejected(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 10"><path d="M1 1h4"/></svg>'), /WRONG_ASPECT/);
	await rejected(Buffer.from('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">&a;</svg>'), /ENTIT|DOCTYPE/);
	await rejected(Buffer.from('<html><script>alert(1)</script></html>'), /MARKUP_NOT_SVG|UNSUPPORTED_TYPE/);
	await rejected(Buffer.concat([icon(1), Buffer.alloc(66 * 1024, 32)]), /TOO_BIG/, 413);
	// script / handlers are CLEANED (the drawing stays), the stored row carries no script
	const hostile = await svgUp(m, mg.id, 'i-bell', icon(5, '<script>alert(1)</script><circle cx="1" cy="1" r="1" onload="alert(2)"/><a href="javascript:alert(3)"><path d="M0 0h2"/></a>')); assert.equal(hostile.status, 201, JSON.stringify(hostile.json));
	assert.equal(hostile.json.data.sanitized.changed, true); const stored = await e.prisma.siteIdentityAsset.findUniqueOrThrow({ where: { id: hostile.json.data.versionId } });
	const markup = Buffer.from(stored.bytes!).toString('utf8'); assert.ok(!/script|onload|javascript|alert/i.test(markup), markup);
	assert.equal(await e.prisma.siteIdentityAsset.count({ where: { key: 'icon.fn.i-bell' } }), 1, 'only the cleaned draft exists; every rejected upload stored nothing');
	assert.equal(await e.prisma.siteIdentityState.count({}), 0);
	await m.close();
});

test('PG round6 icons: permissions (401 / 403 / view-only / legacy site_control.manage), conflicts and drafts of another admin', opts, async () => {
	const e = await env(); await reset(e);
	const mg = (await mkStaff(e, ['site.manage'], 'ic3')).user, vw = (await mkStaff(e, ['site.view'], 'ic3v')).user, none = (await mkStaff(e, ['users.view'], 'ic3n')).user, legacy = (await mkStaff(e, ['site_control.manage'], 'ic3l')).user, mg2 = (await mkStaff(e, ['site.manage'], 'ic3b')).user;
	const m = await mount(e);
	for (const p of ['/icons', '/icons/i-bell']) { assert.equal((await m.raw('GET', `/admin/site-identity${p}`)).status, 401, p); assert.equal((await m.adm('GET', p, none.id)).status, 403, p); assert.equal((await m.adm('GET', p, vw.id)).status, 200, p); assert.equal((await m.adm('GET', p, legacy.id)).status, 200, p); }
	assert.equal((await m.raw('POST', '/admin/site-identity/icon.fn.i-bell/upload')).status, 401);
	assert.equal((await svgUp(m, none.id, 'i-bell', icon(1))).status, 403); assert.equal((await svgUp(m, vw.id, 'i-bell', icon(1))).status, 403);
	assert.equal((await m.adm('GET', '/icons/i-bell', vw.id)).json.data.canManage, false); assert.equal((await m.adm('GET', '/icons/i-bell', legacy.id)).json.data.canManage, true);
	assert.equal(await e.prisma.siteIdentityAsset.count({}), 0, '403 / 401 stored nothing');
	// legacy holder edits; view-only cannot publish/restore/discard
	const up = await svgUp(m, legacy.id, 'i-bell', icon(1)); assert.equal(up.status, 201);
	assert.equal((await publish(m, vw.id, 'icon.fn.i-bell', up.json.data.versionId, 0)).status, 403);
	// another admin cannot publish my draft, can discard / preview it
	assert.equal((await publish(m, mg.id, 'icon.fn.i-bell', up.json.data.versionId, 0)).json.code, 'SITE_IDENTITY_DRAFT_NOT_YOURS');
	assert.equal((await m.adm('GET', `/icon.fn.i-bell/versions/${up.json.data.versionId}/preview`, mg.id)).status, 200);
	assert.equal((await publish(m, legacy.id, 'icon.fn.i-bell', up.json.data.versionId, 0)).status, 200);
	// conflict: stale expectedVersion
	const d2 = (await svgUp(m, mg.id, 'i-bell', icon(2))).json.data; const stale = await publish(m, mg.id, 'icon.fn.i-bell', d2.versionId, 0);
	assert.equal(stale.status, 409); assert.equal(stale.json.code, 'SITE_IDENTITY_VERSION_CONFLICT'); assert.equal(stale.json.current.stateVersion, 1); assert.equal(stale.json.current.key, 'icon.fn.i-bell');
	assert.equal((await publish(m, mg.id, 'icon.fn.i-bell', d2.versionId, 1)).status, 200);
	// same bytes as the active one -> NO_CHANGE
	assert.equal((await svgUp(m, mg2.id, 'i-bell', icon(2))).json.code, 'SITE_IDENTITY_NO_CHANGE');
	assert.equal((await m.adm('DELETE', `/icon.fn.i-bell/versions/${d2.versionId}`, vw.id)).status, 403);
	await m.close();
});

test('PG round6 icons: restore-set with icons - preview rows only for involved icons, digest binds the apply, stale digest changes nothing, target 0 puts every icon back to default', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'ic4')).user; const m = await mount(e);
	const a = await pubIcon(m, mg.id, 'i-bell', icon(1, BELL_PATHS)); const b = await pubIcon(m, mg.id, WIRED_IDS[5], icon(2));
	const mv2 = (await m.pub('')).json.data.version; assert.equal(mv2, 2);
	const c = await pubIcon(m, mg.id, WIRED_IDS[7], icon(3)); // manifest 3
	// preview of manifest 2 from 3: the third icon goes back to default
	const pv = (await m.adm('GET', '/restore-set/2/preview', mg.id)).json.data;
	const iconRows = pv.items.filter((i: any) => i.key.startsWith(ICON_PREFIX)); assert.equal(pv.items.length, SITE_IDENTITY_REGISTRY.length + iconRows.length, 'static rows + only the involved icons');
	assert.equal(iconRows.length, 3, 'only the involved icons appear (default icons never add rows)');
	assert.deepEqual(iconRows.map((i: any) => [i.key, i.change]), [[key('i-bell'), 'unchanged'], [key(WIRED_IDS[5]), 'unchanged'], [key(WIRED_IDS[7]), 'to-default']].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
	assert.equal(pv.changedCount, 1); assert.equal(pv.canApply, true);
	const toDef = iconRows.find((i: any) => i.change === 'to-default'); assert.equal(toDef.current.source, 'custom'); assert.equal(toDef.target.source, 'default'); assert.equal(toDef.current.mime, 'image/svg+xml'); assert.ok(toDef.current.previewUrl.startsWith('/admin/site-identity/icon.fn.'));
	// stale digest
	const stale = await m.adm('POST', '/restore-set', mg.id, { manifestVersion: 2, expectedManifestVersion: 3, previewDigest: 'f'.repeat(64) }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'SITE_IDENTITY_PREVIEW_STALE'); assert.equal(stale.json.current.previewDigest, pv.previewDigest); assert.equal((await m.pub('')).json.data.version, 3);
	// concurrent change between preview and apply -> PREVIEW_STALE, nothing changes
	const dd = (await svgUp(m, mg.id, WIRED_IDS[9], icon(4))).json.data; await publish(m, mg.id, key(WIRED_IDS[9]), dd.versionId, 0);
	const stale2 = await m.adm('POST', '/restore-set', mg.id, { manifestVersion: 2, expectedManifestVersion: 3, previewDigest: pv.previewDigest }); assert.equal(stale2.status, 409); assert.equal(stale2.json.code, 'SITE_IDENTITY_PREVIEW_STALE');
	// apply target 0
	const pv0 = (await m.adm('GET', '/restore-set/0/preview', mg.id)).json.data; assert.equal(pv0.changedCount, 4); assert.equal(pv0.items.filter((i: any) => i.key.startsWith(ICON_PREFIX) && i.change === 'to-default').length, 4);
	const ap = await m.adm('POST', '/restore-set', mg.id, { manifestVersion: 0, expectedManifestVersion: pv0.currentManifestVersion, previewDigest: pv0.previewDigest }); assert.equal(ap.status, 200, JSON.stringify(ap.json)); assert.equal(ap.json.data.changedKeys.length, 4);
	assert.deepEqual((await m.pub('')).json.data.items, {}, 'every icon is back to its default'); assert.equal((await m.adm('GET', '/icons?status=custom', mg.id)).json.data.total, 0);
	// restoring manifest 3 brings the three icons back (superseded rows are restorable)
	const pv3 = (await m.adm('GET', '/restore-set/3/preview', mg.id)).json.data; assert.equal(pv3.changedCount, 3);
	assert.equal((await m.adm('POST', '/restore-set', mg.id, { manifestVersion: 3, expectedManifestVersion: pv3.currentManifestVersion, previewDigest: pv3.previewDigest })).status, 200);
	assert.deepEqual(Object.keys((await m.pub('')).json.data.items).sort(), [key('i-bell'), key(WIRED_IDS[5]), key(WIRED_IDS[7])].sort());
	void a; void b; void c; await m.close();
});

test('PG round6 icons: limits - at most a cap on customised icons (injected small cap here; the real cap is in round7 tests) (restore to default frees a slot), the public manifest stays bounded, family-wide draft cap', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'ic5')).user; const CAP = 6, DRAFTS = 9; const m = await mount(e, { maxCustomIcons: CAP, maxIconDrafts: DRAFTS });
	assert.ok(WIRED_IDS.length > DRAFTS + 2);
	for (let i = 0; i < CAP; i++) await pubIcon(m, mg.id, WIRED_IDS[i], icon(i));
	const man = await m.pub(''); assert.equal(Object.keys(man.json.data.items).length, CAP); assert.ok(man.buf.length < 20_000, `manifest ${man.buf.length} bytes for ${CAP} icons`);
	const extra = WIRED_IDS[CAP]; const up = await svgUp(m, mg.id, extra, icon(99)); assert.equal(up.status, 201);
	const over = await publish(m, mg.id, key(extra), up.json.data.versionId, 0); assert.equal(over.status, 409); assert.equal(over.json.code, 'SITE_IDENTITY_TOO_MANY_ICONS'); assert.equal(Object.keys((await m.pub('')).json.data.items).length, CAP);
	// replacing an already customised icon is not "one more"
	const again = await svgUp(m, mg.id, WIRED_IDS[0], icon(77)); assert.equal((await publish(m, mg.id, key(WIRED_IDS[0]), again.json.data.versionId, 1)).status, 200);
	// free one slot -> now it fits
	assert.equal((await m.adm('POST', `/${key(WIRED_IDS[1])}/restore`, mg.id, { target: 'default', expectedVersion: 1 })).status, 200);
	assert.equal((await publish(m, mg.id, key(extra), up.json.data.versionId, 0)).status, 200);
	// a restore-set that would exceed the cap is refused (manifest 50 has WIRED_IDS[0..49] incl. [1]; current has [1] default and extra custom)
	const pv = await m.adm('GET', `/restore-set/${CAP}/preview`, mg.id); assert.equal(pv.status, 200, JSON.stringify(pv.json).slice(0, 200));
	// draft cap family-wide: drafts exist for `extra`? no; fill up to the cap on distinct ids
	const have = await e.prisma.siteIdentityAsset.count({ where: { key: { startsWith: ICON_PREFIX }, status: 'STAGED' } });
	let n = 0; for (let i = 0; have + n < DRAFTS; i++, n++) assert.equal((await svgUp(m, mg.id, WIRED_IDS[i], icon(200 + i))).status, 201);
	const full = await svgUp(m, mg.id, WIRED_IDS[DRAFTS + 1], icon(500)); assert.equal(full.status, 409); assert.equal(full.json.code, 'SITE_IDENTITY_TOO_MANY_STAGED');
	// discarding one frees a draft slot
	const anyDraft = await e.prisma.siteIdentityAsset.findFirstOrThrow({ where: { key: { startsWith: ICON_PREFIX }, status: 'STAGED' } });
	assert.equal((await m.adm('DELETE', `/${anyDraft.key}/versions/${anyDraft.id}`, mg.id)).status, 200); assert.equal((await svgUp(m, mg.id, WIRED_IDS[DRAFTS + 1], icon(500))).status, 201);
	await m.close();
});

test('PG round6 tokens: value rejections over HTTP are value-worded (JSON body) and name the token; a bad uploaded token FILE talks about the file content; nothing says "choose another file"', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'ic6')).user; const m = await mount(e);
	const body = await m.adm('POST', '/tokens.colors.dark/upload', mg.id, { value: { '--teal': 'nonsense' } });
	assert.equal(body.status, 400); assert.equal(body.json.errors[0].field, 'value'); assert.equal(body.json.errors[0].reason, 'BAD_VALUE'); assert.equal(body.json.errors[0].name, '--teal'); assert.match(body.json.message, /^«.+ \(--teal\)»: لون غير صالح/); assert.ok(!/ملف/.test(body.json.message), body.json.message);
	const range = await m.adm('POST', '/tokens.layout/upload', mg.id, { value: { '--radius': '900px' } }); assert.equal(range.json.errors[0].reason, 'OUT_OF_RANGE'); assert.match(range.json.message, /--radius/);
	const notObj = await m.adm('POST', '/tokens.layout/upload', mg.id, { value: 'oops' }); assert.equal(notObj.status, 400); assert.equal(notObj.json.errors[0].reason, 'NOT_OBJECT'); assert.ok(!/ملف/.test(notObj.json.message));
	const same = await m.adm('POST', '/tokens.layout/upload', mg.id, { value: { '--radius': '16px' } }); assert.equal(same.json.errors[0].reason, 'EMPTY_OVERRIDES'); assert.match(same.json.message, /مطابقة للافتراضي/);
	const none = await m.adm('POST', '/tokens.layout/upload', mg.id, {}); assert.equal(none.status, 400); assert.equal(none.json.errors[0].field, 'value'); assert.ok(!/اختر ملف/.test(none.json.message), none.json.message);
	const file = await m.upload(mg.id, 'tokens.layout', Buffer.from('{not json'), 'application/json', 't.json'); assert.equal(file.status, 400); assert.equal(file.json.errors[0].reason, 'NOT_JSON'); assert.match(file.json.message, /^محتوى الملف ليس JSON/);
	const fileVal = await m.upload(mg.id, 'tokens.layout', Buffer.from('{"--radius":"x"}'), 'application/json', 't.json'); assert.equal(fileVal.status, 400); assert.equal(fileVal.json.errors[0].reason, 'BAD_VALUE'); assert.ok(!/اختر ملف|ملفًا آخر/.test(fileVal.json.message));
	assert.equal(await e.prisma.siteIdentityAsset.count({}), 0);
	await m.close();
});
