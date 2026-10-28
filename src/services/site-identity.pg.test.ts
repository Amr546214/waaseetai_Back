import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { env, opts, mkStaff, closeEnv } from '../testing/admin-team.pgenv';
import { png } from '../testing/site-identity.pgenv';
import { SITE_IDENTITY_REGISTRY, WIRED_KEYS } from '../config/site-identity.registry';
// round 2 cases run in THIS file's process, after the round-1 cases: both reset the same tables, so they must never run as two parallel test files
import './site-identity-round2.pgenv';
import './site-identity-round5.pgenv';
import './site-identity-round6.pgenv';

/**
 * Site identity on REAL PostgreSQL over HTTP: permissions on EVERY admin route, the upload -> publish -> restore lifecycle, the public manifest / immutable bytes, audit rows, restarts, injected failures
 * (inside the transaction, a corrupt read-back, a failed post-commit verification), and concurrency (two admins, restore-set vs publish, parallel uploads). Database: isolated local :55432 only.
 */
process.env.RATE_LIMIT_ENABLED = 'false'; // the shared upload tier has its own tests; here dozens of uploads run in a row
const opened: Array<{ close: () => Promise<void> }> = [];
after(async () => { for (const m of opened) await m.close().catch(() => undefined); await closeEnv(); });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const FX = path.join(__dirname, '..', 'testing', 'fixtures', 'site-identity');
const fx = (n: string) => fs.readFileSync(path.join(FX, n));
const ALL_ROUTES: Array<[string, string]> = [
	['GET', '/'], ['GET', '/history'], ['GET', '/restore-set/0/preview'], ['GET', `/logo.mark/versions/${randomUUID()}/preview`], ['POST', '/logo.mark/upload'], ['POST', '/logo.mark/publish'], ['POST', '/logo.mark/restore'], ['POST', '/restore-set'], ['DELETE', `/logo.mark/versions/${randomUUID()}`],
];
const WRITE_ROUTES = ALL_ROUTES.filter(r => r[0] !== 'GET');

/** a second HTTP app over the same database with a service of our choice (all keys wired unless said otherwise, optional injected faults) */
async function mount(e: any, serviceOpts: { isWired?: (k: string) => boolean; faults?: any } = {}) {
	const express = (await import('express')).default; const { globalErrorHandler } = await import('../middlewares/error.middleware');
	const { buildAdminSiteIdentityRouter } = await import('../routes/admin-site-identity.routes'); const { buildPublicSiteIdentityRouter } = await import('../routes/public-site-identity.routes');
	const { SiteIdentityService } = await import('./site-identity.service');
	const service = new SiteIdentityService({ isWired: serviceOpts.isWired ?? (() => true), faults: serviceOpts.faults });
	const app = express(); app.use(express.json()); app.use('/admin/site-identity', buildAdminSiteIdentityRouter(service)); app.use('/public', buildPublicSiteIdentityRouter(service)); app.use(globalErrorHandler as any);
	const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const raw = async (method: string, url: string, who?: string | null, body?: any, headers: Record<string, string> = {}) => {
		const isForm = body instanceof FormData;
		const res = await fetch(base + url, { method, headers: { connection: 'close', ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }), ...(who ? { 'x-test-user': who } : {}), ...headers }, body: body === undefined || method === 'GET' ? undefined : isForm ? body : JSON.stringify(body) });
		const buf = Buffer.from(await res.arrayBuffer()); let json: any = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* bytes */ }
		return { status: res.status, headers: res.headers, json, buf };
	};
	const adm = (method: string, p: string, who: string, body?: any) => raw(method, `/admin/site-identity${p}`, who, body);
	const pub = (p: string, headers?: Record<string, string>) => raw('GET', `/public/site-identity${p}`, null, undefined, headers);
	const upload = (who: string, key: string, bytes: Uint8Array, mime = 'image/png', name = 'a.png') => { const f = new FormData(); f.append('file', new Blob([bytes], { type: mime }), name); return adm('POST', `/${key}/upload`, who, f); };
	const handle = { service, base, raw, adm, pub, upload, close: async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); } }; opened.push(handle); return handle;
}
const reset = async (e: any) => { await e.prisma.siteIdentityState.deleteMany({}); await e.prisma.siteIdentityManifest.deleteMany({}); await e.prisma.siteIdentityAsset.deleteMany({}); await e.prisma.accountAuditLog.deleteMany({ where: { eventType: { startsWith: 'SITE_IDENTITY_' } } }); };
const staged = async (m: any, who: string, key: string, tag: string, w = 300, h = 200) => { const r = await m.upload(who, key, png(w, h, { text: tag })); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.data; };
const stateOf = async (m: any, who: string, key: string) => (await m.adm('GET', '/', who)).json.data.items.find((i: any) => i.key === key).state;
/** a restore-set body with the digest of a fresh preview (what the page does); `digest` overrides it */
const setBody = async (m: any, who: string, manifestVersion: number, expectedManifestVersion: number, digest?: string) => ({ manifestVersion, expectedManifestVersion, previewDigest: digest ?? (await m.adm('GET', `/restore-set/${manifestVersion}/preview`, who)).json?.data?.previewDigest ?? 'f'.repeat(64) });
const publish = (m: any, who: string, key: string, versionId: string, expectedVersion: number) => m.adm('POST', `/${key}/publish`, who, { versionId, expectedVersion });

test('PG site identity: permissions - EVERY admin route is 403 without site.view / site.manage (direct request), view-only reads but cannot write, manage does everything, others 403, anonymous 401', opts, async () => {
	const e = await env(); await reset(e); const m = await mount(e);
	const none = (await mkStaff(e, ['users.view', 'settings.manage', 'audit.view'], 'sn')).user, viewer = (await mkStaff(e, ['site.view'], 'sv')).user, manager = (await mkStaff(e, ['site.manage'], 'sm')).user, bare = await e.mkUser('ADMIN', 'sb');
	const client = await e.mkUser('CLIENT_INDIVIDUAL', 'sc'), provider = await e.mkUser('PROVIDER_INDIVIDUAL', 'sp'), marketer = await e.mkUser('MARKETING_BROKER', 'smk');
	// the PRODUCTION routers (the ones app.ts mounts, with the real WIRED_KEYS)
	for (const [method, p] of ALL_ROUTES) {
		for (const [who, label] of [[none, 'staff without the permission'], [bare, 'ADMIN with no grant'], [client, 'client'], [provider, 'provider'], [marketer, 'marketer']] as const) {
			const r = await e.call(method, `/admin/site-identity${p}`, who.id, method === 'GET' || method === 'DELETE' ? undefined : {});
			assert.equal(r.status, 403, `${label}: ${method} ${p} -> ${r.status}`); assert.ok(!/"data"/.test(r.text), 'no data in a refusal');
		}
		assert.equal((await e.call(method, `/admin/site-identity${p}`, null, {})).status, 401, `anonymous ${method} ${p}`);
	}
	// view-only: reads yes, every write 403
	for (const [method, p] of ALL_ROUTES) {
		const r = await e.call(method, `/admin/site-identity${p}`, viewer.id, method === 'GET' || method === 'DELETE' ? undefined : {});
		if (method === 'GET') assert.notEqual(r.status, 403, `viewer ${method} ${p}`); else assert.equal(r.status, 403, `viewer must not ${method} ${p}`);
	}
	assert.equal((await e.call('GET', '/admin/site-identity', viewer.id)).json.data.canManage, false);
	// manage (alone) passes every guard: writes end in the handler (an unwired key answers 409, never 403)
	for (const [method, p] of ALL_ROUTES) { const r = await e.call(method, `/admin/site-identity${p}`, manager.id, method === 'GET' || method === 'DELETE' ? undefined : {}); assert.notEqual(r.status, 403, `manager ${method} ${p}`); assert.notEqual(r.status, 401); }
	assert.equal((await e.call('GET', '/admin/site-identity', manager.id)).json.data.canManage, true);
	// SUPER_ADMIN by account type
	for (const [method, p] of ALL_ROUTES) { const r = await e.call(method, `/admin/site-identity${p}`, e.sa.id, method === 'GET' || method === 'DELETE' ? undefined : {}); assert.notEqual(r.status, 403, `SUPER_ADMIN ${method} ${p}`); }
	// the same through the wired service (so the handlers really run)
	for (const [method, p] of WRITE_ROUTES) for (const who of [none, viewer, client]) assert.equal((await m.raw(method, `/admin/site-identity${p}`, who.id, method === 'DELETE' ? undefined : {})).status, 403, `wired ${method} ${p}`);
	await m.close();
});

test('PG site identity: public routes need no login and expose ONLY the published manifest / bytes; every key of the registry is listed unwired on the production service', opts, async () => {
	const e = await env(); await reset(e);
	const r = await e.call('GET', '/public/site-identity', null); assert.equal(r.status, 200); assert.deepEqual(r.json.data, { version: 0, items: {} });
	const sa = (await e.call('GET', '/admin/site-identity', e.sa.id)).json.data;
	assert.deepEqual(sa.items.map((i: any) => i.key), SITE_IDENTITY_REGISTRY.map(d => d.key));
	for (const it of sa.items) { assert.equal(it.wired, WIRED_KEYS.includes(it.key)); assert.equal(it.editable, it.wired); assert.equal(it.notWiredReason === null, it.wired); assert.ok(it.defaultFingerprint.sha256); assert.ok(it.usages.length > 0); assert.ok(it.rules.length >= 2); }
	assert.ok(sa.notIdentity.length >= 5);
	if (!WIRED_KEYS.includes('logo.mark')) {
		const m = await mount(e, { isWired: (k) => WIRED_KEYS.includes(k) }); const f = new FormData(); f.append('file', new Blob([png(300, 200)], { type: 'image/png' }), 'a.png');
		const up = await m.adm('POST', '/logo.mark/upload', e.sa.id, f); assert.equal(up.status, 409); assert.equal(up.json.code, 'SITE_IDENTITY_KEY_NOT_WIRED'); assert.equal(await e.prisma.siteIdentityAsset.count(), 0, 'nothing is stored for a key that is not wired'); await m.close();
	}
	assert.equal((await e.call('GET', '/admin/site-identity/nope.nope/versions/x/preview', e.sa.id)).status, 404);
});

test('PG site identity: lifecycle - upload (staged, invisible) -> publish -> public manifest + immutable bytes -> second version -> restore -> default -> restore-set -> discard; persistence across a restart; audit rows', opts, async () => {
	const e = await env(); await reset(e); const m = await mount(e); const sa = e.sa.id;
	const viewer = (await mkStaff(e, ['site.view'], 'lv')).user;
	const A = await staged(m, sa, 'logo.mark', 'variant-a');
	assert.equal(A.status, 'STAGED'); assert.equal(A.version, 1); assert.equal(A.mime, 'image/png'); assert.equal(A.width, 300); assert.equal(A.height, 200); assert.equal(A.sha256, sha(png(300, 200, { text: 'variant-a' }))); assert.equal(A.sanitized.changed, false);
	assert.equal(A.previewUrl, `/admin/site-identity/logo.mark/versions/${A.versionId}/preview`); assert.equal(A.url, null, 'a staged version has no public URL');
	// the preview serves the bytes to an admin only, never cached, nosniff
	const pv = await m.raw('GET', `/admin/site-identity/logo.mark/versions/${A.versionId}/preview`, viewer.id); assert.equal(pv.status, 200); assert.ok(pv.buf.equals(png(300, 200, { text: 'variant-a' }))); assert.equal(pv.headers.get('x-content-type-options'), 'nosniff'); assert.match(pv.headers.get('cache-control')!, /no-store/); assert.equal(pv.headers.get('content-type'), 'image/png');
	assert.equal((await m.raw('GET', `/admin/site-identity/logo.mark/versions/${A.versionId}/preview`, null)).status, 401);
	// a staged upload is invisible to the public
	assert.deepEqual((await m.pub('')).json.data, { version: 0, items: {} }); assert.equal((await m.pub(`/assets/logo.mark/${A.sha256}`)).status, 404);
	// publish: stale expected version -> 409 with the current state; bad bodies -> 400
	assert.equal((await publish(m, sa, 'logo.mark', A.versionId, 5)).status, 409);
	assert.equal((await m.adm('POST', '/logo.mark/publish', sa, { versionId: 'x', expectedVersion: 0 })).status, 400); assert.equal((await m.adm('POST', '/logo.mark/publish', sa, { versionId: A.versionId })).status, 400); assert.equal((await m.adm('POST', '/logo.mark/publish', sa, { versionId: randomUUID(), expectedVersion: 0 })).status, 404);
	const p1 = await publish(m, sa, 'logo.mark', A.versionId, 0); assert.equal(p1.status, 200, JSON.stringify(p1.json)); assert.equal(p1.json.data.stateVersion, 1); assert.equal(p1.json.data.manifestVersion, 1); assert.equal(p1.json.data.active.sha256, A.sha256); assert.equal(p1.json.data.isDefault, false);
	assert.equal((await publish(m, sa, 'logo.mark', A.versionId, 1)).status, 409, 'a published version cannot be published again');
	// public manifest: only the active custom key, with the fields the design lists and nothing else
	const man = await m.pub(''); assert.equal(man.status, 200); const data = man.json.data; assert.equal(data.version, 1); assert.deepEqual(Object.keys(data.items), ['logo.mark']);
	assert.deepEqual(Object.keys(data.items['logo.mark']).sort(), ['height', 'mime', 'sha256', 'url', 'version', 'width']); assert.equal(data.items['logo.mark'].url, `/public/site-identity/assets/logo.mark/${A.sha256}`);
	assert.match(man.headers.get('cache-control')!, /public, max-age=60/); const etag = man.headers.get('etag')!; assert.ok(etag); assert.equal((await m.pub('', { 'if-none-match': etag })).status, 304);
	for (const forbidden of ['createdById', 'updatedById', 'bytes', 'status', 'history', 'staged', 'note', 'activeAssetId', 'previewUrl', 'versionId']) assert.ok(!man.buf.toString().includes(forbidden), `public manifest must not expose ${forbidden}`);
	// public bytes: immutable, correct type, nosniff
	const asset = await m.pub(`/assets/logo.mark/${A.sha256}`); assert.equal(asset.status, 200); assert.ok(asset.buf.equals(png(300, 200, { text: 'variant-a' })));
	assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable'); assert.equal(asset.headers.get('content-type'), 'image/png'); assert.equal(asset.headers.get('x-content-type-options'), 'nosniff'); assert.equal(asset.headers.get('etag'), `"${A.sha256}"`);
	assert.equal((await m.pub(`/assets/logo.mark/${A.sha256}`, { 'if-none-match': `"${A.sha256}"` })).status, 304);
	assert.equal((await m.pub(`/assets/logo.mark/${'0'.repeat(64)}`)).status, 404); assert.equal((await m.pub(`/assets/favicon.tab/${A.sha256}`)).status, 404, 'the bytes are bound to their key'); assert.equal((await m.pub(`/assets/logo.mark/not-a-sha`)).status, 404); assert.equal((await m.pub(`/assets/..%2Fx/${A.sha256}`)).status, 404);
	// SVG bytes carry the sandbox policy
	const S = await m.upload(sa, 'icon.ai', fx('i-ai.svg'), 'image/svg+xml', 'i-ai.svg'); assert.equal(S.status, 201, JSON.stringify(S.json)); assert.equal(S.json.data.mime, 'image/svg+xml'); assert.equal(S.json.data.width, 24);
	assert.equal((await publish(m, sa, 'icon.ai', S.json.data.versionId, 0)).status, 200);
	const svg = await m.pub(`/assets/icon.ai/${S.json.data.sha256}`); assert.equal(svg.status, 200); assert.equal(svg.headers.get('content-type'), 'image/svg+xml'); assert.equal(svg.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox"); assert.equal(svg.headers.get('content-disposition'), 'inline'); assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
	// second version of logo.mark; the superseded bytes stay downloadable for open pages
	const B = await staged(m, sa, 'logo.mark', 'variant-b'); assert.equal(B.version, 2);
	const p2 = await publish(m, sa, 'logo.mark', B.versionId, 1); assert.equal(p2.status, 200); assert.equal(p2.json.data.stateVersion, 2); assert.equal(p2.json.data.previous.versionId, A.versionId); assert.equal(p2.json.data.manifestVersion, 3);
	assert.equal((await m.pub(`/assets/logo.mark/${A.sha256}`)).status, 200, 'old URL keeps working'); assert.equal((await m.pub('')).json.data.items['logo.mark'].sha256, B.sha256);
	const st = await e.prisma.siteIdentityAsset.findMany({ where: { key: 'logo.mark' }, orderBy: { version: 'asc' } }); assert.deepEqual(st.map(r => r.status), ['SUPERSEDED', 'PUBLISHED']);
	// restore to the previous version (needs the current state version) and to the default
	assert.equal((await m.adm('POST', '/logo.mark/restore', sa, { target: A.versionId, expectedVersion: 1 })).status, 409);
	assert.equal((await m.adm('POST', '/logo.mark/restore', sa, { target: B.versionId, expectedVersion: 2 })).status, 409, 'already the active one');
	assert.equal((await m.adm('POST', '/logo.mark/restore', sa, { target: 'nonsense', expectedVersion: 2 })).status, 400);
	const r1 = await m.adm('POST', '/logo.mark/restore', sa, { target: A.versionId, expectedVersion: 2 }); assert.equal(r1.status, 200, JSON.stringify(r1.json)); assert.equal(r1.json.data.active.versionId, A.versionId); assert.equal(r1.json.data.stateVersion, 3);
	const C = await staged(m, sa, 'logo.mark', 'variant-c'); assert.equal((await m.adm('POST', '/logo.mark/restore', sa, { target: C.versionId, expectedVersion: 3 })).status, 409, 'a draft is published, not restored');
	const r2 = await m.adm('POST', '/logo.mark/restore', sa, { target: 'default', expectedVersion: 3 }); assert.equal(r2.status, 200); assert.equal(r2.json.data.isDefault, true); assert.equal(r2.json.data.active, null); assert.equal(r2.json.data.stateVersion, 4);
	assert.deepEqual(Object.keys((await m.pub('')).json.data.items), ['icon.ai'], 'default again: the key leaves the public manifest');
	assert.equal((await m.adm('POST', '/logo.mark/restore', sa, { target: 'default', expectedVersion: 4 })).status, 409, 'already default');
	assert.equal((await m.pub(`/assets/logo.mark/${A.sha256}`)).status, 200, 'rows are never deleted: even after a restore to default the old bytes are served');
	// restore a whole manifest snapshot: manifest 1 = {logo.mark: A} only
	const hist = (await m.adm('GET', '/history', sa)).json.data; assert.ok(hist.manifest.length >= 5); assert.ok(hist.versions.every((v: any) => !('bytes' in v)));
	const cur = (await m.adm('GET', '/', sa)).json.data.manifestVersion; assert.equal((await m.adm('POST', '/restore-set', sa, await setBody(m, sa, 1, cur - 1))).status, 409);
	const rs = await m.adm('POST', '/restore-set', sa, await setBody(m, sa, 1, cur)); assert.equal(rs.status, 200, JSON.stringify(rs.json)); assert.deepEqual(rs.json.data.changedKeys.sort(), ['icon.ai', 'logo.mark']);
	const after = (await m.pub('')).json.data; assert.deepEqual(Object.keys(after.items), ['logo.mark']); assert.equal(after.items['logo.mark'].sha256, A.sha256, 'icon.ai was default at manifest 1, logo.mark was A');
	assert.equal((await m.adm('POST', '/restore-set', sa, await setBody(m, sa, rs.json.data.manifestVersion, rs.json.data.manifestVersion))).status, 409, 'already identical');
	assert.equal((await m.adm('POST', '/restore-set', sa, await setBody(m, sa, 999, rs.json.data.manifestVersion))).status, 404);
	assert.equal((await m.adm('POST', '/restore-set', sa, { manifestVersion: 'x', expectedManifestVersion: 1, previewDigest: 'f'.repeat(64) })).status, 400);
	// discard: only drafts; the bytes are dropped; published / superseded rows are refused
	const D = await staged(m, sa, 'logo.mark', 'variant-d'); assert.equal((await m.adm('DELETE', `/logo.mark/versions/${A.versionId}`, sa)).status, 409);
	const dd = await m.adm('DELETE', `/logo.mark/versions/${D.versionId}`, sa); assert.equal(dd.status, 200); assert.equal(dd.json.data.status, 'DISCARDED'); const dr = await e.prisma.siteIdentityAsset.findUniqueOrThrow({ where: { id: D.versionId } }); assert.equal(dr.bytes, null); assert.equal(dr.status, 'DISCARDED');
	assert.equal((await m.pub(`/assets/logo.mark/${D.sha256}`)).status, 404); assert.equal((await m.raw('GET', `/admin/site-identity/logo.mark/versions/${D.versionId}/preview`, sa)).status, 404); assert.equal((await m.adm('DELETE', `/logo.mark/versions/${D.versionId}`, sa)).status, 409);
	assert.equal((await m.adm('DELETE', `/logo.mark/versions/${randomUUID()}`, sa)).status, 404);
	// persistence: a brand-new service / app (a restarted process) reads the same state back from the database
	const m2 = await mount(e); const again = (await m2.pub('')).json.data; assert.deepEqual(again, after); assert.equal((await m2.pub(`/assets/logo.mark/${A.sha256}`)).buf.length, png(300, 200, { text: 'variant-a' }).length);
	assert.equal((await stateOf(m2, sa, 'logo.mark')).active.sha256, A.sha256); await m2.close();
	// audit: every action wrote its row, with the key, the versions and SHORT sha prefixes only (no bytes, no full hash)
	const rows = await e.prisma.accountAuditLog.findMany({ where: { eventType: { startsWith: 'SITE_IDENTITY_' } }, orderBy: { occurredAt: 'asc' } });
	const codes = new Set(rows.map(r => r.eventType)); for (const c of ['SITE_IDENTITY_UPLOADED', 'SITE_IDENTITY_PUBLISHED', 'SITE_IDENTITY_RESTORED', 'SITE_IDENTITY_SET_RESTORED', 'SITE_IDENTITY_DISCARDED']) assert.ok(codes.has(c), c);
	for (const r of rows) { assert.equal(r.userId, sa); assert.equal(r.source, 'ADMIN'); assert.equal(r.actorLabel, 'ADMIN'); assert.ok(r.ipAddress !== undefined); const blob = JSON.stringify([r.metaData, r.beforeData, r.afterData, r.summary, r.title]); assert.ok(!/[0-9a-f]{40,}/.test(blob), `no full hash in ${r.eventType}`); assert.ok(!/iVBOR|\bbytes\b/i.test(blob), blob); assert.ok((r.metaData as any).identityKey); }
	const pubd = rows.find(r => r.eventType === 'SITE_IDENTITY_PUBLISHED' && (r.metaData as any).toVersion === 2)!; assert.deepEqual({ ...(pubd.metaData as any) }, { identityKey: 'logo.mark', fromVersion: 1, toVersion: 2, fromSha: A.sha256.slice(0, 12), toSha: B.sha256.slice(0, 12), stateVersion: 2 }); assert.equal(pubd.severity, 'WARNING');
	// the central audit trail reads these rows with a proven actor, a target, an Arabic label, severity and short detail
	const { listAuditTrail } = await import('./admin-audit-trail.service'); const trail = await listAuditTrail({ eventType: 'SITE_IDENTITY_PUBLISHED', limit: 10 });
	assert.ok(trail.items.length >= 2); for (const it of trail.items) { assert.equal(it.actor.id, sa); assert.equal(it.target.type, 'SITE_IDENTITY'); assert.equal(it.severity, 'WARNING'); assert.equal(it.actionLabel, 'اعتماد نسخة من هوية الموقع'); assert.ok(!/[0-9a-f]{20,}/.test(it.detail ?? '')); }
	await m.close();
});

test('PG site identity: input errors and limits - unknown key, no file, wrong format for the key, draft cap, identical to the active file', opts, async () => {
	const e = await env(); await reset(e); const m = await mount(e); const sa = e.sa.id;
	assert.equal((await m.upload(sa, 'nope.nope', png(300, 200))).status, 404); assert.equal((await m.adm('POST', '/logo.mark/upload', sa, {})).status, 400);
	const bad = await m.upload(sa, 'logo.mark', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 'x.png'); assert.equal(bad.status, 400); assert.equal(bad.json.code, 'SITE_IDENTITY_FILE_REJECTED'); assert.ok(bad.json.errors[0].message);
	assert.equal((await m.upload(sa, 'logo.email', fx('i-ai.svg'), 'image/svg+xml', 'x.svg')).status, 400);
	assert.equal(await e.prisma.siteIdentityAsset.count(), 0, 'a rejected upload stores nothing');
	const big = await m.upload(sa, 'logo.mark', png(300, 200, { text: 'x'.repeat(700 * 1024) })); assert.ok([400, 413].includes(big.status)); assert.equal(await e.prisma.siteIdentityAsset.count(), 0);
	// hostile svg is cleaned, stored cleaned, the note says what was removed
	const hostile = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><circle cx="12" cy="12" r="5"/></svg>');
	const h = await m.upload(sa, 'icon.ai', hostile, 'image/svg+xml', 'h.svg'); assert.equal(h.status, 201); assert.equal(h.json.data.sanitized.changed, true); assert.match(h.json.data.note, /أُزيل/);
	const stored = await e.prisma.siteIdentityAsset.findUniqueOrThrow({ where: { id: h.json.data.versionId } }); assert.ok(!/script|onload|alert/i.test(Buffer.from(stored.bytes!).toString())); assert.equal(sha(stored.bytes!), stored.sha256);
	// draft cap per key
	for (let i = 0; i < 5; i++) await staged(m, sa, 'logo.boot', `d${i}`); const over = await m.upload(sa, 'logo.boot', png(300, 200, { text: 'd-over' })); assert.equal(over.status, 409); assert.equal(over.json.code, 'SITE_IDENTITY_TOO_MANY_STAGED');
	// uploading exactly the active file is a no-op conflict
	const X = await staged(m, sa, 'logo.email', 'same'); assert.equal((await publish(m, sa, 'logo.email', X.versionId, 0)).status, 200); const dup = await m.upload(sa, 'logo.email', png(300, 200, { text: 'same' })); assert.equal(dup.status, 409); assert.equal(dup.json.code, 'SITE_IDENTITY_NO_CHANGE');
	// keys that are not wired refuse while wired ones work (one service, mixed)
	const mixed = await mount(e, { isWired: k => k === 'logo.mark' }); assert.equal((await mixed.upload(sa, 'favicon.tab', png(300, 200))).status, 409); assert.equal((await mixed.upload(sa, 'logo.mark', png(300, 200, { text: 'm' }))).status, 201);
	assert.equal((await mixed.adm('POST', '/favicon.tab/publish', sa, { versionId: randomUUID(), expectedVersion: 0 })).json.code, 'SITE_IDENTITY_KEY_NOT_WIRED'); assert.equal((await mixed.adm('POST', '/favicon.tab/restore', sa, { target: 'default', expectedVersion: 0 })).json.code, 'SITE_IDENTITY_KEY_NOT_WIRED');
	const mixedOverview = (await mixed.adm('GET', '/', sa)).json.data.items; assert.equal(mixedOverview.find((i: any) => i.key === 'logo.mark').editable, true); assert.equal(mixedOverview.find((i: any) => i.key === 'favicon.tab').editable, false);
	await mixed.close(); await m.close();
});

test('PG site identity: atomicity - a failure inside the transaction (after the state, the manifest or the audit write) or a corrupt read-back leaves the active identity untouched and writes nothing; a failed post-commit verification is reverted', opts, async () => {
	const e = await env(); await reset(e); const sa = e.sa.id; const ok = await mount(e);
	const base = await staged(ok, sa, 'logo.mark', 'base'); assert.equal((await publish(ok, sa, 'logo.mark', base.versionId, 0)).status, 200);
	const next = await staged(ok, sa, 'logo.mark', 'next'); const other = await staged(ok, sa, 'icon.ai' === 'x' ? 'logo.mark' : 'logo.boot', 'o');
	const snapshot = async () => ({ states: await e.prisma.siteIdentityState.findMany({ orderBy: { key: 'asc' } }), manifests: await e.prisma.siteIdentityManifest.count(), assets: (await e.prisma.siteIdentityAsset.findMany({ orderBy: [{ key: 'asc' }, { version: 'asc' }], select: { id: true, status: true, sha256: true } })), audits: await e.prisma.accountAuditLog.count({ where: { eventType: { startsWith: 'SITE_IDENTITY_' } } }), pub: (await ok.pub('')).json.data });
	const before = await snapshot();
	for (const step of ['after-state', 'after-manifest', 'after-audit'] as const) {
		const boom = await mount(e, { faults: { insideTx: async (_tx: any, s: string) => { if (s === step) throw new Error(`injected failure ${step}`); } } });
		const r = await publish(boom, sa, 'logo.mark', next.versionId, 1); assert.equal(r.status, 500, step); assert.ok(!/injected/.test(JSON.stringify(r.json)), 'no internals leaked');
		assert.deepEqual(await snapshot(), before, `publish: nothing changed after a failure at ${step}`);
		const r2 = await boom.adm('POST', '/logo.mark/restore', sa, { target: 'default', expectedVersion: 1 }); assert.equal(r2.status, 500); assert.deepEqual(await snapshot(), before, `restore: untouched (${step})`);
		const r3 = await boom.adm('POST', '/restore-set', sa, await setBody(boom, sa, 0, before.manifests)); assert.equal(r3.status, 500); assert.deepEqual(await snapshot(), before, `restore-set: untouched (${step})`);
		await boom.close();
	}
	// the read-back finds corrupted bytes: refuse BEFORE the commit
	const corrupt = await mount(e, { faults: { readBack: (row: any) => ({ bytes: Buffer.concat([Buffer.from(row.bytes), Buffer.from([0])]), sha256: row.sha256 }) } });
	const rc = await publish(corrupt, sa, 'logo.mark', next.versionId, 1); assert.equal(rc.status, 500); assert.equal(rc.json.code, 'SITE_IDENTITY_VERIFY_FAILED'); assert.deepEqual(await snapshot(), before, 'a failing read-back leaves the active identity untouched');
	await corrupt.close();
	// a row whose stored bytes do not match its recorded hash cannot be activated
	const tampered = await staged(ok, sa, 'logo.mark', 'tampered'); await e.prisma.siteIdentityAsset.update({ where: { id: tampered.versionId }, data: { bytes: Buffer.from('not the recorded bytes') } });
	const before2 = await snapshot(); const rt = await publish(ok, sa, 'logo.mark', tampered.versionId, 1); assert.equal(rt.status, 500); assert.deepEqual(await snapshot(), before2, 'tampered storage is never activated');
	// post-commit verification fails: the success is NOT reported and the previous identity is put back by a compensating transaction
	let calls = 0; const late = await mount(e, { faults: { postCommit: async () => { if (calls++ === 0) throw new Error('verification connection lost'); } } });
	const rl = await publish(late, sa, 'logo.mark', next.versionId, 1); assert.equal(rl.status, 500); assert.equal(rl.json.code, 'SITE_IDENTITY_VERIFY_FAILED');
	const pubNow = (await ok.pub('')).json.data.items['logo.mark']; assert.equal(pubNow.sha256, base.sha256, 'the previous identity is active again'); await late.close();
	const rows = await e.prisma.siteIdentityAsset.findMany({ where: { key: 'logo.mark' }, orderBy: { version: 'asc' } }); assert.equal(rows.filter(r => r.status === 'PUBLISHED').length, 1); assert.equal(rows.find(r => r.status === 'PUBLISHED')!.sha256, base.sha256);
	assert.ok((await e.prisma.siteIdentityManifest.findMany({ orderBy: { version: 'desc' }, take: 1 }))[0].reason.startsWith('auto-revert'));
	void other;
	await ok.close();
});

test('PG site identity: concurrency - two admins publishing against the same expectedVersion: exactly one wins, the other gets 409 with the winner\'s state', opts, async () => {
	const e = await env(); await reset(e); const m = await mount(e); const sa = e.sa.id; const a2 = (await mkStaff(e, ['site.manage'], 'cc2')).user;
	for (let round = 0; round < 4; round++) {
		await reset(e);
		const A = await staged(m, sa, 'logo.mark', `A${round}`), B = await staged(m, a2.id, 'logo.mark', `B${round}`);
		const [ra, rb] = await Promise.all([publish(m, sa, 'logo.mark', A.versionId, 0), publish(m, a2.id, 'logo.mark', B.versionId, 0)]);
		const statuses = [ra.status, rb.status].sort(); assert.deepEqual(statuses, [200, 409], `round ${round}: ${JSON.stringify([ra.json, rb.json]).slice(0, 300)}`);
		const win = ra.status === 200 ? A : B, lose = ra.status === 200 ? rb : ra;
		assert.equal(lose.json.code, 'SITE_IDENTITY_VERSION_CONFLICT'); assert.equal(lose.json.current.stateVersion, 1); assert.equal(lose.json.current.active.versionId, win.versionId, 'the loser is shown the winner\'s state'); assert.equal(lose.json.current.isDefault, false);
		const rows = await e.prisma.siteIdentityAsset.findMany({ where: { key: 'logo.mark' } }); assert.equal(rows.filter(r => r.status === 'PUBLISHED').length, 1); assert.equal(rows.filter(r => r.status === 'STAGED').length, 1);
		assert.equal(await e.prisma.siteIdentityManifest.count(), 1, 'one manifest row: the loser wrote nothing'); assert.equal((await e.prisma.siteIdentityState.findUniqueOrThrow({ where: { key: 'logo.mark' } })).version, 1);
		assert.equal(await e.prisma.accountAuditLog.count({ where: { eventType: 'SITE_IDENTITY_PUBLISHED' } }), 1);
	}
	await m.close();
});

test('PG site identity: concurrency - restore-set vs publish on the same key: exactly one wins whichever runs first, manifest versions stay consecutive, one published row per key', opts, async () => {
	const e = await env(); const m = await mount(e); const sa = e.sa.id; const a2 = (await mkStaff(e, ['site.manage'], 'cr2')).user; const seen = new Set<string>();
	for (let round = 0; round < 8; round++) {
		await reset(e);
		const A = await staged(m, sa, 'logo.mark', `r${round}A`); assert.equal((await publish(m, sa, 'logo.mark', A.versionId, 0)).status, 200); // manifest 1, key version 1
		const B = await staged(m, a2.id, 'logo.mark', `r${round}B`);
		const pubP = () => publish(m, a2.id, 'logo.mark', B.versionId, 1), setBodyNow = await setBody(m, sa, 0, 1), setP = () => m.adm('POST', '/restore-set', sa, setBodyNow);
		const [x, y] = round % 2 ? await Promise.all([pubP(), setP()]) : (await Promise.all([setP(), pubP()])).reverse();
		const [rp, rs] = [x, y]; assert.deepEqual([rp.status, rs.status].sort(), [200, 409], `round ${round}: publish ${rp.status} restore-set ${rs.status}`); seen.add(rp.status === 200 ? 'publish-first' : 'restore-first');
		const loser = rp.status === 200 ? rs : rp; assert.equal(loser.json.code, 'SITE_IDENTITY_VERSION_CONFLICT'); assert.ok(loser.json.current, 'conflict carries the current state');
		const mans = await e.prisma.siteIdentityManifest.findMany({ orderBy: { version: 'asc' } }); assert.deepEqual(mans.map(r => r.version), [1, 2], 'consecutive manifest versions, no gap, no duplicate');
		const rows = await e.prisma.siteIdentityAsset.findMany({ where: { key: 'logo.mark' } }); assert.equal(rows.filter(r => r.status === 'PUBLISHED').length, rp.status === 200 ? 1 : 0);
		const pubItems = (await m.pub('')).json.data.items; assert.equal(Object.keys(pubItems).length, rp.status === 200 ? 1 : 0, 'public manifest reflects the winner');
		assert.equal((await e.prisma.siteIdentityState.findUniqueOrThrow({ where: { key: 'logo.mark' } })).version, 2);
	}
	assert.ok(seen.size >= 1); await m.close();
});

test('PG site identity: concurrency - parallel uploads of one key get distinct consecutive versions; parallel publishes of different keys both succeed in a consistent manifest chain', opts, async () => {
	const e = await env(); await reset(e); const m = await mount(e); const sa = e.sa.id;
	const ups = await Promise.all(Array.from({ length: 5 }, (_, i) => m.upload(sa, 'logo.mark', png(300, 200, { text: `p${i}` })))); assert.deepEqual(ups.map(r => r.status), [201, 201, 201, 201, 201], JSON.stringify(ups.map(r => r.json?.message)));
	assert.deepEqual(ups.map(r => r.json.data.version).sort(), [1, 2, 3, 4, 5]);
	const k1 = await staged(m, sa, 'logo.boot', 'k1'), k2 = await staged(m, sa, 'logo.email', 'k2');
	const rs = await Promise.all([publish(m, sa, 'logo.boot', k1.versionId, 0), publish(m, sa, 'logo.email', k2.versionId, 0)]); assert.deepEqual(rs.map(r => r.status), [200, 200]);
	assert.deepEqual((await e.prisma.siteIdentityManifest.findMany({ orderBy: { version: 'asc' } })).map(r => r.version), [1, 2]);
	const last = await e.prisma.siteIdentityManifest.findUniqueOrThrow({ where: { version: 2 } }); assert.deepEqual(Object.keys(last.snapshot as any).sort(), ['logo.boot', 'logo.email'], 'the second manifest holds the FULL state');
	await m.close();
});

test('PG site identity: database integrity rules of the migration (one published row per key, status values, bytes only absent on discarded rows, active pointer cannot dangle)', opts, async () => {
	const e = await env(); await reset(e); const mk = (o: any) => e.prisma.siteIdentityAsset.create({ data: { key: 'logo.mark', version: o.version, status: o.status, mime: 'image/png', bytes: o.bytes === undefined ? Buffer.from('x') : o.bytes, sha256: 'a'.repeat(64), byteSize: 1, ...o.extra } });
	await mk({ version: 1, status: 'PUBLISHED' });
	await assert.rejects(mk({ version: 2, status: 'PUBLISHED' }), /unique|Unique|one_published/i, 'a second PUBLISHED row for a key is refused by the database');
	await assert.rejects(mk({ version: 3, status: 'BOGUS' }), /check|constraint/i);
	await assert.rejects(mk({ version: 4, status: 'STAGED', bytes: null }), /check|constraint/i, 'bytes may only be missing on a DISCARDED row');
	await mk({ version: 5, status: 'DISCARDED', bytes: null });
	await assert.rejects(mk({ version: 1, status: 'STAGED' }), /unique|Unique/i, 'UNIQUE(key, version)');
	const pubRow = await e.prisma.siteIdentityAsset.findFirstOrThrow({ where: { status: 'PUBLISHED' } });
	await e.prisma.siteIdentityState.create({ data: { key: 'logo.mark', activeAssetId: pubRow.id, version: 1 } });
	await assert.rejects(e.prisma.siteIdentityAsset.delete({ where: { id: pubRow.id } }), /foreign|constraint|Foreign/i, 'the active asset cannot be deleted');
	await reset(e);
});

test('PG site identity: a database without the new tables answers honestly (public: everything default; admin: 503), never a crash', opts, async () => {
	const { SiteIdentityService } = await import('./site-identity.service'); const missing = { code: 'P2021', message: 'The table does not exist' };
	const db: any = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw missing; } }) });
	const s = new SiteIdentityService({ db, isWired: () => true });
	assert.deepEqual(await s.publicManifest(), { version: 0, items: {} }); assert.equal(await s.publicAsset('logo.mark', 'a'.repeat(64)), null);
	await assert.rejects(s.overview(true), (err: any) => err.statusCode === 503 && err.code === 'SITE_IDENTITY_UNAVAILABLE');
});
