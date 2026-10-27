import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { env, opts, mkStaff } from '../testing/admin-team.pgenv';
import { png } from '../testing/site-identity.pgenv';
import { SITE_IDENTITY_REGISTRY } from '../config/site-identity.registry';

/**
 * Site identity ROUND 2 on REAL PostgreSQL over HTTP: legacy `site_control.manage` read alias, actor objects, exact set-restore preview + digest, publish = the previewed staged row, logo.email cache.
 * Database: isolated local :55432 only. No mail is sent: the shell is only RENDERED.
 */
process.env.RATE_LIMIT_ENABLED = 'false';
const opened: Array<{ close: () => Promise<void> }> = [];
after(async () => { for (const m of opened) await m.close().catch(() => undefined); });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const FX = path.join(__dirname, '..', 'testing', 'fixtures', 'site-identity');
const fx = (n: string) => fs.readFileSync(path.join(FX, n));

export async function mount(e: any, serviceOpts: { isWired?: (k: string) => boolean; faults?: any; db?: any } = {}) {
	const express = (await import('express')).default; const { globalErrorHandler } = await import('../middlewares/error.middleware');
	const { buildAdminSiteIdentityRouter } = await import('../routes/admin-site-identity.routes'); const { buildPublicSiteIdentityRouter } = await import('../routes/public-site-identity.routes');
	const { SiteIdentityService } = await import('./site-identity.service');
	const service = new SiteIdentityService({ isWired: serviceOpts.isWired ?? (() => true), faults: serviceOpts.faults, db: serviceOpts.db });
	const app = express(); app.use(express.json()); app.use('/admin/site-identity', buildAdminSiteIdentityRouter(service)); app.use('/public', buildPublicSiteIdentityRouter(service)); app.use(globalErrorHandler as any);
	const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const raw = async (method: string, url: string, who?: string | null, body?: any) => {
		const isForm = body instanceof FormData;
		const res = await fetch(base + url, { method, headers: { connection: 'close', ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }), ...(who ? { 'x-test-user': who } : {}) }, body: body === undefined || method === 'GET' ? undefined : isForm ? body : JSON.stringify(body) });
		const buf = Buffer.from(await res.arrayBuffer()); let json: any = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* bytes */ }
		return { status: res.status, headers: res.headers, json, buf, text: buf.toString('utf8') };
	};
	const adm = (method: string, p: string, who: string, body?: any) => raw(method, `/admin/site-identity${p}`, who, body);
	const pub = (p: string) => raw('GET', `/public/site-identity${p}`);
	const upload = (who: string, key: string, bytes: Uint8Array, mime = 'image/png', name = 'a.png') => { const f = new FormData(); f.append('file', new Blob([bytes], { type: mime }), name); return adm('POST', `/${key}/upload`, who, f); };
	const handle = { service, raw, adm, pub, upload, close: async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); } }; opened.push(handle); return handle;
}
export const reset = async (e: any) => { await e.prisma.siteIdentityState.deleteMany({}); await e.prisma.siteIdentityManifest.deleteMany({}); await e.prisma.siteIdentityAsset.deleteMany({}); await e.prisma.accountAuditLog.deleteMany({ where: { eventType: { startsWith: 'SITE_IDENTITY_' } } }); };
export const staged = async (m: any, who: string, key: string, tag: string, w = 300, h = 200) => { const r = await m.upload(who, key, png(w, h, { text: tag })); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.data; };
export const publish = (m: any, who: string, key: string, versionId: string, expectedVersion: number) => m.adm('POST', `/${key}/publish`, who, { versionId, expectedVersion });
const manifestNow = async (m: any, who: string) => (await m.adm('GET', '/', who)).json.data.manifestVersion as number;
export const dbState = async (e: any) => JSON.stringify({ s: await e.prisma.siteIdentityState.findMany({ orderBy: { key: 'asc' } }), m: await e.prisma.siteIdentityManifest.count(), a: (await e.prisma.siteIdentityAsset.findMany({ select: { id: true, status: true, sha256: true }, orderBy: { id: 'asc' } })), l: await e.prisma.accountAuditLog.count({ where: { eventType: { startsWith: 'SITE_IDENTITY_' } } }) });
const body = (j: any) => (j.data ?? j);

// ---------------------------------------------------------------------------------------------------------------- A
test('PG round2 A (revised round 5): legacy site_control.manage MAPS TO EDIT (reads every GET and writes like site.manage); site.view stays read-only (403 on every write); none 403; SUPER_ADMIN full; public untouched', opts, async () => {
	const e = await env(); await reset(e);
	const legacy = (await mkStaff(e, ['site_control.manage'], 'lg')).user, viewer = (await mkStaff(e, ['site.view'], 'vw')).user, manager = (await mkStaff(e, ['site.manage'], 'mg')).user, none = (await mkStaff(e, ['users.view', 'settings.manage'], 'nn')).user;
	const personal = (await mkStaff(e, ['users.view'], 'ps')).user; const st = await e.prisma.adminStaff.findUnique({ where: { userId: personal.id } });
	await e.prisma.adminStaffOverride.create({ data: { staffId: st.id, permission: 'site_control.manage', effect: 'GRANT', createdById: e.sa.id } });
	const GETS: Array<[string, string]> = [['GET', '/'], ['GET', '/history'], ['GET', `/logo.mark/versions/${randomUUID()}/preview`], ['GET', '/restore-set/0/preview']];
	const WRITES: Array<[string, string, any?]> = [['POST', '/logo.mark/upload', {}], ['POST', '/logo.mark/publish', {}], ['POST', '/logo.mark/restore', {}], ['POST', '/restore-set', {}], ['DELETE', `/logo.mark/versions/${randomUUID()}`]];
	const url = (p: string) => `/admin/site-identity${p}`;
	for (const [who, label] of [[legacy, 'legacy role holder'], [personal, 'legacy personal grant'], [manager, 'site.manage']] as const) {
		for (const [m, p] of GETS) { const r = await e.call(m, url(p), who.id); assert.notEqual(r.status, 403, `${label} ${p}`); assert.notEqual(r.status, 401); }
		assert.equal((await e.call('GET', url('/'), who.id)).json.data.canManage, true, `${label}: canManage true`);
		assert.equal((await e.call('GET', url('/restore-set/0/preview'), who.id)).status, 200, `${label}: set preview readable`);
		for (const [m, p, b] of WRITES) assert.notEqual((await e.call(m, url(p), who.id, b)).status, 403, `${label} may ${m} ${p} (the guard passes; the body decides)`);
	}
	// site.view is read-only: it is NOT widened by the mapping
	for (const [m, p] of GETS) { const r = await e.call(m, url(p), viewer.id); assert.notEqual(r.status, 403, `viewer ${p}`); }
	assert.equal((await e.call('GET', url('/'), viewer.id)).json.data.canManage, false, 'site.view: canManage false');
	for (const [m, p, b] of WRITES) assert.equal((await e.call(m, url(p), viewer.id, b)).status, 403, `site.view must not ${m} ${p}`);
	for (const [m, p] of GETS) { const r = await e.call(m, url(p), none.id); assert.equal(r.status, 403, `none ${p}`); assert.ok(!/"data"/.test(r.text)); assert.equal(r.json.code, 'ADMIN_PERMISSION_DENIED'); }
	for (const [m, p, b] of WRITES) assert.equal((await e.call(m, url(p), none.id, b)).status, 403);
	for (const [m, p] of GETS) assert.notEqual((await e.call(m, url(p), e.sa.id)).status, 403, `SUPER_ADMIN ${p}`);
	assert.equal((await e.call('GET', url('/'), e.sa.id)).json.data.canManage, true);
	assert.equal((await e.call('GET', '/public/site-identity', null)).status, 200, 'public stays public');
	assert.equal((await e.call('GET', url('/restore-set/0/preview'), null)).status, 401);
	// the legacy holder REALLY does the whole cycle through a wired service (upload -> publish -> second version -> restore -> restore-set -> discard); site.view still cannot with perfectly valid bodies
	const m = await mount(e);
	const v1 = await staged(m, legacy.id, 'logo.mark', 'legacy-1'); const p1 = await publish(m, legacy.id, 'logo.mark', v1.versionId, 0); assert.equal(p1.status, 200, JSON.stringify(p1.json));
	const v2 = await staged(m, personal.id, 'logo.mark', 'legacy-2'); const p2 = await publish(m, personal.id, 'logo.mark', v2.versionId, p1.json.data.stateVersion); assert.equal(p2.status, 200, JSON.stringify(p2.json));
	const rs = await m.adm('POST', '/logo.mark/restore', legacy.id, { target: v1.versionId, expectedVersion: p2.json.data.stateVersion }); assert.equal(rs.status, 200, JSON.stringify(rs.json));
	const prev = await m.adm('GET', '/restore-set/0/preview', legacy.id); assert.equal(prev.status, 200);
	const set = await m.adm('POST', '/restore-set', legacy.id, { manifestVersion: 0, expectedManifestVersion: prev.json.data.currentManifestVersion, previewDigest: prev.json.data.previewDigest }); assert.equal(set.status, 200, JSON.stringify(set.json));
	const v3 = await staged(m, legacy.id, 'logo.mark', 'legacy-3'); assert.equal((await m.adm('DELETE', `/logo.mark/versions/${v3.versionId}`, legacy.id)).status, 200);
	const vv = await m.upload(viewer.id, 'logo.mark', png(300, 200, { text: 'v' })); assert.equal(vv.status, 403);
	assert.equal((await m.adm('POST', '/logo.mark/publish', viewer.id, { versionId: v1.versionId, expectedVersion: 0 })).status, 403);
	assert.equal((await m.adm('POST', '/logo.mark/restore', viewer.id, { target: 'default', expectedVersion: 0 })).status, 403);
	assert.equal((await m.adm('DELETE', `/logo.mark/versions/${v1.versionId}`, viewer.id)).status, 403);
	// a draft stays private to its uploader even for SUPER_ADMIN (and for a legacy holder against a manager's draft)
	const mine = await staged(m, manager.id, 'logo.mark', 'private'); const sv = (await m.adm('GET', '/', e.sa.id)).json.data.items.find((i: any) => i.key === 'logo.mark').state.stateVersion;
	const dn = await publish(m, e.sa.id, 'logo.mark', mine.versionId, sv); assert.equal(dn.status, 409); assert.equal(dn.json.code, 'SITE_IDENTITY_DRAFT_NOT_YOURS', 'SUPER_ADMIN cannot publish another admin\'s draft');
	const dl = await publish(m, legacy.id, 'logo.mark', mine.versionId, sv); assert.equal(dl.status, 409); assert.equal(dl.json.code, 'SITE_IDENTITY_DRAFT_NOT_YOURS');
	await m.close();
});

// ---------------------------------------------------------------------------------------------------------------- B
test('PG round2 B: actors are {id,name} (person or company name; null when deleted), one batched lookup, no personal data, never on public routes', opts, async () => {
	const e = await env(); await reset(e);
	let userLookups = 0; // every user.findMany the service issues through its own db handle
	const counting = new Proxy(e.prisma, { get(t: any, k: any) { return k === 'user' ? new Proxy(t.user, { get(u: any, q: any) { return q === 'findMany' ? (...a: any[]) => { userLookups++; return u.findMany(...a); } : u[q]; } }) : t[k]; } });
	const m = await mount(e, { db: counting });
	const PHONE = `5${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`; const staff = (await mkStaff(e, ['site.manage'], 'Salma')).user; await e.prisma.user.update({ where: { id: staff.id }, data: { firstName: 'سلمى', lastName: 'الأحمد', phoneNumber: PHONE } });
	const company = await e.mkUser('CLIENT_COMPANY', 'co'); await e.prisma.clientProfile.create({ data: { userId: company.id, companyName: 'شركة النور' } });
	const ghost = randomUUID();
	const A = await staged(m, staff.id, 'logo.mark', 'actor-a'); assert.deepEqual(A.createdBy, { id: staff.id, name: 'سلمى الأحمد' }); assert.ok(!('createdById' in A));
	const B = await staged(m, staff.id, 'logo.mark', 'actor-b'); const C = await staged(m, staff.id, 'logo.mark', 'actor-c');
	await e.prisma.siteIdentityAsset.update({ where: { id: B.versionId }, data: { createdById: company.id } }); await e.prisma.siteIdentityAsset.update({ where: { id: C.versionId }, data: { createdById: ghost } });
	userLookups = 0;
	const ov = await m.adm('GET', '/', staff.id); assert.equal(ov.status, 200);
	assert.equal(userLookups, 1, `ONE batched user lookup for the whole page (staged rows by 3 different people)`);
	const logo = ov.json.data.items.find((i: any) => i.key === 'logo.mark'); const byId = Object.fromEntries(logo.staged.map((v: any) => [v.versionId, v]));
	assert.deepEqual(byId[A.versionId].createdBy, { id: staff.id, name: 'سلمى الأحمد' }); assert.deepEqual(byId[B.versionId].createdBy, { id: company.id, name: 'شركة النور' }); assert.deepEqual(byId[C.versionId].createdBy, { id: ghost, name: null });
	assert.equal(byId[A.versionId].isMine, true); assert.equal(byId[B.versionId].isMine, false);
	// publish -> state.updatedBy, results and conflicts carry actor objects
	const p = await publish(m, staff.id, 'logo.mark', A.versionId, 0); assert.equal(p.status, 200); assert.deepEqual(p.json.data.updatedBy, { id: staff.id, name: 'سلمى الأحمد' }); assert.deepEqual(p.json.data.active.createdBy, { id: staff.id, name: 'سلمى الأحمد' });
	const conflict = await publish(m, staff.id, 'logo.mark', A.versionId, 0); assert.equal(conflict.status, 409); assert.deepEqual(conflict.json.current.updatedBy, { id: staff.id, name: 'سلمى الأحمد' });
	const ov2 = await m.adm('GET', '/', staff.id); assert.deepEqual(ov2.json.data.items.find((i: any) => i.key === 'logo.mark').state.updatedBy, { id: staff.id, name: 'سلمى الأحمد' });
	userLookups = 0; const hist = await m.adm('GET', '/history', staff.id); assert.equal(userLookups, 1, 'history: one batched lookup');
	assert.deepEqual(hist.json.data.manifest[0].createdBy, { id: staff.id, name: 'سلمى الأحمد' }); assert.ok(hist.json.data.versions.every((v: any) => v.createdBy && 'name' in v.createdBy));
	// no Id-suffixed actor fields and no personal data anywhere in admin payloads; nothing at all on the public routes
	for (const t of [ov.text, ov2.text, hist.text, p.text, conflict.text]) { assert.ok(!/createdById|updatedById/.test(t), 'raw actor id fields are gone'); for (const leak of [staff.email, company.email, PHONE, 'phoneNumber', '@pg.test', '"email"']) assert.ok(!t.includes(leak), `no ${leak}`); }
	const pubManifest = await m.pub(''); const pubBytes = await m.pub(`/assets/logo.mark/${A.sha256}`);
	for (const t of [pubManifest.text]) for (const leak of ['سلمى', staff.id, 'createdBy', 'updatedBy', company.id]) assert.ok(!t.includes(leak), `public manifest leaks ${leak}`);
	assert.ok(!JSON.stringify([...pubBytes.headers.entries()]).includes(staff.id));
	await m.close();
});

// ---------------------------------------------------------------------------------------------------------------- C
test('PG round2 C: exact set-restore preview (default->custom, custom->default, replace, unchanged, target 0), digest binds the apply, stale digest rejected without any change', opts, async () => {
	const e = await env(); await reset(e); const m = await mount(e); const sa = e.sa.id;
	const A = await staged(m, sa, 'logo.mark', 'set-a'); assert.equal((await publish(m, sa, 'logo.mark', A.versionId, 0)).status, 200); // manifest 1
	const S = await m.upload(sa, 'icon.ai', fx('i-ai.svg'), 'image/svg+xml', 'i-ai.svg'); assert.equal((await publish(m, sa, 'icon.ai', S.json.data.versionId, 0)).status, 200); // manifest 2
	const B = await staged(m, sa, 'logo.mark', 'set-b'); assert.equal((await publish(m, sa, 'logo.mark', B.versionId, 1)).status, 200); // manifest 3 (logo B, icon custom)
	const pv = async (v: number, who = sa) => m.adm('GET', `/restore-set/${v}/preview`, who);
	// target 1: logo B -> A (replace), icon custom -> default (to-default), everything else unchanged
	const p1 = await pv(1); assert.equal(p1.status, 200, p1.text); const d1 = p1.json.data;
	assert.equal(d1.currentManifestVersion, 3); assert.equal(d1.targetManifestVersion, 1); assert.match(d1.previewDigest, /^[0-9a-f]{64}$/); assert.equal(d1.items.length, SITE_IDENTITY_REGISTRY.length, 'one row per wired registry key'); assert.equal(d1.changedCount, 2); assert.equal(d1.canApply, true);
	const row = (d: any, k: string) => d.items.find((i: any) => i.key === k);
	assert.equal(row(d1, 'logo.mark').change, 'replace'); assert.equal(row(d1, 'logo.mark').current.version, 2); assert.equal(row(d1, 'logo.mark').current.sha256, B.sha256); assert.equal(row(d1, 'logo.mark').target.version, 1); assert.equal(row(d1, 'logo.mark').target.sha256, A.sha256);
	assert.deepEqual(Object.keys(row(d1, 'logo.mark').current).sort(), ['height', 'mime', 'previewUrl', 'sha256', 'source', 'version', 'versionId', 'width']);
	assert.equal(row(d1, 'logo.mark').target.source, 'custom'); assert.equal(row(d1, 'logo.mark').current.previewUrl, `/admin/site-identity/logo.mark/versions/${B.versionId}/preview`);
	assert.equal(row(d1, 'icon.ai').change, 'to-default'); assert.equal(row(d1, 'icon.ai').current.source, 'custom'); assert.equal(row(d1, 'icon.ai').target.source, 'default'); assert.equal(row(d1, 'icon.ai').target.version, 0); assert.equal(row(d1, 'icon.ai').target.previewUrl, null);
	const def = SITE_IDENTITY_REGISTRY.find(d => d.key === 'icon.ai')!.defaultFingerprint; assert.equal(row(d1, 'icon.ai').target.sha256, def.sha256); assert.equal(row(d1, 'icon.ai').target.mime, def.mime);
	for (const it of d1.items.filter((i: any) => !['logo.mark', 'icon.ai'].includes(i.key))) { assert.equal(it.change, 'unchanged'); assert.equal(it.current.source, 'default'); assert.deepEqual(it.current, it.target); }
	// the same inputs give the same digest; another target another digest; the preview is read-only
	const before = await dbState(e); assert.equal((await pv(1)).json.data.previewDigest, d1.previewDigest); const d0 = (await pv(0)).json.data; assert.notEqual(d0.previewDigest, d1.previewDigest); assert.equal(await dbState(e), before, 'preview changes nothing');
	// target 0: everything custom goes back to the default
	assert.equal(row(d0, 'logo.mark').change, 'to-default'); assert.equal(row(d0, 'icon.ai').change, 'to-default'); assert.equal(d0.targetManifestVersion, 0); assert.equal(d0.changedCount, 2);
	// the version bytes of BOTH sides are readable for a SUPERSEDED / PUBLISHED version through the admin preview route
	const old = await m.raw('GET', row(d1, 'logo.mark').target.previewUrl, sa); assert.equal(old.status, 200); assert.equal(sha(old.buf), A.sha256, 'superseded version bytes are served to the admin preview');
	assert.equal((await m.raw('GET', row(d1, 'logo.mark').current.previewUrl, sa)).status, 200);
	// input errors
	assert.equal((await pv(999)).status, 404); assert.equal((await pv(999)).json.code, 'SITE_IDENTITY_MANIFEST_NOT_FOUND'); assert.equal((await m.adm('GET', '/restore-set/abc/preview', sa)).status, 400); assert.equal((await m.adm('GET', '/restore-set/-1/preview', sa)).status, 400);
	// identical to the current manifest: nothing to apply
	const pCur = (await pv(3)).json.data; assert.equal(pCur.changedCount, 0); assert.equal(pCur.canApply, false); assert.ok(pCur.items.every((i: any) => i.change === 'unchanged'));
	// apply guards: missing / malformed digest -> 400, nothing changes
	for (const bad of [undefined, 'abc', 123, 'g'.repeat(64)]) { const r = await m.adm('POST', '/restore-set', sa, { manifestVersion: 1, expectedManifestVersion: 3, ...(bad === undefined ? {} : { previewDigest: bad }) }); assert.equal(r.status, 400, String(bad)); assert.equal(r.json.errors[0].field, 'previewDigest'); }
	assert.equal(await dbState(e), before);
	// a digest that is not the one previewed (right manifest version) -> PREVIEW_STALE with the fresh preview, nothing changes
	const wrong = await m.adm('POST', '/restore-set', sa, { manifestVersion: 1, expectedManifestVersion: 3, previewDigest: d0.previewDigest }); assert.equal(wrong.status, 409); assert.equal(wrong.json.code, 'SITE_IDENTITY_PREVIEW_STALE'); assert.equal(wrong.json.current.previewDigest, d1.previewDigest); assert.equal(wrong.json.current.targetManifestVersion, 1); assert.equal(await dbState(e), before);
	// the existing manifest-version conflict is kept (right digest, wrong expected)
	const vc = await m.adm('POST', '/restore-set', sa, { manifestVersion: 1, expectedManifestVersion: 2, previewDigest: d1.previewDigest }); assert.equal(vc.status, 409); assert.equal(vc.json.code, 'SITE_IDENTITY_VERSION_CONFLICT'); assert.equal(await dbState(e), before);
	// a CONCURRENT publish between preview and apply -> stale, nothing applied
	const F = await staged(m, sa, 'favicon.tab', 'set-f', 64, 64).catch(async () => null);
	const other = F ?? await staged(m, sa, 'logo.email', 'set-e', 136, 64);
	assert.equal((await publish(m, sa, other.key, other.versionId, 0)).status, 200); // manifest 4, after the preview of target 1
	const mid = await dbState(e);
	const stale = await m.adm('POST', '/restore-set', sa, { manifestVersion: 1, expectedManifestVersion: 3, previewDigest: d1.previewDigest }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'SITE_IDENTITY_PREVIEW_STALE');
	assert.equal(stale.json.current.currentManifestVersion, 4); assert.notEqual(stale.json.current.previewDigest, d1.previewDigest); assert.equal(row(stale.json.current, other.key).change, 'to-default', 'the fresh preview shows the concurrent change'); assert.equal(await dbState(e), mid, 'stale apply changed nothing');
	// stale with BOTH old expected and old digest (what a real page sends) is the same refusal
	const stale2 = await m.adm('POST', '/restore-set', sa, { manifestVersion: 1, expectedManifestVersion: 3, previewDigest: d1.previewDigest }); assert.equal(stale2.json.code, 'SITE_IDENTITY_PREVIEW_STALE');
	// success path with the fresh preview: exactly what the preview listed happens
	const fresh = stale.json.current; const ok = await m.adm('POST', '/restore-set', sa, { manifestVersion: 1, expectedManifestVersion: fresh.currentManifestVersion, previewDigest: fresh.previewDigest });
	assert.equal(ok.status, 200, ok.text); assert.deepEqual(ok.json.data.changedKeys.sort(), fresh.items.filter((i: any) => i.change !== 'unchanged').map((i: any) => i.key).sort()); assert.equal(ok.json.data.manifestVersion, 5);
	const pubItems = (await m.pub('')).json.data.items; assert.equal(pubItems['logo.mark'].sha256, A.sha256); assert.ok(!pubItems['icon.ai'] && !pubItems[other.key]);
	// default -> custom: from the all-default state back to manifest 3 (logo B, icon custom)
	const back = (await pv(3)).json.data; assert.equal(row(back, 'logo.mark').change, 'replace'); assert.equal(row(back, 'logo.mark').current.source, 'custom'); assert.equal(row(back, 'icon.ai').change, 'replace'); assert.equal(row(back, 'icon.ai').current.source, 'default', 'icon.ai is back to the default after manifest 1');
	assert.equal((await m.adm('POST', '/restore-set', sa, { manifestVersion: 0, expectedManifestVersion: 5, previewDigest: (await pv(0)).json.data.previewDigest })).status, 200);
	const dc = (await pv(3)).json.data; assert.equal(row(dc, 'icon.ai').change, 'replace'); assert.equal(row(dc, 'icon.ai').current.source, 'default'); assert.equal(row(dc, 'icon.ai').target.source, 'custom');
	assert.equal((await m.adm('POST', '/restore-set', sa, { manifestVersion: 3, expectedManifestVersion: dc.currentManifestVersion, previewDigest: dc.previewDigest })).status, 200);
	// audit: the set-restore row is secret-free (no digest, no bytes)
	const rows = await e.prisma.accountAuditLog.findMany({ where: { eventType: 'SITE_IDENTITY_SET_RESTORED' } }); assert.ok(rows.length >= 2); for (const r of rows) assert.ok(!/previewDigest|digest|bytes/i.test(JSON.stringify(r.details)), 'no digest/bytes in audit');
	await m.close();
});

// ---------------------------------------------------------------------------------------------------------------- D
test('PG round2 D: publish activates exactly the staged, already sanitised row (no re-read), carries the confirmation fields, refuses another admin\'s / discarded / superseded drafts', opts, async () => {
	const e = await env(); await reset(e); const m = await mount(e); const sa = e.sa.id; const other = (await mkStaff(e, ['site.manage'], 'oth')).user;
	const dirty = Buffer.from(fx('i-ai.svg').toString('utf8').replace('</svg>', '<script>alert(1)</script></svg>'));
	const up = await m.upload(sa, 'icon.ai', dirty, 'image/svg+xml', 'x.svg'); assert.equal(up.status, 201, up.text); const V = up.json.data; assert.ok(V.sanitized.changed, 'the staged row is the sanitised one');
	const staged1 = await m.raw('GET', V.previewUrl, sa); assert.ok(!staged1.text.includes('<script'), 'preview shows the sanitised bytes'); assert.equal(sha(staged1.buf), V.sha256);
	const rowBefore = await e.prisma.siteIdentityAsset.findUnique({ where: { id: V.versionId } });
	// another admin cannot apply it (nothing changes); they may look at the preview
	const dbBefore = await dbState(e); const theirs = await publish(m, other.id, 'icon.ai', V.versionId, 0); assert.equal(theirs.status, 409); assert.equal(theirs.json.code, 'SITE_IDENTITY_DRAFT_NOT_YOURS'); assert.equal(await dbState(e), dbBefore); assert.equal((await m.raw('GET', V.previewUrl, other.id)).status, 200);
	assert.equal((await m.adm('GET', '/', other.id)).json.data.items.find((i: any) => i.key === 'icon.ai').staged[0].isMine, false);
	// the validator/sanitiser must not run at publish
	// PROBE: swap the stored staged bytes for a variant the sanitiser would change (a comment it strips) and keep the row consistent (sha256 + size). If publish re-read / re-sanitised anything, the public bytes would differ from the stored row.
	const probe = Buffer.concat([Buffer.from(rowBefore!.bytes!), Buffer.from('<!-- stored-as-is -->')]); const probeSha = sha(probe);
	await e.prisma.siteIdentityAsset.update({ where: { id: V.versionId }, data: { bytes: Uint8Array.from(probe), sha256: probeSha, byteSize: probe.length } });
	const label = SITE_IDENTITY_REGISTRY.find(d => d.key === 'icon.ai')!;
	const p = await publish(m, sa, 'icon.ai', V.versionId, 0); assert.equal(p.status, 200, p.text); 
	assert.equal(p.json.data.label, label.label); assert.deepEqual(p.json.data.usages, label.usages); assert.equal(p.json.data.fromVersion, 0); assert.equal(p.json.data.toVersion, V.version); assert.equal(p.json.data.active.versionId, V.versionId);
	const rowAfter = await e.prisma.siteIdentityAsset.findUnique({ where: { id: V.versionId } });
	assert.ok(Buffer.from(rowAfter!.bytes!).equals(probe), 'publish activates the stored row byte for byte (never re-read, never re-sanitised)'); assert.equal(rowAfter!.sha256, probeSha); assert.equal(rowAfter!.status, 'PUBLISHED');
	assert.ok((await m.pub(`/assets/icon.ai/${probeSha}`)).buf.equals(probe), 'the public bytes are exactly the stored (previewed) ones');
	// next version: from -> to
	const W = (await m.upload(sa, 'icon.ai', fx('i-ai.svg').toString('utf8').replace('<svg', '<svg data-v="2"') as any, 'image/svg+xml', 'y.svg')); const W2 = W.status === 201 ? W.json.data : await staged(m, sa, 'icon.ai', 'x');
	if (W.status !== 201) assert.fail(W.text);
	const p2 = await publish(m, sa, 'icon.ai', W2.versionId, 1); assert.equal(p2.status, 200, p2.text); assert.equal(p2.json.data.fromVersion, V.version); assert.equal(p2.json.data.toVersion, W2.version);
	// superseded / already published / discarded -> NOT_STAGED, nothing changes
	const d = await staged(m, sa, 'logo.mark', 'to-discard'); assert.equal((await m.adm('DELETE', `/logo.mark/versions/${d.versionId}`, sa)).status, 200);
	const snap = await dbState(e);
	for (const [id, key, ev] of [[V.versionId, 'icon.ai', 2], [W2.versionId, 'icon.ai', 2], [d.versionId, 'logo.mark', 0]] as const) { const r = await publish(m, sa, key, id, ev); assert.equal(r.status, 409, `${id}`); assert.equal(r.json.code, 'SITE_IDENTITY_VERSION_NOT_STAGED'); }
	assert.equal(await dbState(e), snap);
	await m.close();
});

// ---------------------------------------------------------------------------------------------------------------- E
test('PG round2 E: logo.email cache - publish/restore/restore-set/auto-revert refresh it, the shell uses the absolute public URL, the default markup is untouched', opts, async () => {
	const e = await env(); await reset(e); const { siteIdentityCacheTestKit: kit, getEmailLogoUrl, startSiteIdentityCache } = await import('./site-identity-cache'); const { renderEmailShell } = await import('../utils/email-shell');
	const { siteIdentityService } = await import('./site-identity.service'); void siteIdentityService; // registers the DB loader
	kit.reset(); kit.setWired(() => true); process.env.FRONTEND_URL = 'https://front.test/'; delete process.env.EMAIL_ASSET_BASE_URL;
	const render = () => renderEmailShell({ lang: 'ar', docTitle: 't', bodyHtml: '<p>b</p>' });
	const DEFAULT_IMG = '<img src="https://front.test/images/waseet-mark.png" width="34"';
	const m = await mount(e); const sa = e.sa.id;
	try {
		assert.ok(render().includes(DEFAULT_IMG), 'default'); const defaultHtml = render();
		const A = await staged(m, sa, 'logo.email', 'mail-a', 136, 64); assert.ok(render().includes(DEFAULT_IMG), 'a draft changes nothing');
		assert.equal((await publish(m, sa, 'logo.email', A.versionId, 0)).status, 200);
		const urlA = `https://front.test/api/public/site-identity/assets/logo.email/${A.sha256}`; assert.equal(getEmailLogoUrl(), urlA); assert.ok(render().includes(`<img src="${urlA}" width="34"`)); assert.ok(!/localhost|127\.0\.0\.1|\/\/api|api\/\/|api\/api/.test(urlA)); assert.ok(!render().includes('waseet-mark.png'));
		assert.equal((await m.pub(`/assets/logo.email/${A.sha256}`)).status, 200, 'the URL in the mail serves the bytes');
		const B = await staged(m, sa, 'logo.email', 'mail-b', 136, 64); assert.equal((await publish(m, sa, 'logo.email', B.versionId, 1)).status, 200);
		assert.ok(render().includes(B.sha256) && !render().includes(A.sha256)); assert.equal((await m.pub(`/assets/logo.email/${A.sha256}`)).status, 200, 'mails already sent keep working (superseded bytes served)');
		assert.equal((await m.adm('POST', '/logo.email/restore', sa, { target: A.versionId, expectedVersion: 2 })).status, 200); assert.equal(getEmailLogoUrl(), urlA);
		assert.equal((await m.adm('POST', '/logo.email/restore', sa, { target: 'default', expectedVersion: 3 })).status, 200); assert.equal(getEmailLogoUrl(), null); assert.equal(render(), defaultHtml, 'back to default: byte-identical markup');
		// restore-set
		const mv = await manifestNow(m, sa); const pv = (await m.adm('GET', `/restore-set/${mv - 2}/preview`, sa)).json.data; // manifest where logo.email = B
		const rs = await m.adm('POST', '/restore-set', sa, { manifestVersion: mv - 2, expectedManifestVersion: mv, previewDigest: pv.previewDigest }); assert.equal(rs.status, 200, rs.text); assert.ok(getEmailLogoUrl()); assert.ok(render().includes('logo.email/'));
		assert.equal((await m.adm('POST', '/restore-set', sa, { manifestVersion: 0, expectedManifestVersion: mv + 1, previewDigest: (await m.adm('GET', '/restore-set/0/preview', sa)).json.data.previewDigest })).status, 200); assert.equal(getEmailLogoUrl(), null);
		// auto-revert: the post-commit verification fails -> the change is reverted and the cache ends on the default again
		const bad = await mount(e, { faults: { postCommit: async () => { throw new Error('boom'); } } });
		const C = await staged(bad, sa, 'logo.email', 'mail-c', 136, 64); const cur = (await bad.adm('GET', '/', sa)).json.data.items.find((i: any) => i.key === 'logo.email').state.stateVersion;
		const r = await publish(bad, sa, 'logo.email', C.versionId, cur); assert.equal(r.status, 500); assert.equal(getEmailLogoUrl(), null); assert.equal(render(), defaultHtml);
		// not wired -> default whatever is stored
		const D = await staged(m, sa, 'logo.email', 'mail-d', 136, 64); const cur2 = (await m.adm('GET', '/', sa)).json.data.items.find((i: any) => i.key === 'logo.email').state.stateVersion; assert.equal((await publish(m, sa, 'logo.email', D.versionId, cur2)).status, 200); assert.ok(getEmailLogoUrl());
		kit.setWired(() => false); assert.equal(getEmailLogoUrl(), null); assert.equal(render(), defaultHtml); kit.setWired(() => true);
		// no site address configured: never a host-less URL -> default behaviour (no logo at all, as today)
		const keep = process.env.FRONTEND_URL; delete process.env.FRONTEND_URL; assert.equal(getEmailLogoUrl(), null); assert.ok(!render().includes('<img')); process.env.FRONTEND_URL = keep;
		// TTL refresh from another instance's change (written straight to the DB), startup warm-up, failures
		kit.reset(); kit.setWired(() => true); assert.equal(getEmailLogoUrl(), null, 'a cache that was never started does not touch the database'); startSiteIdentityCache();
		await new Promise(r => setTimeout(r, 300)); assert.ok(getEmailLogoUrl(), 'startup load found the active logo');
		const st = await e.prisma.siteIdentityState.findUnique({ where: { key: 'logo.email' } }); await e.prisma.siteIdentityState.update({ where: { key: 'logo.email' }, data: { activeAssetId: null } });
		assert.ok(getEmailLogoUrl(), 'inside the TTL the old value is answered'); kit.set(kit.peek().sha, Date.now() - 61_000); void getEmailLogoUrl(); await new Promise(r => setTimeout(r, 300)); assert.equal(getEmailLogoUrl(), null, 'after the TTL another instance\'s change is picked up');
		await e.prisma.siteIdentityState.update({ where: { key: 'logo.email' }, data: { activeAssetId: st.activeAssetId } });
		kit.reset(); kit.setWired(() => true); kit.setLoader(async () => { throw new Error('db down'); }); startSiteIdentityCache(); await new Promise(r => setTimeout(r, 100)); assert.equal(getEmailLogoUrl(), null, 'startup failure -> default');
		kit.set('a'.repeat(64)); kit.setLoader(async () => { throw new Error('db down'); }); kit.set('a'.repeat(64), Date.now() - 61_000); void getEmailLogoUrl(); await new Promise(r => setTimeout(r, 100)); assert.ok(getEmailLogoUrl()!.endsWith('a'.repeat(64)), 'a later failure keeps the last good value');
	} finally { kit.reset(); process.env.FRONTEND_URL = 'https://front.test'; await m.close(); }
});
