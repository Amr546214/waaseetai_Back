import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { env, opts, mkStaff } from '../testing/admin-team.pgenv';
import { iconLibraryOnly, iconSymbols } from '../config/site-identity-icons';
import { iconFamilies } from '../config/site-identity-icon-families';
import { mount, reset, publish } from './site-identity-round2.pgenv';
import { splitNote } from './site-identity.service';

/**
 * Site identity ROUND 8 on REAL PostgreSQL over HTTP: `sourceRef` metadata (library pick / device upload) on icon versions: validation, storage with the staged version, return in item / history / family /
 * set-preview payloads, audit (no bytes), preserved on restore, circular substitution impossible (the applied asset is a COPY). Isolated local database only. Contract: IDENTITY-ROUND8-CONTRACT-2026-10-28.md
 */
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const FAM = iconFamilies()[0];
const wired = iconSymbols().filter(s => !s.reason && !FAM.members.some(x => x.symbolId === s.id));
const X = 'i-bell', Y = wired[0].id, Z = wired[1].id;
const KX = `icon.fn.${X}`, KY = `icon.fn.${Y}`;
const draw = (tag: string, body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><title>${tag}</title>${body}</svg>`);
const DX = draw('X', '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>'); // the library drawing of X (the bell)
const DY = draw('Y', '<rect x="4" y="4" width="16" height="16" rx="3"/>');   // the library drawing of Y
const DZ = draw('Z', '<circle cx="12" cy="12" r="8"/>');
const up = (m: any, who: string, key: string, bytes: Uint8Array, ref?: unknown) => {
	const f = new FormData(); f.append('file', new Blob([bytes], { type: 'image/svg+xml' }), 'i.svg'); if (ref !== undefined) f.append('sourceRef', typeof ref === 'string' ? ref : JSON.stringify(ref)); return m.adm('POST', `/${key}/upload`, who, f);
};
const famUp = (m: any, who: string, bytes: Uint8Array, ref?: unknown, keys?: string[]) => {
	const f = new FormData(); f.append('file', new Blob([bytes], { type: 'image/svg+xml' }), 'i.svg'); if (ref !== undefined) f.append('sourceRef', JSON.stringify(ref)); if (keys) f.append('keys', JSON.stringify(keys)); return m.adm('POST', `/families/${FAM.id}/upload`, who, f);
};
const stv = async (m: any, who: string, key: string) => (await m.adm('GET', `/icons/${key.slice(8)}`, who)).json.data.state.stateVersion as number;
const audits = (e: any, type: string) => e.prisma.accountAuditLog.findMany({ where: { eventType: type }, orderBy: { occurredAt: 'asc' } });
const publicBytes = async (m: any, key: string) => { const man = (await m.pub('')).json.data; const it = man.items[key]; if (!it) return null; return (await m.raw('GET', `/public/site-identity/assets/${key}/${it.sha256}`)).buf; };

test('PG round8 sourceRef: library pick staged with the version, returned in upload/item/history/state/set-preview, audited without bytes, persists across a restart', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'r8a')).user; const m = await mount(e);
	const r = await up(m, mg.id, KX, DY, { kind: 'library', symbolId: Y }); assert.equal(r.status, 201, JSON.stringify(r.json));
	assert.deepEqual(r.json.data.sourceRef, { kind: 'library', symbolId: Y }); assert.equal(r.json.data.note, null, 'the machine tag never reaches the API as note');
	const item = (await m.adm('GET', `/icons/${X}`, mg.id)).json.data; assert.deepEqual(item.staged[0].sourceRef, { kind: 'library', symbolId: Y }); assert.equal(item.staged[0].isMine, true);
	const pb = await publish(m, mg.id, KX, r.json.data.versionId, item.state.stateVersion); assert.equal(pb.status, 200, JSON.stringify(pb.json));
	assert.deepEqual(pb.json.data.active.sourceRef, { kind: 'library', symbolId: Y });
	const it2 = (await m.adm('GET', `/icons/${X}`, mg.id)).json.data; assert.deepEqual(it2.state.active.sourceRef, { kind: 'library', symbolId: Y }); assert.deepEqual(it2.history[0].sourceRef, { kind: 'library', symbolId: Y });
	const hist = (await m.adm('GET', `/history?key=${KX}`, mg.id)).json.data; assert.deepEqual(hist.versions[0].sourceRef, { kind: 'library', symbolId: Y });
	const sp = (await m.adm('GET', '/restore-set/0/preview', mg.id)).json.data.items.find((i: any) => i.key === KX); assert.deepEqual(sp.current.sourceRef, { kind: 'library', symbolId: Y }); assert.equal(sp.target.sourceRef, null);
	const stored = await e.prisma.siteIdentityAsset.findFirst({ where: { key: KX } }); assert.equal(sha(stored.bytes), r.json.data.sha256, 'the stored bytes are the uploaded sanitised file');
	const ua = (await audits(e, 'SITE_IDENTITY_UPLOADED'))[0], pa = (await audits(e, 'SITE_IDENTITY_PUBLISHED'))[0];
	assert.deepEqual(ua.metaData.sourceRef, { kind: 'library', symbolId: Y }); assert.deepEqual(pa.metaData.sourceRef, { kind: 'library', symbolId: Y });
	assert.ok(!JSON.stringify([ua.metaData, pa.metaData, ua.summary]).includes('<svg') && !JSON.stringify(ua.metaData).includes('bytes'), 'no bytes in audit');
	await m.close(); const m2 = await mount(e); const again = (await m2.adm('GET', `/icons/${X}`, mg.id)).json.data; assert.deepEqual(again.state.active.sourceRef, { kind: 'library', symbolId: Y });
	assert.deepEqual((await m2.adm('GET', `/families/${FAM.id}`, mg.id)).json.data.members.find((x: any) => x.symbolId === X).state.active.sourceRef, { kind: 'library', symbolId: Y });
	await m2.close();
});

test('PG round8 sourceRef: validation in value wording; nothing is staged on a refusal; library-only and NO_CONSUMER drawings are accepted, AI / unknown are not', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'r8b')).user; const m = await mount(e);
	const bad: Array<[unknown, RegExp]> = [
		[{ kind: 'library', symbolId: 'no-such-icon-xyz' }, /غير موجودة/], [{ kind: 'library', symbolId: 'i-ai' }, /الذكاء الاصطناعي/], [{ kind: 'library' }, /غير موجودة/], [{ kind: 'library', symbolId: '../x' }, /غير موجودة/],
		[{ kind: 'zip' }, /library|upload/], [{ kind: 'upload', symbolId: Y }, /لا يحمل/], [{ kind: 'library', symbolId: Y, path: '/etc/passwd' }, /حقول غير مسموحة/], [[1], /كائنًا/], ['not json{', /JSON/], [JSON.stringify({ kind: 'library', symbolId: 'a'.repeat(300) }), /طويلة/],
	];
	for (const [ref, re] of bad) {
		const r = await up(m, mg.id, KX, DY, ref); assert.equal(r.status, 400, JSON.stringify(ref)); assert.equal(r.json.errors[0].field, 'sourceRef'); assert.match(r.json.errors[0].message ?? r.json.message, re); assert.ok(!/ملف/.test(r.json.errors[0].message ?? ''), 'value wording, not file wording');
	}
	assert.equal(await e.prisma.siteIdentityAsset.count(), 0, 'no refusal staged anything');
	const lo = iconLibraryOnly().find(x => x.reason === 'LIBRARY_ONLY'); const nc = iconSymbols().find(s => s.reason === 'NO_CONSUMER');
	if (lo) assert.equal((await up(m, mg.id, KX, DY, { kind: 'library', symbolId: lo.id })).status, 201, 'library-only drawing accepted as a source');
	if (nc) assert.equal((await up(m, mg.id, KX, DZ, { kind: 'library', symbolId: nc.id })).status, 201, 'NO_CONSUMER drawing accepted as a source');
	assert.equal((await up(m, mg.id, KX, draw('U', '<path d="M1 1h4"/>'), { kind: 'upload' })).status, 201);
	assert.equal((await up(m, mg.id, KX, draw('N', '<path d="M2 2h4"/>'))).json.data.sourceRef, null, 'absent = null');
	// non-icon key
	const f = new FormData(); f.append('file', new Blob([Buffer.from('x')]), 'a.png'); f.append('sourceRef', JSON.stringify({ kind: 'upload' }));
	const na = await m.adm('POST', '/logo.mark/upload', mg.id, f); assert.equal(na.status, 400); assert.match(na.json.errors[0].message, /للأيقونات فقط/);
	// a bad sourceRef never relaxes the file rules, and a bad file with a good ref stages nothing
	const before = await e.prisma.siteIdentityAsset.count();
	const nov = await up(m, mg.id, KX, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M1 1h4"/></svg>'), { kind: 'library', symbolId: Y }); assert.equal(nov.status, 400); assert.equal(nov.json.code, 'SITE_IDENTITY_FILE_REJECTED');
	const use = await up(m, mg.id, KX, draw('H', '<use href="#x"/>'), { kind: 'library', symbolId: Y }); assert.equal(use.status, 400);
	assert.equal(await e.prisma.siteIdentityAsset.count(), before);
	await m.close();
});

test('PG round8 sourceRef: hostile SVG with a valid sourceRef is sanitised, the human note stays separate from the reference', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'r8c')).user; const m = await mount(e);
	const r = await up(m, mg.id, KX, draw('H', '<script>alert(1)</script><circle cx="1" cy="1" r="1" onload="alert(2)"/>'), { kind: 'library', symbolId: Y }); assert.equal(r.status, 201, JSON.stringify(r.json));
	assert.match(r.json.data.note, /نُظِّف/); assert.ok(!r.json.data.note.includes('sourceRef')); assert.deepEqual(r.json.data.sourceRef, { kind: 'library', symbolId: Y });
	const row = await e.prisma.siteIdentityAsset.findFirst({ where: { key: KX } }); assert.ok(!/script|onload/i.test(Buffer.from(row.bytes).toString()));
	assert.deepEqual(splitNote(row.note).sourceRef, { kind: 'library', symbolId: Y }); assert.deepEqual(splitNote('plain'), { note: 'plain', sourceRef: null }); assert.deepEqual(splitNote(null), { note: null, sourceRef: null });
	await m.close();
});

test('PG round8 sourceRef: CIRCULAR substitution is impossible - X for Y then Y for X are two independent copies; later changes never travel', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'r8d')).user; const m = await mount(e);
	// 1. the owner puts the drawing of Y on the key of X (the bell shows the square) - library pick
	const a = await up(m, mg.id, KX, DY, { kind: 'library', symbolId: Y }); assert.equal((await publish(m, mg.id, KX, a.json.data.versionId, 0)).status, 200);
	// 2. then puts the drawing of X on the key of Y - the FE sends the LIBRARY drawing of X (the bell), not what KX currently shows
	const b = await up(m, mg.id, KY, DX, { kind: 'library', symbolId: X }); assert.equal((await publish(m, mg.id, KY, b.json.data.versionId, 0)).status, 200);
	const bx = await publicBytes(m, KX), by = await publicBytes(m, KY);
	assert.equal(sha(bx!), a.json.data.sha256); assert.equal(sha(by!), b.json.data.sha256); assert.notEqual(sha(bx!), sha(by!), 'two independent files, no loop, no recursion');
	assert.match(bx!.toString(), /rect/); assert.match(by!.toString(), /M18 8A6/);
	assert.deepEqual((await m.adm('GET', `/icons/${X}`, mg.id)).json.data.state.active.sourceRef, { kind: 'library', symbolId: Y });
	assert.deepEqual((await m.adm('GET', `/icons/${Y}`, mg.id)).json.data.state.active.sourceRef, { kind: 'library', symbolId: X }, 'mutual LABELS, not links');
	// 3. customising X again (a third drawing) or restoring X to default does not change Y's file
	const c = await up(m, mg.id, KX, DZ, { kind: 'library', symbolId: Z }); assert.equal((await publish(m, mg.id, KX, c.json.data.versionId, await stv(m, mg.id, KX))).status, 200);
	assert.equal(sha((await publicBytes(m, KY))!), b.json.data.sha256);
	const rd = await m.adm('POST', `/${KX}/restore`, mg.id, { target: 'default', expectedVersion: await stv(m, mg.id, KX) }); assert.equal(rd.status, 200);
	assert.equal(await publicBytes(m, KX), null, 'X is back to its default'); assert.equal(sha((await publicBytes(m, KY))!), b.json.data.sha256, 'Y still holds the copy of the bell drawing made at upload time');
	// 4. choosing the icon's own id is harmless
	const self = await up(m, mg.id, KY, DZ, { kind: 'library', symbolId: Y }); assert.equal(self.status, 201);
	// the service has no code path that reads another key's asset for a sourceRef: every stored byte equals the bytes uploaded with that request
	for (const r of await e.prisma.siteIdentityAsset.findMany({ where: { status: { not: 'DISCARDED' } } })) assert.equal(sha(r.bytes), r.sha256);
	await m.close();
});

test('PG round8 sourceRef: restore keeps the original sourceRef of each version; restore to default shows none; set-preview current/target carry it', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'r8e')).user; const m = await mount(e);
	const v1 = await up(m, mg.id, KX, DY, { kind: 'library', symbolId: Y }); await publish(m, mg.id, KX, v1.json.data.versionId, 0);
	const v2 = await up(m, mg.id, KX, DZ, { kind: 'upload' }); assert.equal((await publish(m, mg.id, KX, v2.json.data.versionId, 1)).status, 200);
	assert.deepEqual((await m.adm('GET', `/icons/${X}`, mg.id)).json.data.state.active.sourceRef, { kind: 'upload' });
	const rs = await m.adm('POST', `/${KX}/restore`, mg.id, { target: v1.json.data.versionId, expectedVersion: 2 }); assert.equal(rs.status, 200, JSON.stringify(rs.json));
	assert.deepEqual(rs.json.data.active.sourceRef, { kind: 'library', symbolId: Y }); assert.deepEqual(rs.json.data.previous.sourceRef, { kind: 'upload' });
	const hist = (await m.adm('GET', `/icons/${X}`, mg.id)).json.data.history; assert.deepEqual(hist.map((h: any) => h.sourceRef?.kind).sort(), ['library', 'upload']);
	// set preview: restoring the manifest where X held the upload (manifest 2) shows target.sourceRef upload, current library
	const sp = (await m.adm('GET', '/restore-set/2/preview', mg.id)).json.data.items.find((i: any) => i.key === KX); assert.deepEqual(sp.current.sourceRef, { kind: 'library', symbolId: Y }); assert.deepEqual(sp.target.sourceRef, { kind: 'upload' });
	assert.equal((await m.adm('GET', '/restore-set/0/preview', mg.id)).json.data.items.find((i: any) => i.key === KX).target.sourceRef, null);
	const rd = await m.adm('POST', `/${KX}/restore`, mg.id, { target: 'default', expectedVersion: 3 }); assert.equal(rd.status, 200); assert.equal((await m.adm('GET', `/icons/${X}`, mg.id)).json.data.state.active, null);
	await m.close();
});

test('PG round8 sourceRef: family upload accepts the same sourceRef on every member draft, preview/publish carry it, invalid ref stages nothing', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'r8f')).user; const m = await mount(e);
	const KEYS = FAM.members.map(x => x.key);
	const bad = await famUp(m, mg.id, DY, { kind: 'library', symbolId: 'i-ai' }); assert.equal(bad.status, 400); assert.equal(bad.json.errors[0].field, 'sourceRef'); assert.equal(await e.prisma.siteIdentityAsset.count(), 0);
	const r = await famUp(m, mg.id, DY, { kind: 'library', symbolId: Y }); assert.equal(r.status, 201, JSON.stringify(r.json)); assert.deepEqual(r.json.data.sourceRef, { kind: 'library', symbolId: Y });
	assert.equal(r.json.data.drafts.length, KEYS.length); assert.ok(r.json.data.drafts.every((d: any) => d.sourceRef?.symbolId === Y));
	const fam = (await m.adm('GET', `/families/${FAM.id}`, mg.id)).json.data; assert.ok(fam.members.every((x: any) => x.staged[0].sourceRef?.symbolId === Y));
	const drafts = r.json.data.drafts.map((d: any) => ({ key: d.key, versionId: d.versionId }));
	const pv = (await m.adm('POST', `/families/${FAM.id}/preview`, mg.id, { mode: 'publish', drafts })).json.data; assert.ok(pv.items.every((i: any) => i.target.sourceRef?.symbolId === Y && i.current.sourceRef === null));
	const pb = await m.adm('POST', `/families/${FAM.id}/publish`, mg.id, { drafts, expectedVersions: Object.fromEntries(pv.items.map((i: any) => [i.key, i.stateVersion])), previewDigest: pv.previewDigest }); assert.equal(pb.status, 200, JSON.stringify(pb.json));
	const fam2 = (await m.adm('GET', `/families/${FAM.id}`, mg.id)).json.data; assert.ok(fam2.members.every((x: any) => x.state.active.sourceRef?.symbolId === Y));
	const ua = await audits(e, 'SITE_IDENTITY_UPLOADED'); assert.equal(ua.length, KEYS.length); assert.ok(ua.every((a: any) => a.metaData.familyId === FAM.id && a.metaData.sourceRef.symbolId === Y));
	assert.ok((await audits(e, 'SITE_IDENTITY_PUBLISHED')).every((a: any) => a.metaData.sourceRef?.symbolId === Y));
	await m.close();
});

test('PG round8 sourceRef: permissions 401/403, view-only, legacy site_control.manage, DRAFT_NOT_YOURS, conflict - failures never clear saved state', opts, async () => {
	const e = await env(); await reset(e); const mg = (await mkStaff(e, ['site.manage'], 'r8g')).user, other = (await mkStaff(e, ['site.manage'], 'r8h')).user, view = (await mkStaff(e, ['site.view'], 'r8v')).user, legacy = (await mkStaff(e, ['site_control.manage'], 'r8l')).user, none = (await mkStaff(e, ['users.view'], 'r8n')).user; const m = await mount(e);
	const f = () => { const x = new FormData(); x.append('file', new Blob([DY], { type: 'image/svg+xml' }), 'i.svg'); x.append('sourceRef', JSON.stringify({ kind: 'library', symbolId: Y })); return x; };
	assert.equal((await m.raw('POST', `/admin/site-identity/${KX}/upload`, null, f())).status, 401);
	assert.equal((await m.adm('POST', `/${KX}/upload`, none.id, f())).status, 403);
	assert.equal((await m.adm('POST', `/${KX}/upload`, view.id, f())).status, 403, 'view-only never writes');
	assert.equal((await m.adm('POST', `/families/${FAM.id}/upload`, view.id, f())).status, 403);
	assert.equal(await e.prisma.siteIdentityAsset.count(), 0);
	const lg = await m.adm('POST', `/${KX}/upload`, legacy.id, f()); assert.equal(lg.status, 201); assert.deepEqual(lg.json.data.sourceRef, { kind: 'library', symbolId: Y });
	assert.equal((await m.adm('GET', `/icons/${X}`, view.id)).json.data.staged.length, 1, 'view-only can read the drafts and sourceRef'); assert.equal((await m.adm('GET', `/icons/${X}`, view.id)).json.data.staged[0].isMine, false);
	assert.equal((await publish(m, other.id, KX, lg.json.data.versionId, 0)).json.code, 'SITE_IDENTITY_DRAFT_NOT_YOURS');
	assert.equal((await publish(m, legacy.id, KX, lg.json.data.versionId, 0)).status, 200);
	// conflict: stale expectedVersion, then a refused upload; the saved choice survives both
	const d2 = await up(m, mg.id, KX, DZ, { kind: 'upload' });
	const conflict = await publish(m, mg.id, KX, d2.json.data.versionId, 0); assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'SITE_IDENTITY_VERSION_CONFLICT'); assert.deepEqual(conflict.json.current.active.sourceRef, { kind: 'library', symbolId: Y });
	assert.equal((await up(m, mg.id, KX, Buffer.from('nope'), { kind: 'library', symbolId: Y })).status, 400);
	assert.equal((await up(m, mg.id, KX, DZ, { kind: 'library', symbolId: 'nope-nope' })).status, 400);
	const now = (await m.adm('GET', `/icons/${X}`, mg.id)).json.data; assert.deepEqual(now.state.active.sourceRef, { kind: 'library', symbolId: Y }); assert.equal(sha((await publicBytes(m, KX))!), lg.json.data.sha256);
	await m.close();
});
