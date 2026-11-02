import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { env, opts, mkStaff } from '../testing/admin-team.pgenv';
import { ico, jpeg, png } from '../testing/site-identity.pgenv';
import { ICON_PREFIX, MAX_CUSTOM_ICONS, iconSymbols } from '../config/site-identity-icons';
import { iconFamilies } from '../config/site-identity-icon-families';
import { identityDef } from '../config/site-identity.registry';
import { DEFAULT_ASSETS } from '../config/site-identity-default-assets.generated';
import { mount, reset, publish, dbState } from './site-identity-round2.pgenv';

/**
 * Site identity ROUND 7 on REAL PostgreSQL over HTTP: icon FAMILIES (same file for all keys, atomic preview/publish/restore with per-key expected versions and a digest), the raised icon cap and the public
 * manifest with EVERY wired icon id customised (size, gzip, parse time, ETag/304), and the two public alias routes (social.og, favicon.ico). Runs inside the process of site-identity.pg.test.ts.
 * Isolated local database only. Contract: IDENTITY-ROUND7-CONTRACT-2026-10-28.md
 */
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const FAM = iconFamilies()[0]; // notifications-bell
const KEYS = FAM.members.map(m => m.key);
const svg = (n: number, extra = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><circle cx="12" cy="${4 + (n % 10)}" r="1" data-n="${n}"/>${extra}</svg>`);
const famUpload = (m: any, who: string, bytes: Uint8Array, keys?: string[], id = FAM.id, mime = 'image/svg+xml', name = 'b.svg') => {
	const f = new FormData(); f.append('file', new Blob([bytes], { type: mime }), name); if (keys) f.append('keys', JSON.stringify(keys)); return m.adm('POST', `/families/${id}/upload`, who, f);
};
const ev = (items: any[]) => Object.fromEntries(items.map(i => [i.key, i.stateVersion]));
/** the page flow: upload -> preview -> returns the apply body */
const flow = async (m: any, who: string, bytes: Uint8Array, keys?: string[]) => {
	const up = await famUpload(m, who, bytes, keys); assert.equal(up.status, 201, JSON.stringify(up.json));
	const drafts = up.json.data.drafts.map((d: any) => ({ key: d.key, versionId: d.versionId }));
	const pv = await m.adm('POST', `/families/${FAM.id}/preview`, who, { mode: 'publish', drafts }); assert.equal(pv.status, 200, JSON.stringify(pv.json));
	return { up: up.json.data, pv: pv.json.data, body: { drafts, expectedVersions: ev(pv.json.data.items), previewDigest: pv.json.data.previewDigest } };
};
const auditRows = (e: any, type: string) => e.prisma.accountAuditLog.findMany({ where: { eventType: type }, orderBy: { occurredAt: 'asc' } });
const getRaw = (base: string, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
	http.get(base + path, { headers: { connection: 'close', ...headers } }, res => { const c: Buffer[] = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c) })); }).on('error', reject);
});

test('PG round7 families: list/item shapes, GET needs read permission, icon rows carry familyId', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'f1')).user, vw = (await mkStaff(e, ['site.view'], 'f1v')).user; const m = await mount(e);
	const list = await m.adm('GET', '/families', vw.id); assert.equal(list.status, 200);
	const f = list.json.data.families.find((x: any) => x.id === FAM.id); assert.ok(f); assert.equal(f.members.length, FAM.members.length); assert.equal(f.uniform, true); assert.equal(f.counts.custom, 0);
	assert.deepEqual(f.members.map((x: any) => x.key), KEYS); assert.equal(f.members[0].role, 'primary'); assert.match(list.json.data.revision, /^[0-9a-f]{12}$/);
	const one = await m.adm('GET', `/families/${FAM.id}`, mg.id); assert.equal(one.status, 200); assert.equal(one.json.data.members.length, KEYS.length); assert.equal(one.json.data.canManage, true); assert.equal(one.json.data.members[0].key, KEYS[0]); assert.ok(one.json.data.members[0].state && Array.isArray(one.json.data.members[0].staged) && Array.isArray(one.json.data.members[0].history) && one.json.data.members[0].role === 'primary' && one.json.data.members[0].rules.length);
	assert.equal((await m.adm('GET', `/families/${FAM.id}`, vw.id)).json.data.canManage, false);
	assert.equal((await m.adm('GET', '/families/nope', mg.id)).json.code, 'SITE_IDENTITY_FAMILY_NOT_FOUND');
	const icons = (await m.adm('GET', '/icons', mg.id)).json.data.rows as any[]; assert.equal(icons.find(r => r.id === 'i-bell').familyId, FAM.id); assert.equal(icons.find(r => r.id !== 'i-bell' && !FAM.members.some(x => x.symbolId === r.id)).familyId, null);
	const byFam = (await m.adm('GET', `/icons?familyId=${FAM.id}`, mg.id)).json.data; assert.equal(byFam.total, KEYS.length);
	assert.equal((await m.adm('GET', '/icons?familyId=zzz', mg.id)).status, 404);
	assert.equal((await m.adm('GET', '/', mg.id)).json.data.iconFamily.families, iconFamilies().length);
	await m.close();
});

test('PG round7 families: same file staged under every key (same sha), drafts private, preview shows exact diff, atomic publish with per-key audit rows, manifest lists every key, persists across a restart', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'f2')).user; const m = await mount(e);
	const bytes = svg(1);
	const up = await famUpload(m, mg.id, bytes); assert.equal(up.status, 201, JSON.stringify(up.json));
	const d = up.json.data; assert.equal(d.drafts.length, KEYS.length); assert.equal(d.skipped.length, 0); assert.match(d.sha256, /^[0-9a-f]{64}$/);
	const rows = await e.prisma.siteIdentityAsset.findMany({ where: { key: { in: KEYS } } }); assert.equal(rows.length, KEYS.length); assert.ok(rows.every((r: any) => r.status === 'STAGED' && r.sha256 === d.sha256), 'the SAME sanitised bytes under every key');
	assert.deepEqual(rows.map((r: any) => sha(r.bytes)), rows.map(() => d.sha256));
	assert.deepEqual((await m.pub('')).json.data, { version: 0, items: {} }, 'drafts are invisible');
	const up2audit = await auditRows(e, 'SITE_IDENTITY_UPLOADED'); assert.equal(up2audit.length, KEYS.length); assert.deepEqual(up2audit.map((r: any) => r.metaData.identityKey).sort(), [...KEYS].sort()); assert.ok(up2audit.every((r: any) => r.metaData.familyId === FAM.id));
	const drafts = d.drafts.map((x: any) => ({ key: x.key, versionId: x.versionId }));
	const pv = (await m.adm('POST', `/families/${FAM.id}/preview`, mg.id, { mode: 'publish', drafts })).json.data;
	assert.equal(pv.changedCount, KEYS.length); assert.equal(pv.canApply, true); assert.equal(pv.items.length, KEYS.length); assert.ok(pv.items.every((i: any) => i.change === 'replace' && i.current.source === 'default' && i.target.source === 'custom' && i.target.sha256 === d.sha256 && i.stateVersion === 0));
	assert.deepEqual((await m.pub('')).json.data, { version: 0, items: {} }, 'a preview publishes nothing');
	const pb = await m.adm('POST', `/families/${FAM.id}/publish`, mg.id, { drafts, expectedVersions: ev(pv.items), previewDigest: pv.previewDigest });
	assert.equal(pb.status, 200, JSON.stringify(pb.json)); const r = pb.json.data;
	assert.equal(r.manifestVersion, 1, 'ONE manifest row for the whole operation'); assert.equal(r.keys.length, KEYS.length); assert.deepEqual([...r.changedKeys].sort(), [...KEYS].sort()); assert.ok(r.keys.every((k: any) => k.stateVersion === 1 && k.toVersion === 1 && k.fromVersion === 0 && k.isDefault === false));
	assert.equal(await e.prisma.siteIdentityManifest.count(), 1);
	const man = (await m.pub('')).json.data; assert.deepEqual(Object.keys(man.items).sort(), [...KEYS].sort()); for (const k of KEYS) assert.equal(man.items[k].sha256, d.sha256);
	const pa = await auditRows(e, 'SITE_IDENTITY_PUBLISHED'); assert.equal(pa.length, KEYS.length, 'one audit row per key'); assert.ok(pa.every((a: any) => a.userId === mg.id && a.metaData.familyId === FAM.id && a.metaData.batch === 1 && a.metaData.toVersion === 1 && a.metaData.fromSha === 'default'));
	assert.deepEqual(pa.map((a: any) => a.metaData.identityKey).sort(), [...KEYS].sort());
	// persistence: a fresh server over the same database sees the same identity
	await m.close(); const m2 = await mount(e); assert.deepEqual((await m2.pub('')).json.data, man);
	const fam = (await m2.adm('GET', '/families', mg.id)).json.data.families[0]; assert.equal(fam.uniform, true); assert.equal(fam.counts.custom, KEYS.length);
	await m2.close();
});

test('PG round7 families: restore of a family (to default, and per-key targets), restore never deletes rows, a second operation shows from->to versions', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'f3')).user; const m = await mount(e);
	const a = await flow(m, mg.id, svg(1)); assert.equal((await m.adm('POST', `/families/${FAM.id}/publish`, mg.id, a.body)).status, 200);
	const b = await flow(m, mg.id, svg(2)); const pb = await m.adm('POST', `/families/${FAM.id}/publish`, mg.id, b.body); assert.equal(pb.status, 200); assert.ok(pb.json.data.keys.every((k: any) => k.fromVersion === 1 && k.toVersion === 2 && k.stateVersion === 2));
	const rowsBefore = await e.prisma.siteIdentityAsset.count();
	// restore ALL to the first uploaded version (per-key targets)
	const hist = await e.prisma.siteIdentityAsset.findMany({ where: { key: { in: KEYS }, version: 1 } }); const targets = KEYS.map(k => ({ key: k, target: hist.find((h: any) => h.key === k).id }));
	const pv = (await m.adm('POST', `/families/${FAM.id}/preview`, mg.id, { mode: 'restore', targets })).json.data; assert.ok(pv.items.every((i: any) => i.change === 'replace' && i.target.version === 1 && i.current.version === 2));
	const rs = await m.adm('POST', `/families/${FAM.id}/restore`, mg.id, { targets, expectedVersions: ev(pv.items), previewDigest: pv.previewDigest }); assert.equal(rs.status, 200, JSON.stringify(rs.json));
	assert.ok(rs.json.data.keys.every((k: any) => k.toVersion === 1 && k.fromVersion === 2 && k.stateVersion === 3)); assert.equal(Object.values((await m.pub('')).json.data.items as Record<string, any>)[0].sha256, a.up.sha256);
	// restore the whole family to default
	const pv2 = (await m.adm('POST', `/families/${FAM.id}/preview`, mg.id, { mode: 'restore', targets: 'default' })).json.data; assert.equal(pv2.changedCount, KEYS.length); assert.ok(pv2.items.every((i: any) => i.change === 'to-default' && i.target.source === 'default'));
	const rd = await m.adm('POST', `/families/${FAM.id}/restore`, mg.id, { targets: 'default', expectedVersions: ev(pv2.items), previewDigest: pv2.previewDigest }); assert.equal(rd.status, 200, JSON.stringify(rd.json)); assert.ok(rd.json.data.keys.every((k: any) => k.isDefault));
	assert.deepEqual((await m.pub('')).json.data.items, {}); assert.equal(await e.prisma.siteIdentityAsset.count(), rowsBefore, 'a restore deletes nothing');
	// nothing left to restore to default
	assert.equal((await m.adm('POST', `/families/${FAM.id}/preview`, mg.id, { mode: 'restore', targets: 'default' })).json.code, 'SITE_IDENTITY_NO_CHANGE');
	const ra = await auditRows(e, 'SITE_IDENTITY_RESTORED'); assert.equal(ra.length, KEYS.length * 2); assert.ok(ra.every((x: any) => x.metaData.familyId === FAM.id));
	// the old versions are still restorable after a restore-to-default (a superseded version is a valid target)
	const pv3 = (await m.adm('POST', `/families/${FAM.id}/preview`, mg.id, { mode: 'restore', targets: KEYS.map(k => ({ key: k, target: hist.find((h: any) => h.key === k).id })) })).json.data; assert.equal(pv3.changedCount, KEYS.length);
	await m.close();
});

test('PG round7 families: subset keys, skipped when identical to the active file, per-key editing stays independent, all-identical -> NO_CHANGE', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'f4')).user; const m = await mount(e);
	const two = [KEYS[0], KEYS[1]];
	const a = await flow(m, mg.id, svg(5), two); assert.equal(a.up.drafts.length, 2); assert.equal((await m.adm('POST', `/families/${FAM.id}/publish`, mg.id, a.body)).status, 200);
	assert.deepEqual(Object.keys((await m.pub('')).json.data.items).sort(), [...two].sort());
	// the same file again for ALL keys: the two customised ones are skipped
	const up = await famUpload(m, mg.id, svg(5)); assert.equal(up.status, 201); assert.equal(up.json.data.drafts.length, KEYS.length - 2); assert.deepEqual(up.json.data.skipped.map((s: any) => s.key).sort(), [...two].sort()); assert.ok(up.json.data.skipped.every((s: any) => s.reason === 'SAME_AS_ACTIVE'));
	// everything identical -> NO_CHANGE and no draft
	const before = await e.prisma.siteIdentityAsset.count(); const none = await famUpload(m, mg.id, svg(5), two); assert.equal(none.status, 409); assert.equal(none.json.code, 'SITE_IDENTITY_NO_CHANGE'); assert.equal(await e.prisma.siteIdentityAsset.count(), before);
	// per-key editing of one member does not touch the others
	const k0 = KEYS[0]; const single = await m.upload(mg.id, k0, svg(9), 'image/svg+xml', 's.svg'); assert.equal(single.status, 201);
	assert.equal((await publish(m, mg.id, k0, single.json.data.versionId, 1)).status, 200);
	const man = (await m.pub('')).json.data.items; assert.notEqual(man[k0].sha256, man[KEYS[1]].sha256); assert.equal((await m.adm('GET', '/families', mg.id)).json.data.families[0].uniform, false);
	// bad subsets
	const bad = await famUpload(m, mg.id, svg(6), ['icon.fn.i-bell', 'icon.fn.not-a-member']); assert.equal(bad.status, 400); assert.equal(bad.json.code, 'SITE_IDENTITY_FAMILY_MEMBER');
	assert.equal((await famUpload(m, mg.id, svg(6), [])).status, 400); assert.equal((await famUpload(m, mg.id, svg(6), [KEYS[0], KEYS[0]])).status, 400);
	const notJson = new FormData(); notJson.append('file', new Blob([svg(6)]), 'a.svg'); notJson.append('keys', '{oops'); assert.equal((await m.adm('POST', `/families/${FAM.id}/upload`, mg.id, notJson)).status, 400);
	assert.equal((await famUpload(m, mg.id, svg(6), undefined, 'nope')).status, 404);
	await m.close();
});

test('PG round7 families: hostile uploads are refused for the whole family and stage NOTHING', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'f5')).user; const m = await mount(e);
	const cases: Array<[string, Uint8Array, string, string]> = [
		['png as svg', png(24, 24), 'image/png', 'a.png'], ['no viewBox', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24"/></svg>'), 'image/svg+xml', 'a.svg'],
		
		['html', Buffer.from('<html><script>alert(1)</script></html>'), 'image/svg+xml', 'a.svg'], ['empty', Buffer.alloc(0), 'image/svg+xml', 'a.svg'], ['too wide', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 10"><path d="M0 0"/></svg>'), 'image/svg+xml', 'a.svg'],
		['doctype entity', Buffer.from('<!DOCTYPE svg [<!ENTITY a "x">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>&a;</text></svg>'), 'image/svg+xml', 'a.svg'],
		['too big', Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${'M0 0h1'.repeat(14000)}"/></svg>`), 'image/svg+xml', 'a.svg'],
	];
	for (const [name, bytes, mime, fname] of cases) { const r = await famUpload(m, mg.id, bytes, undefined, FAM.id, mime, fname); assert.ok([400, 413].includes(r.status), `${name}: ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`); }
	// <image>/<use> never survive: either refused or removed by the sanitiser before storage
	for (const inner of ['<image href="https://evil.test/x.png"/>', '<use href="#x"/>', '<foreignObject><iframe src="https://evil.test"/></foreignObject>', '<a href="javascript:alert(1)"><path d="M1 1"/></a>']) {
		const r = await famUpload(m, mg.id, svg(8, inner)); if (r.status === 201) { for (const row of await e.prisma.siteIdentityAsset.findMany({ where: { key: { in: KEYS }, status: 'STAGED' } })) assert.ok(!/<image|<use|evil\.test|javascript:|foreignObject/i.test(Buffer.from(row.bytes).toString('utf8')), inner); await e.prisma.siteIdentityAsset.deleteMany({ where: { status: 'STAGED' } }); } else assert.ok([400, 413].includes(r.status));
	}
	// a script inside an otherwise valid svg is removed, not stored
	const ok = await famUpload(m, mg.id, svg(7, '<script>alert(1)</script><path onload="x()" d="M1 1"/>')); assert.equal(ok.status, 201, JSON.stringify(ok.json));
	const stored = await e.prisma.siteIdentityAsset.findFirstOrThrow({ where: { key: KEYS[0] } }); assert.ok(!/script|onload/i.test(Buffer.from(stored.bytes).toString('utf8')));
	assert.equal(await e.prisma.siteIdentityAsset.count({ where: { status: 'STAGED' } }), KEYS.length, 'only the one valid upload staged anything');
	await m.close();
});

test('PG round7 families: stale digest, version conflicts, DRAFT_NOT_YOURS, discard, bad bodies - nothing changes on any refusal', opts, async () => {
	const e = await env(); await reset(e); const A = (await mkStaff(e, ['site.manage'], 'f6a')).user, B = (await mkStaff(e, ['site.manage'], 'f6b')).user; const m = await mount(e);
	const a = await flow(m, A.id, svg(1));
	// another admin cannot preview-for-apply or apply A's drafts
	const notMine = await m.adm('POST', `/families/${FAM.id}/preview`, B.id, { mode: 'publish', drafts: a.body.drafts }); assert.equal(notMine.status, 409); assert.equal(notMine.json.code, 'SITE_IDENTITY_DRAFT_NOT_YOURS');
	const snap = await dbState(e);
	// wrong digest -> STALE with the fresh preview, nothing changes
	const stale = await m.adm('POST', `/families/${FAM.id}/publish`, A.id, { ...a.body, previewDigest: '0'.repeat(64) }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'SITE_IDENTITY_PREVIEW_STALE'); assert.equal(stale.json.current.previewDigest, a.pv.previewDigest);
	// wrong expectedVersion for ONE key -> CONFLICT with every key's state
	const bad = { ...a.body, expectedVersions: { ...a.body.expectedVersions, [KEYS[1]]: 7 } }; const cf = await m.adm('POST', `/families/${FAM.id}/publish`, A.id, bad); assert.equal(cf.status, 409); assert.equal(cf.json.code, 'SITE_IDENTITY_VERSION_CONFLICT'); assert.equal(cf.json.current.keys.length, KEYS.length);
	// malformed bodies
	for (const b of [{ ...a.body, expectedVersions: undefined }, { ...a.body, expectedVersions: { [KEYS[0]]: 0 } }, { ...a.body, expectedVersions: { ...a.body.expectedVersions, 'icon.fn.other': 0 } }, { ...a.body, expectedVersions: { ...a.body.expectedVersions, [KEYS[0]]: -1 } }, { ...a.body, previewDigest: undefined }, { ...a.body, previewDigest: 'zz' }, { ...a.body, drafts: [] }, { ...a.body, drafts: [{ key: KEYS[0], versionId: 'nope' }] }])
		assert.equal((await m.adm('POST', `/families/${FAM.id}/publish`, A.id, b)).status, 400);
	assert.equal((await m.adm('POST', `/families/${FAM.id}/preview`, A.id, { mode: 'bogus' })).status, 400);
	assert.equal((await m.adm('POST', `/families/${FAM.id}/publish`, A.id, { ...a.body, drafts: [{ key: KEYS[0], versionId: randomUUID() }], expectedVersions: { [KEYS[0]]: 0 }, previewDigest: 'a'.repeat(64) })).status, 404);
	assert.equal(await dbState(e), snap, 'every refusal left the database untouched');
	// a draft of one key used for another key is refused
	const swapped = a.body.drafts.map((d: any, i: number, all: any[]) => ({ key: d.key, versionId: all[(i + 1) % all.length].versionId })); assert.equal((await m.adm('POST', `/families/${FAM.id}/preview`, A.id, { mode: 'publish', drafts: swapped })).status, 404);
	// somebody publishes one member by itself meanwhile -> the family apply is stale/conflicting, nothing changes
	const solo = await m.upload(A.id, KEYS[2], svg(3), 'image/svg+xml', 's.svg'); await publish(m, A.id, KEYS[2], solo.json.data.versionId, 0);
	const after = await m.adm('POST', `/families/${FAM.id}/publish`, A.id, a.body); assert.equal(after.status, 409); assert.ok(['SITE_IDENTITY_PREVIEW_STALE', 'SITE_IDENTITY_VERSION_CONFLICT'].includes(after.json.code), after.json.code);
	assert.deepEqual(Object.keys((await m.pub('')).json.data.items), [KEYS[2]]);
	// discard the drafts atomically; the owner's drafts are gone, bytes dropped, nothing else touched
	const dd = await m.adm('DELETE', `/families/${FAM.id}/drafts`, A.id, { drafts: a.body.drafts }); assert.equal(dd.status, 200, JSON.stringify(dd.json)); assert.equal(dd.json.data.discarded.length, KEYS.length);
	assert.equal(await e.prisma.siteIdentityAsset.count({ where: { status: 'DISCARDED', bytes: null } }), KEYS.length); assert.equal((await auditRows(e, 'SITE_IDENTITY_DISCARDED')).length, KEYS.length);
	assert.equal((await m.adm('DELETE', `/families/${FAM.id}/drafts`, A.id, { drafts: a.body.drafts })).status, 409, 'already discarded');
	await m.close();
});

test('PG round7 families: concurrency - two admins applying the same family against the same versions: exactly one wins; injected failure after the states -> no key changes, no manifest row, no audit row', opts, async () => {
	const e = await env(); await reset(e); const A = (await mkStaff(e, ['site.manage'], 'f7a')).user, B = (await mkStaff(e, ['site.manage'], 'f7b')).user; const m = await mount(e);
	const a = await flow(m, A.id, svg(1)), b = await flow(m, B.id, svg(2));
	const rs = await Promise.all([m.adm('POST', `/families/${FAM.id}/publish`, A.id, a.body), m.adm('POST', `/families/${FAM.id}/publish`, B.id, b.body)]);
	assert.deepEqual(rs.map(r => r.status).sort(), [200, 409], JSON.stringify(rs.map(r => r.json?.code)));
	const winner = rs.find(r => r.status === 200)!.json.data; const loser = rs.find(r => r.status === 409)!.json; assert.ok(['SITE_IDENTITY_PREVIEW_STALE', 'SITE_IDENTITY_VERSION_CONFLICT'].includes(loser.code));
	assert.equal(await e.prisma.siteIdentityManifest.count(), 1); assert.equal(winner.keys.length, KEYS.length);
	const published = await e.prisma.siteIdentityAsset.findMany({ where: { key: { in: KEYS }, status: 'PUBLISHED' } }); assert.equal(published.length, KEYS.length); assert.equal(new Set(published.map((p: any) => p.sha256)).size, 1, 'one coherent family state, never a mix');
	await m.close();
	await reset(e);
	for (const step of ['after-state', 'after-manifest', 'after-audit']) {
		const boom = await mount(e, { faults: { insideTx: async (_tx: any, s: string) => { if (s === step) throw new Error(`injected ${step}`); } } });
		const f = await flow(boom, A.id, svg(3 + step.length)); const snap = await dbState(e);
		const r = await boom.adm('POST', `/families/${FAM.id}/publish`, A.id, f.body); assert.equal(r.status, 500, step);
		assert.equal(await dbState(e), snap, `${step}: nothing changed`); assert.deepEqual((await boom.pub('')).json.data, { version: 0, items: {} });
		await boom.close(); await reset(e);
	}
	// post-commit verification failure: reverted for ALL keys
	const pc = await mount(e, { faults: { postCommit: async () => { throw new Error('verify down'); } } });
	const f = await flow(pc, A.id, svg(40)); const r = await pc.adm('POST', `/families/${FAM.id}/publish`, A.id, f.body); assert.equal(r.status, 500); assert.equal(r.json.code, 'SITE_IDENTITY_VERIFY_FAILED');
	assert.deepEqual((await pc.pub('')).json.data.items, {}, 'reverted: every key back to the default'); await pc.close();
});

test('PG round7 families: permission matrix - 401 anonymous, 403 without any identity permission, view-only reads but never writes, legacy site_control.manage keeps writing, manage and SUPER_ADMIN write', opts, async () => {
	const e = await env(); await reset(e);
	const none = (await mkStaff(e, ['users.view'], 'p0')).user, view = (await mkStaff(e, ['site.view'], 'p1')).user, legacy = (await mkStaff(e, ['site_control.manage'], 'p2')).user, manage = (await mkStaff(e, ['site.manage'], 'p3')).user; const m = await mount(e);
	const body = { mode: 'restore', targets: 'default' };
	const WRITES: Array<[string, string, any]> = [['POST', `/families/${FAM.id}/upload`, undefined], ['POST', `/families/${FAM.id}/preview`, body], ['POST', `/families/${FAM.id}/publish`, {}], ['POST', `/families/${FAM.id}/restore`, {}], ['DELETE', `/families/${FAM.id}/drafts`, {}]];
	const READS: Array<[string, string]> = [['GET', '/families'], ['GET', `/families/${FAM.id}`]];
	for (const [meth, p, b] of WRITES) { assert.equal((await m.adm(meth, p, null as any, b)).status, 401, `anon ${p}`); assert.equal((await m.adm(meth, p, none.id, b)).status, 403, `none ${p}`); assert.equal((await m.adm(meth, p, view.id, b)).status, 403, `view ${p}`); }
	for (const [meth, p] of READS) { assert.equal((await m.adm(meth, p, null as any)).status, 401); assert.equal((await m.adm(meth, p, none.id)).status, 403); for (const u of [view, legacy, manage]) assert.equal((await m.adm(meth, p, u.id)).status, 200, `${u.id} ${p}`); }
	for (const who of [legacy, manage, e.sa]) { const f = await flow(m, who.id, svg(who === legacy ? 11 : who === manage ? 12 : 13)); const r = await m.adm('POST', `/families/${FAM.id}/publish`, who.id, f.body); assert.equal(r.status, 200, JSON.stringify(r.json)); }
	assert.equal(await e.prisma.siteIdentityAsset.count({ where: { createdById: view.id } }), 0);
	// the page tells a legacy holder so; nobody else is flagged
	const acc = async (u: any) => (await m.adm('GET', '/', u.id)).json.data.access;
	assert.deepEqual(await acc(legacy), { canView: true, canManage: true, viaLegacy: true }); assert.deepEqual(await acc(manage), { canView: true, canManage: true, viaLegacy: false }); assert.deepEqual(await acc(view), { canView: true, canManage: false, viaLegacy: false }); assert.deepEqual(await acc(e.sa), { canView: true, canManage: true, viaLegacy: false });
	await m.close();
});

test('PG round7 cap + manifest: EVERY wired icon id can be customised (cap = wired + margin), the manifest with all of them is measured (bytes, gzip, parse, ETag/304), the BE gzips it itself', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'c1')).user; const m = await mount(e);
	const wired = iconSymbols().filter(s => s.reason === null).map(s => s.id);
	assert.ok(MAX_CUSTOM_ICONS >= wired.length + 64, `cap ${MAX_CUSTOM_ICONS} vs wired ${wired.length}`);
	// seed all-but-one through the database (fast), then publish the LAST one through the real pipeline
	const now = new Date(); const bodyOf = (n: number) => svg(n); const assets: any[] = []; const states: any[] = [];
	wired.slice(0, -1).forEach((id, i) => { const bytes = bodyOf(i), key = `${ICON_PREFIX}${id}`, aid = randomUUID(); assets.push({ id: aid, key, version: 1, status: 'PUBLISHED', mime: 'image/svg+xml', bytes: Uint8Array.from(bytes), sha256: sha(bytes), width: 24, height: 24, byteSize: bytes.length, createdAt: now }); states.push({ key, activeAssetId: aid, version: 1, updatedAt: now }); });
	await e.prisma.siteIdentityAsset.createMany({ data: assets }); await e.prisma.siteIdentityState.createMany({ data: states });
	await e.prisma.siteIdentityManifest.create({ data: { version: 1, snapshot: Object.fromEntries(states.map(s => [s.key, s.activeAssetId])), reason: 'seed' } });
	const last = wired[wired.length - 1]; const up = await m.upload(mg.id, `${ICON_PREFIX}${last}`, svg(9999), 'image/svg+xml', 'l.svg'); assert.equal(up.status, 201);
	const pb = await publish(m, mg.id, `${ICON_PREFIX}${last}`, up.json.data.versionId, 0); assert.equal(pb.status, 200, JSON.stringify(pb.json));
	const man = (await m.pub('')).json.data; assert.equal(Object.keys(man.items).length, wired.length, 'every wired id is customised and listed');
	// measure
	const t0 = process.hrtime.bigint(); const first = await getRaw(m.base, '/public/site-identity', { 'accept-encoding': 'gzip' }); const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;
	assert.equal(first.status, 200); assert.equal(first.headers['content-encoding'], 'gzip'); assert.match(String(first.headers['vary']), /Accept-Encoding/i); assert.equal(first.headers['cache-control'], 'public, max-age=60');
	const plain = await getRaw(m.base, '/public/site-identity'); assert.equal(plain.headers['content-encoding'], undefined);
	assert.deepEqual(JSON.parse(zlib.gunzipSync(first.body).toString('utf8')), JSON.parse(plain.body.toString('utf8')), 'gzip and identity bodies are the same document');
	const p0 = process.hrtime.bigint(); for (let i = 0; i < 50; i++) JSON.parse(plain.body.toString('utf8')); const parseMs = Number(process.hrtime.bigint() - p0) / 1e6 / 50;
	const etag = String(first.headers.etag); const t1 = process.hrtime.bigint(); const nm = await getRaw(m.base, '/public/site-identity', { 'if-none-match': etag, 'accept-encoding': 'gzip' }); const nmMs = Number(process.hrtime.bigint() - t1) / 1e6;
	assert.equal(nm.status, 304); assert.equal(nm.body.length, 0);
	const t2 = process.hrtime.bigint(); for (let i = 0; i < 20; i++) await getRaw(m.base, '/public/site-identity', { 'accept-encoding': 'gzip' }); const warmMs = Number(process.hrtime.bigint() - t2) / 1e6 / 20;
	// the numbers go to the report (stdout of the test run)
	console.log(`[MANIFEST-MEASURE] icons=${wired.length} cap=${MAX_CUSTOM_ICONS} json=${plain.body.length}B gzip=${first.body.length}B parse=${parseMs.toFixed(2)}ms firstRequest=${firstMs.toFixed(1)}ms warmRequest=${warmMs.toFixed(1)}ms 304=${nmMs.toFixed(1)}ms perItem=${(plain.body.length / wired.length).toFixed(0)}B`);
	assert.ok(first.body.length < wired.length * 90 + 5_000, `gzip ${first.body.length} for ${wired.length} icons (<=90B per item + 5KB)`); assert.ok(plain.body.length < wired.length * 400 + 20_000, `json ${plain.body.length} for ${wired.length} icons (<=400B per item + 20KB)`); assert.ok(parseMs < 20, `parse ${parseMs}`);
	// a changed icon changes the ETag (the old one no longer matches); restoring one to default shrinks the manifest
	const rs = await m.adm('POST', `/${ICON_PREFIX}${last}/restore`, mg.id, { target: 'default', expectedVersion: 1 }); assert.equal(rs.status, 200);
	const after = await getRaw(m.base, '/public/site-identity', { 'if-none-match': etag }); assert.equal(after.status, 200); assert.notEqual(after.headers.etag, etag); assert.equal(Object.keys(JSON.parse(after.body.toString('utf8')).data.items).length, wired.length - 1);
	// a set restore of ALL customised icons back to the defaults is one exact, digest-bound transaction (preview + apply timed)
	const q0 = Date.now(); const pv = (await m.adm('GET', '/restore-set/0/preview', mg.id)).json.data; const previewMs = Date.now() - q0; assert.equal(pv.changedCount, wired.length - 1); assert.equal(pv.items.filter((i: any) => i.key.startsWith(ICON_PREFIX)).length, wired.length - 1);
	const q1 = Date.now(); const rsAll = await m.adm('POST', '/restore-set', mg.id, { manifestVersion: 0, expectedManifestVersion: pv.currentManifestVersion, previewDigest: pv.previewDigest }); const applyMs = Date.now() - q1; assert.equal(rsAll.status, 200, JSON.stringify(rsAll.json).slice(0, 300));
	console.log(`[SET-RESTORE-MEASURE] keys=${wired.length - 1} previewBytes=${JSON.stringify(pv).length} previewMs=${previewMs} applyMs=${applyMs}`);
	assert.deepEqual((await m.pub('')).json.data.items, {}); assert.equal((await auditRows(e, 'SITE_IDENTITY_SET_RESTORED')).length, 1);
	await m.close();
});

test('PG round7 aliases: social/og and favicon.ico serve the DEFAULT bytes unchanged until a custom file is published (and only when the key is wired), 304, headers, 405, restore, bad files rejected', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'a1')).user;
	const unwired = await mount(e, { isWired: () => false }); const wiredM = await mount(e);
	const OG = DEFAULT_ASSETS['social.og'], FV = DEFAULT_ASSETS['favicon.ico'];
	for (const [path, d] of [['/public/site-identity/social/og', OG], ['/public/site-identity/favicon.ico', FV]] as const) {
		const r = await getRaw(wiredM.base, path); assert.equal(r.status, 200); assert.equal(sha(r.body), d.sha256); assert.equal(r.headers['content-type'], d.mime); assert.equal(r.headers['x-identity-source'], 'default');
		assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.match(String(r.headers['cache-control']), /^public, max-age=300/); assert.equal(r.headers.etag, `"${d.sha256}"`);
		assert.equal((await getRaw(wiredM.base, path, { 'if-none-match': `"${d.sha256}"` })).status, 304);
		const post = await fetch(wiredM.base + path, { method: 'POST' }); assert.equal(post.status, 405); assert.equal(post.headers.get('allow'), 'GET, HEAD');
		const head = await fetch(wiredM.base + path, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), d.mime);
	}
	// validation (hostile files)
	const no = async (key: string, bytes: Uint8Array, mime: string, label: string) => { const r = await wiredM.upload(mg.id, key, bytes, mime, 'x'); assert.ok([400, 413].includes(r.status), `${label}: ${r.status} ${JSON.stringify(r.json).slice(0, 150)}`); };
	await no('social.og', png(1199, 630), 'image/png', 'og wrong width'); await no('social.og', png(1200, 631), 'image/png', 'og wrong height'); await no('social.og', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"/>'), 'image/svg+xml', 'og svg');
	await no('social.og', Buffer.concat([png(1200, 630), Buffer.from('trailing')]), 'image/png', 'og trailing data'); await no('social.og', jpeg(1200, 630, { noEoi: true }), 'image/jpeg', 'og truncated jpeg'); await no('social.og', png(1200, 630, { fakeW: 60000, fakeH: 60000 }), 'image/png', 'og bomb');
	await no('favicon.ico', png(48, 48), 'image/x-icon', 'png as ico'); await no('favicon.ico', ico(48, { entries: 17 }), 'image/x-icon', 'too many entries'); await no('favicon.ico', ico(8), 'image/x-icon', 'too small'); await no('favicon.ico', ico(300), 'image/x-icon', 'too large / size mismatch'); await no('favicon.ico', ico(48, { extra: Buffer.from('tail') }), 'image/x-icon', 'ico trailing');
	await no('favicon.ico', ico(48).subarray(0, 40), 'image/x-icon', 'truncated ico'); await no('favicon.ico', Buffer.alloc(0), 'image/x-icon', 'empty');
	// publish custom files
	const ogBytes = png(1200, 630, { text: 'custom-og' }); const og = await wiredM.upload(mg.id, 'social.og', ogBytes, 'image/png', 'o.png'); assert.equal(og.status, 201, JSON.stringify(og.json)); assert.equal((await publish(wiredM, mg.id, 'social.og', og.json.data.versionId, 0)).status, 200);
	const icoBytes = ico(48, { entries: 2 }); const fi = await wiredM.upload(mg.id, 'favicon.ico', icoBytes, 'image/x-icon', 'f.ico'); assert.equal(fi.status, 201, JSON.stringify(fi.json)); assert.equal((await publish(wiredM, mg.id, 'favicon.ico', fi.json.data.versionId, 0)).status, 200);
	const c1 = await getRaw(wiredM.base, '/public/site-identity/social/og'); assert.equal(c1.status, 200); assert.equal(sha(c1.body), sha(ogBytes)); assert.equal(c1.headers['x-identity-source'], 'custom'); assert.equal(c1.headers['content-type'], 'image/png');
	const c2 = await getRaw(wiredM.base, '/public/site-identity/favicon.ico'); assert.equal(sha(c2.body), sha(icoBytes)); assert.equal(c2.headers['content-type'], 'image/x-icon'); assert.equal(c2.headers['x-identity-source'], 'custom');
	assert.equal((await getRaw(wiredM.base, '/public/site-identity/social/og', { 'if-none-match': `"${sha(ogBytes)}"` })).status, 304);
	// the manifest lists them and the immutable hashed URL serves the same bytes
	const man = (await wiredM.pub('')).json.data.items; assert.equal(man['social.og'].sha256, sha(ogBytes)); assert.equal(sha((await getRaw(wiredM.base, `/public${man['favicon.ico'].url.replace('/public', '')}`)).body), sha(icoBytes));
	// a server where the key is NOT wired still serves the default (the DB state is ignored)
	assert.equal((await getRaw(unwired.base, '/public/site-identity/social/og')).headers['x-identity-source'], 'default');
	// restore -> default again
	const rs = await wiredM.adm('POST', '/social.og/restore', mg.id, { target: 'default', expectedVersion: 1 }); assert.equal(rs.status, 200);
	assert.equal(sha((await getRaw(wiredM.base, '/public/site-identity/social/og')).body), OG.sha256);
	// the database is unreachable -> default, not an error
	const broken = await mount(e, { db: { siteIdentityState: { findUnique: async () => { throw new Error('db down'); } } } });
	const bd = await getRaw(broken.base, '/public/site-identity/favicon.ico'); assert.equal(bd.status, 200); assert.equal(sha(bd.body), FV.sha256);
	await unwired.close(); await wiredM.close(); await broken.close();
});

test('PG round7 static guards: defaults embedded for the aliases equal the registry fingerprints; the shipped family definition is consistent; the empty manifest is unchanged', opts, async () => {
	for (const k of ['social.og', 'favicon.ico'] as const) { const d = DEFAULT_ASSETS[k]; const fp = identityDef(k)!.defaultFingerprint; assert.equal(d.sha256, fp.sha256); assert.equal(sha(Buffer.from(d.base64, 'base64')), fp.sha256); assert.equal(Buffer.from(d.base64, 'base64').length, fp.byteSize); assert.equal(d.mime, fp.mime); }
	const e = await env(); await reset(e); const m = await mount(e); assert.deepEqual((await m.pub('')).json.data, { version: 0, items: {} }); await m.close();
});
