import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

/**
 * Admin broadcast (drafts, preview token, idempotent in-platform send, retry, history): REAL PostgreSQL + the REAL router, service, admin-access resolution and DB constraints over HTTP.
 * Only `authenticate` is replaced (user id from a header, loaded from the DB). Sockets and the mail transport are replaced by recorders so the test can prove nothing is pushed or mailed.
 *
 *   docker exec qa-pg-isolated psql -U qa -d postgres -c "CREATE DATABASE qa_iso_bcast_test"
 *   (base schema from the base branch via db push, then apply prisma/migrations/20261109120000_admin_broadcast_send/migration.sql)
 *   QA_ISOLATED_PG_URL=<url of qa_iso_bcast_test> DATABASE_URL=<same> npx tsx --test --experimental-test-module-mocks --test-concurrency=1 src/routes/admin-broadcasts.pg.test.ts
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\/qa_iso_bcast_/.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL to a qa_iso_bcast_* database on the isolated local PostgreSQL (:55432) to run' };
process.env.JWT_SECRET ??= 'test-secret'; process.env.RATE_LIMIT_ENABLED = 'false';

const pushed: string[] = []; const mailed: string[] = [];
let ctx: Promise<any> | null = null;
async function env() {
	if (ctx) return ctx;
	ctx = (async () => {
		const { prisma } = await import('../config/db');
		const realAuth = await import('../middlewares/auth.middleware');
		mock.module('../middlewares/auth.middleware', { namedExports: { ...realAuth, authenticate: async (req: any, res: any, next: any) => {
			const id = req.headers['x-test-user']; const u = id ? await prisma.user.findUnique({ where: { id: String(id) } }) : null;
			if (!u) return res.status(401).json({ success: false, message: 'غير مصرح' });
			req.user = { id: u.id, userId: u.id, email: u.email, accountType: u.accountType, status: u.status, activeRole: u.activeRole, roles: u.roles, sessionId: 's' }; next();
		} } });
		const fakeIo = { to() { const chain: any = { to() { return chain; }, emit(e: string) { pushed.push(e); } }; return chain; }, emit(e: string) { pushed.push(e); } };
		mock.module('../socket', { namedExports: { getIO: () => { pushed.push('getIO'); return fakeIo; }, initSocketServer: () => fakeIo, ioInstance: fakeIo } });
		mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (m: any) => { mailed.push(String(m.to)); return {}; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const router = (await import('./admin-broadcasts.routes')).default;
		const svc = await import('../services/admin-broadcast.service');
		const app = express(); app.use(express.json()); app.use('/b', router); app.use(globalErrorHandler as any);
		const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as AddressInfo).port;
		const call = async (method: string, url: string, who?: string | null, body?: any, headers: Record<string, string> = {}) => {
			const res = await fetch(`http://127.0.0.1:${port}/b${url}`, { method, headers: { connection: 'close', ...(who ? { 'x-test-user': who } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
			const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
			return { status: res.status, json, data: json?.data };
		};
		return { prisma, call, server, svc };
	})();
	return ctx;
}
after(async () => { if (ctx) { const e = await ctx; e.server.closeAllConnections?.(); await new Promise(r => e.server.close(r)); await e.prisma.$disconnect(); } });

const id = () => randomUUID();
async function mkUser(accountType: string, label: string) {
	const { prisma } = await env(); const tag = id().slice(0, 8);
	return prisma.user.create({ data: { id: id(), accountType, status: 'ACTIVE', roles: [], firstName: 'QA', lastName: `${label}${tag}`, email: `bc-${label}-${tag}@pg.test` } as any });
}
let sa: any, sa2: any, plainAdmin: any, client: any;
beforeEach(async () => {
	if (!enabled) return;
	const { prisma, svc } = await env();
	svc.broadcastDeps.chunkSize = 200; svc.broadcastDeps.leaseMs = 60_000; svc.broadcastDeps.afterChunk = undefined; process.env.ADMIN_BROADCAST_WORKER_ENABLED = 'true'; svc.broadcastDeps.createNotifications = async (tx: any, rows: any[]) => { await tx.notification.createMany({ data: rows }); };
	await prisma.notification.deleteMany({}); await prisma.broadcast.deleteMany({}); await prisma.broadcastDraft.deleteMany({});
	await prisma.user.deleteMany({ where: { accountType: { in: ['MARKETING_BROKER'] } } });
	sa ??= await mkUser('SUPER_ADMIN', 'sa'); sa2 ??= await mkUser('SUPER_ADMIN', 'sa2'); plainAdmin ??= await mkUser('ADMIN', 'adm'); client ??= await mkUser('CLIENT_INDIVIDUAL', 'cl');
	pushed.length = 0; mailed.length = 0;
});
const marketers = async (n: number) => { const out: any[] = []; for (let i = 0; i < n; i++) out.push(await mkUser('MARKETING_BROKER', 'mk')); return out; };
const newDraft = async (over: any = {}, who = sa) => {
	const { call } = await env();
	const r = await call('POST', '/drafts', who.id, { title: 'عنوان', message: 'نص الرسالة', category: 'ALL', audience: 'MARKETERS', ...over });
	assert.equal(r.status, 201); return r.data;
};
const preview = async (draftId: string, who = sa) => { const { call } = await env(); const r = await call('POST', `/drafts/${draftId}/preview`, who.id, {}); assert.equal(r.status, 200); return r.data; };
const send = async (draftId: string, token: string, key: string, who: any = sa) => (await env()).call('POST', `/drafts/${draftId}/send`, who.id, { previewToken: token }, { 'Idempotency-Key': key });
const notes = async () => (await env()).prisma.notification.findMany({ where: { type: 'ADMIN_BROADCAST' }, orderBy: { id: 'asc' } });
const drain = async (owner = 'w-test') => (await env()).svc.runBroadcastWorkerOnce(owner);
const key = () => `key-${id()}`;

test('pg: the isolated database is a throw-away qa_iso_bcast_ one', opts, async () => {
	const { prisma } = await env();
	const [{ current_database }] = await prisma.$queryRaw`SELECT current_database()` as any[];
	assert.match(current_database, /^qa_iso_bcast_/);
});

test('permissions: anonymous 401, client 403, admin without permission 403, Super Admin allowed', opts, async () => {
	const { call } = await env(); await marketers(1);
	for (const [m, u, b] of [['GET', '/drafts/latest'], ['POST', '/drafts', {}], ['GET', '/'], ['GET', `/${id()}`], ['POST', `/${id()}/retry`], ['POST', `/drafts/${id()}/preview`, {}], ['POST', `/drafts/${id()}/send`, { previewToken: 'x'.repeat(12) }]] as any[]) {
		assert.equal((await call(m, u, null, b)).status, 401, `${m} ${u} anon`);
		assert.equal((await call(m, u, client.id, b)).status, 403, `${m} ${u} client`);
		assert.equal((await call(m, u, plainAdmin.id, b)).status, 403, `${m} ${u} admin`);
	}
	assert.equal((await call('GET', '/drafts/latest', sa.id)).status, 200);
	assert.equal((await call('GET', '/', sa.id)).status, 200);
});

test('drafts: create, restore latest after "refresh", validate limits, owner-only', opts, async () => {
	const { call } = await env();
	assert.equal((await call('GET', '/drafts/latest', sa.id)).data, null);
	const d = await newDraft({ title: 'أول', message: 'نص' });
	assert.equal(d.version, 1);
	assert.equal((await call('GET', '/drafts/latest', sa.id)).data.id, d.id);
	assert.equal((await call('GET', '/drafts/latest', sa2.id)).data, null);
	for (const bad of [{ title: 'x'.repeat(151) }, { message: 'x'.repeat(2001) }, { category: 'NOPE' }, { audience: 'ADMINS' }, { extra: 1 }]) assert.equal((await call('POST', '/drafts', sa.id, bad)).status, 400, JSON.stringify(Object.keys(bad)));
	assert.equal((await call('POST', '/drafts', sa.id, { title: 'x'.repeat(150), message: 'x'.repeat(2000) })).status, 201);
	// only the owner
	for (const [m, u, b] of [['GET', `/drafts/${d.id}`], ['PATCH', `/drafts/${d.id}`, { version: 1, title: 'اختراق' }], ['DELETE', `/drafts/${d.id}`], ['POST', `/drafts/${d.id}/preview`, {}], ['POST', `/drafts/${d.id}/send`, { previewToken: 'x'.repeat(12) }]] as any[])
		assert.equal((await call(m, u, sa2.id, b, { 'Idempotency-Key': key() })).status, 404, `${m} ${u}`);
	assert.equal((await call('GET', `/drafts/${d.id}`, sa.id)).data.title, 'أول');
	const upd = await call('PATCH', `/drafts/${d.id}`, sa.id, { version: 1, title: 'ثاني' });
	assert.equal(upd.status, 200); assert.equal(upd.data.version, 2);
	assert.equal((await call('DELETE', `/drafts/${d.id}`, sa.id)).status, 200);
	assert.equal((await call('GET', `/drafts/${d.id}`, sa.id)).status, 404);
});

test('drafts: a stale write gets 409 with the current version and never overwrites a newer one', opts, async () => {
	const { call } = await env();
	const d = await newDraft();
	assert.equal((await call('PATCH', `/drafts/${d.id}`, sa.id, { version: 1, title: 'من تبويب أ' })).status, 200);
	const stale = await call('PATCH', `/drafts/${d.id}`, sa.id, { version: 1, title: 'من تبويب ب' });
	assert.equal(stale.status, 409); assert.equal(stale.json.code, 'BROADCAST_DRAFT_CHANGED');
	assert.equal(stale.data.current.version, 2); assert.equal(stale.data.current.title, 'من تبويب أ');
	assert.equal((await call('GET', `/drafts/${d.id}`, sa.id)).data.title, 'من تبويب أ');
	assert.equal((await call('DELETE', `/drafts/${d.id}?version=1`, sa.id)).status, 409);
	assert.equal((await call('GET', `/drafts/${d.id}`, sa.id)).status, 200);
	// two parallel writes with the same version: exactly one wins
	const both = await Promise.all([call('PATCH', `/drafts/${d.id}`, sa.id, { version: 2, title: 'x1' }), call('PATCH', `/drafts/${d.id}`, sa.id, { version: 2, title: 'x2' })]);
	assert.deepEqual(both.map(r => r.status).sort(), [200, 409]);
});

test('preview writes nothing; send needs a key and a preview token', opts, async () => {
	const { call, prisma } = await env(); await marketers(2);
	const d = await newDraft(); const p = await preview(d.id);
	assert.equal(p.count, 2); assert.equal(p.canSend, true); assert.equal(await prisma.notification.count(), 0); assert.equal(await prisma.broadcast.count(), 0);
	assert.equal((await call('POST', `/drafts/${d.id}/send`, sa.id, { previewToken: p.previewToken })).json.code, 'IDEMPOTENCY_KEY_REQUIRED');
	assert.equal((await call('POST', `/drafts/${d.id}/send`, sa.id, {}, { 'Idempotency-Key': key() })).json.code, 'PREVIEW_TOKEN_REQUIRED');
	assert.equal((await send(d.id, p.previewToken + 'x', key())).json.code, 'PREVIEW_TOKEN_INVALID');
	assert.equal(await prisma.notification.count(), 0);
	// an incomplete draft cannot be previewed
	const empty = await newDraft({ title: '', message: '' });
	assert.equal((await call('POST', `/drafts/${empty.id}/preview`, sa.id, {})).status, 422);
	// a token of another admin's draft does not work for mine
	const d2 = await newDraft();
	assert.equal((await send(d2.id, p.previewToken, key())).json.code, 'PREVIEW_TOKEN_INVALID');
});

test('empty audience: clear 422, nothing recorded', opts, async () => {
	const { prisma } = await env();
	const d = await newDraft(); const p = await preview(d.id);
	assert.equal(p.count, 0); assert.equal(p.canSend, false);
	const r = await send(d.id, p.previewToken, key());
	assert.equal(r.status, 422); assert.equal(r.json.code, 'AUDIENCE_EMPTY');
	assert.equal(await prisma.broadcast.count(), 0); assert.equal(await prisma.notification.count(), 0);
});

test('PREVIEW_STALE when the audience or the draft changed after the preview', opts, async () => {
	const { call, prisma } = await env(); await marketers(2);
	// audience membership changed (same size: one leaves, one joins)
	let d = await newDraft(); let p = await preview(d.id);
	const [first] = await prisma.user.findMany({ where: { accountType: 'MARKETING_BROKER' }, orderBy: { id: 'asc' }, take: 1 });
	await prisma.user.update({ where: { id: first.id }, data: { isBanned: true } }); await marketers(1);
	let r = await send(d.id, p.previewToken, key()); assert.equal(r.status, 409); assert.equal(r.json.code, 'PREVIEW_STALE');
	// count changed
	p = await preview(d.id); await marketers(1);
	r = await send(d.id, p.previewToken, key()); assert.equal(r.json.code, 'PREVIEW_STALE');
	// draft changed (text) after the preview
	p = await preview(d.id);
	assert.equal((await call('PATCH', `/drafts/${d.id}`, sa.id, { version: p.version, message: 'نص مختلف' })).status, 200);
	r = await send(d.id, p.previewToken, key()); assert.equal(r.json.code, 'PREVIEW_STALE');
	// audience filter changed
	p = await preview(d.id); const cur = (await call('GET', `/drafts/${d.id}`, sa.id)).data;
	await call('PATCH', `/drafts/${d.id}`, sa.id, { version: cur.version, audience: 'CLIENTS' });
	r = await send(d.id, p.previewToken, key()); assert.equal(r.json.code, 'PREVIEW_STALE');
	assert.equal(await prisma.broadcast.count(), 0); assert.equal(await prisma.notification.count(), 0);
	// a new preview works
	const cur2 = (await call('GET', `/drafts/${d.id}`, sa.id)).data;
	await call('PATCH', `/drafts/${d.id}`, sa.id, { version: cur2.version, audience: 'MARKETERS' });
	p = await preview(d.id); r = await send(d.id, p.previewToken, key());
	assert.equal(r.status, 202); assert.equal(r.data.broadcast.status, 'QUEUED');
	d = null as any;
});

test('send: in-platform notification rows only, once per recipient; sender/audit recorded; nothing pushed or mailed', opts, async () => {
	const { prisma } = await env(); const ms = await marketers(3);
	const d = await newDraft({ category: 'OFFERS', title: 'عرض', message: 'تفاصيل' }); const p = await preview(d.id);
	const r = await send(d.id, p.previewToken, key());
	assert.equal(r.status, 202); assert.equal(r.data.replayed, false);
	assert.equal(r.data.broadcast.status, 'QUEUED');
	assert.deepEqual(r.data.broadcast.totals, { audience: 3, sent: 0, failed: 0, pending: 3 });
	assert.equal((await notes()).length, 0, 'confirm returned before any notification exists');
	await drain();
	assert.deepEqual((await (await env()).call('GET', `/${r.data.broadcast.id}`, sa.id)).data.totals, { audience: 3, sent: 3, failed: 0, pending: 0 });
	const rows = await notes();
	assert.equal(rows.length, 3); assert.deepEqual(rows.map(x => x.userId).sort(), ms.map(m => m.id).sort());
	for (const n of rows) { assert.equal(n.title, 'عرض'); assert.equal(n.message, 'تفاصيل'); assert.equal(n.category, 'OFFERS'); assert.equal(n.isRead, false); assert.equal((n.metadata as any).broadcastId, r.data.broadcast.id); }
	assert.equal(r.data.broadcast.sender.id, sa.id);
	assert.equal(await prisma.accountAuditLog.count({ where: { userId: sa.id, eventType: 'BROADCAST_SENT', context: { path: ['entityId'], equals: r.data.broadcast.id } } }), 1);
	assert.deepEqual(pushed, []); assert.deepEqual(mailed, []);
	// the draft is frozen after the send
	const { call } = await env();
	assert.equal((await call('PATCH', `/drafts/${d.id}`, sa.id, { version: 1, title: 'بعد' })).json.code, 'DRAFT_ALREADY_SENT');
	assert.equal((await call('GET', '/drafts/latest', sa.id)).data, null);
	// the service never imports a channel
	const src = readFileSync(new URL('../services/admin-broadcast.service.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(src.split('\n').filter(l => l.startsWith('import')).join('\n'), /notification\.service|mail|socket|sms|push/i);
});

test('duplicate send: same key twice, parallel same key, parallel different keys, key reused with another payload', opts, async () => {
	const { prisma } = await env(); await marketers(5);
	const d = await newDraft(); const p = await preview(d.id); const k = key();
	const [a, b] = await Promise.all([send(d.id, p.previewToken, k), send(d.id, p.previewToken, k)]);
	assert.ok([a.status, b.status].every(s => s === 200 || s === 202), `${a.status}/${b.status}`);
	await drain();
	assert.equal(a.data.broadcast.id, b.data.broadcast.id);
	assert.equal((await notes()).length, 5); assert.equal(await prisma.broadcast.count(), 1);
	const again = await send(d.id, p.previewToken, k);
	assert.equal(again.status, 200); assert.equal(again.data.replayed, true); assert.equal((await notes()).length, 5);
	// a different key on the same (already sent) draft is refused: no second broadcast
	const other = await send(d.id, p.previewToken, key());
	assert.equal(other.status, 409); assert.equal(other.json.code, 'DRAFT_ALREADY_SENT');
	// same key with another payload (another draft / token)
	await marketers(0);
	const d2 = await newDraft(); const p2 = await preview(d2.id);
	const reused = await send(d2.id, p2.previewToken, k);
	assert.equal(reused.status, 422); assert.equal(reused.json.code, 'IDEMPOTENCY_KEY_REUSED');
	assert.equal((await notes()).length, 5);
	// parallel different keys on one fresh draft: exactly one broadcast
	const d3 = await newDraft(); const p3 = await preview(d3.id);
	const race = await Promise.all([send(d3.id, p3.previewToken, key()), send(d3.id, p3.previewToken, key()), send(d3.id, p3.previewToken, key())]);
	assert.equal(race.filter(r => r.status === 202).length, 1);
	await drain();
	assert.equal(await prisma.broadcast.count(), 2); assert.equal((await notes()).length, 10);
});

test('partial failure is recorded per recipient and retry completes only the remainder', opts, async () => {
	const { call, prisma, svc } = await env(); const ms = await marketers(7);
	const failing = new Set([ms[1].id, ms[5].id]);
	let attempts = 0;
	svc.broadcastDeps.chunkSize = 3;
	svc.broadcastDeps.createNotifications = async (tx: any, rows: any[]) => {
		attempts++;
		if (rows.some(r => failing.has(r.userId))) throw Object.assign(new Error('boom'), { code: 'INJECTED_FAULT' });
		await tx.notification.createMany({ data: rows });
	};
	const d = await newDraft(); const p = await preview(d.id);
	const r = await send(d.id, p.previewToken, key());
	assert.equal(r.status, 202);
	const id1 = r.data.broadcast.id;
	await drain();
	const fin = (await call('GET', `/${id1}`, sa.id)).data;
	assert.equal(fin.status, 'PARTIAL'); assert.deepEqual(fin.totals, { audience: 7, sent: 5, failed: 2, pending: 0 });
	const before = await notes();
	assert.equal(before.length, 5); assert.ok(before.every(n => !failing.has(n.userId)));
	const detail = await call('GET', `/${id1}`, sa.id);
	assert.deepEqual(detail.data.failureCodes, [{ code: 'INJECTED_FAULT', count: 2 }]);
	const recs = await prisma.broadcastRecipient.findMany({ where: { broadcastId: id1, status: 'FAILED' } });
	assert.deepEqual(recs.map(x => x.userId).sort(), [...failing].sort()); assert.ok(recs.every(x => x.errorCode === 'INJECTED_FAULT'));
	// retry while the fault persists: still failed, still no duplicate
	const still = await call('POST', `/${id1}/retry`, sa.id);
	assert.equal(still.data.status, 'QUEUED'); await drain(); assert.equal((await call('GET', `/${id1}`, sa.id)).data.status, 'PARTIAL'); assert.equal((await notes()).length, 5);
	// fault cleared: retry completes ONLY the remaining two
	failing.clear(); const callsBefore = attempts; const createdIds = new Set(before.map(n => n.id));
	assert.equal((await call('POST', `/${id1}/retry`, sa.id)).status, 200);
	assert.equal((await call('POST', `/${id1}/retry`, sa.id)).json.code, 'BROADCAST_IN_PROGRESS');
	await drain();
	const done = await call('GET', `/${id1}`, sa.id);
	assert.equal(done.data.status, 'COMPLETED');
	assert.deepEqual(done.data.totals, { audience: 7, sent: 7, failed: 0, pending: 0 });
	assert.equal(attempts - callsBefore, 1, 'only one delivery call, for the two remaining recipients');
	const after = await notes();
	assert.equal(after.length, 7); assert.equal(new Set(after.map(n => n.userId)).size, 7);
	for (const id of createdIds) assert.ok(after.some(n => n.id === id), 'already-sent rows are untouched');
	assert.equal((await call('POST', `/${id1}/retry`, sa.id)).json.code, 'BROADCAST_NOTHING_TO_RETRY');
	assert.equal((await notes()).length, 7);
	assert.deepEqual(pushed, []); assert.deepEqual(mailed, []);
});

test('everything failing ends FAILED; the database refuses a second notification of one broadcast for one user', opts, async () => {
	const { prisma, svc } = await env(); await marketers(2);
	svc.broadcastDeps.createNotifications = async () => { throw new Error('down'); };
	const d = await newDraft(); const p = await preview(d.id);
	const r = await send(d.id, p.previewToken, key());
	await drain();
	const { call: call0 } = await env();
	const st = (await call0('GET', `/${r.data.broadcast.id}`, sa.id)).data;
	assert.equal(st.status, 'FAILED'); assert.deepEqual(st.totals, { audience: 2, sent: 0, failed: 2, pending: 0 });
	assert.equal((await notes()).length, 0);
	svc.broadcastDeps.createNotifications = async (tx: any, rows: any[]) => { await tx.notification.createMany({ data: rows }); };
	const { call } = await env();
	assert.equal((await call('POST', `/${r.data.broadcast.id}/retry`, sa.id)).data.status, 'QUEUED'); await drain();
	assert.equal((await call('GET', `/${r.data.broadcast.id}`, sa.id)).data.status, 'COMPLETED');
	const n = (await notes())[0];
	await assert.rejects(prisma.notification.create({ data: { userId: n.userId, title: 'dup', message: 'dup', type: 'ADMIN_BROADCAST', metadata: n.metadata as any } }));
});

test('history: newest first, paginated, sender + totals, detail has the body, list does not', opts, async () => {
	const { call } = await env(); await marketers(2);
	const ids: string[] = [];
	for (let i = 0; i < 22; i++) {
		const d = await newDraft({ title: `إشعار ${i}`, message: `سر-الجسم-${i}` }); const p = await preview(d.id);
		const r = await send(d.id, p.previewToken, key()); ids.push(r.data.broadcast.id);
	}
	await drain();
	const p1 = await call('GET', '/', sa.id);
	assert.equal(p1.data.items.length, 20); assert.equal(p1.data.hasNext, true); assert.equal(p1.data.items[0].id, ids[21]); assert.equal(p1.data.items[0].title, 'إشعار 21');
	const item = p1.data.items[0];
	assert.deepEqual(Object.keys(item).sort(), ['audience', 'category', 'completedAt', 'createdAt', 'id', 'lastProgressAt', 'sender', 'status', 'title', 'totals']);
	assert.equal(item.sender.id, sa.id); assert.match(item.sender.name, /^QA /); assert.deepEqual(item.totals, { audience: 2, sent: 2, failed: 0, pending: 0 });
	assert.doesNotMatch(JSON.stringify(p1.json), /سر-الجسم/);
	const p2 = await call('GET', '/?page=2', sa.id);
	assert.equal(p2.data.items.length, 2); assert.equal(p2.data.hasNext, false); assert.equal(p2.data.items[1].id, ids[0]);
	const detail = await call('GET', `/${ids[3]}`, sa.id);
	assert.equal(detail.data.message, 'سر-الجسم-3'); assert.equal(detail.data.status, 'COMPLETED'); assert.deepEqual(detail.data.failureCodes, []);
	assert.equal((await call('GET', `/${id()}`, sa.id)).status, 404);
	assert.equal((await call('GET', '/?page=0', sa.id)).status, 400);
	assert.equal((await call('GET', '/', sa2.id)).data.items.length, 20); // any Super Admin sees the shared history
});

const queued = async (n: number, over: any = {}) => {
	const ms = await marketers(n);
	const d = await newDraft(over); const p = await preview(d.id);
	const r = await send(d.id, p.previewToken, key());
	assert.equal(r.status, 202);
	return { ms, id: r.data.broadcast.id as string, r };
};
const perUser = async (broadcastId?: string) => {
	const rows = (await notes()).filter(n => !broadcastId || (n.metadata as any).broadcastId === broadcastId); const m = new Map<string, number>();
	for (const n of rows) m.set(n.userId, (m.get(n.userId) ?? 0) + 1);
	return m;
};

test('worker: off by default; a queued job waits (counters show pending) and the active endpoint restores it', opts, async () => {
	const { call, svc } = await env();
	delete process.env.ADMIN_BROADCAST_WORKER_ENABLED;
	assert.equal(svc.isBroadcastWorkerEnabled(), false);
	assert.equal(svc.startBroadcastWorkerFromEnv(), null);
	process.env.ADMIN_BROADCAST_WORKER_ENABLED = 'true';
	const { id } = await queued(4);
	assert.equal((await notes()).length, 0);
	const d = (await call('GET', `/${id}`, sa.id)).data;
	assert.equal(d.status, 'QUEUED'); assert.deepEqual(d.totals, { audience: 4, sent: 0, failed: 0, pending: 4 }); assert.equal(d.lastProgressAt, null);
	assert.equal((await call('GET', '/active', sa.id)).data.id, id);
	assert.equal((await call('GET', '/active', sa2.id)).data, null);
	assert.equal((await call('POST', `/${id}/retry`, sa.id)).json.code, 'BROADCAST_IN_PROGRESS');
	process.env.ADMIN_BROADCAST_WORKER_ENABLED = 'true'; assert.equal(svc.broadcastWorkerEnabled(), true); delete process.env.ADMIN_BROADCAST_WORKER_ENABLED;
});

test('worker: completes a queued job; progress and lastProgressAt are visible; nothing mailed or pushed', opts, async () => {
	const { call, svc } = await env();
	const { id, ms } = await queued(5);
	svc.broadcastDeps.chunkSize = 2;
	const seen: any[] = [];
	svc.broadcastDeps.afterChunk = async (bid: string) => { seen.push((await call('GET', `/${bid}`, sa.id)).data); };
	assert.deepEqual(await drain(), [id]);
	assert.deepEqual(seen.map(x => [x.status, x.totals.sent, x.totals.pending]), [['SENDING', 2, 3], ['SENDING', 4, 1], ['SENDING', 5, 0]]);
	assert.ok(seen[0].lastProgressAt);
	const d = (await call('GET', `/${id}`, sa.id)).data;
	assert.equal(d.status, 'COMPLETED'); assert.deepEqual(d.totals, { audience: 5, sent: 5, failed: 0, pending: 0 });
	assert.equal((await call('GET', '/active', sa.id)).data, null);
	assert.deepEqual([...(await perUser()).values()], [1, 1, 1, 1, 1]); assert.equal((await perUser()).size, ms.length);
	assert.deepEqual(await drain(), []);
	assert.deepEqual(pushed, []); assert.deepEqual(mailed, []);
});

test('worker: a job interrupted mid-way is resumed by a fresh worker; total == audience, nobody notified twice', opts, async () => {
	const { call, svc, prisma } = await env();
	const { id, ms } = await queued(9);
	svc.broadcastDeps.chunkSize = 2;
	let chunks = 0;
	svc.broadcastDeps.afterChunk = () => { if (++chunks === 2) throw new svc.WorkerCrash('process died'); };
	await assert.rejects(drain('w-dead'), svc.WorkerCrash);
	assert.equal((await notes()).length, 4);
	let mid = (await call('GET', `/${id}`, sa.id)).data;
	assert.equal(mid.status, 'SENDING'); assert.deepEqual(mid.totals, { audience: 9, sent: 4, failed: 0, pending: 5 });
	// the dead worker still holds a valid lease: nobody else may touch it yet
	assert.deepEqual(await drain('w-late'), []);
	await prisma.broadcast.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } }); // lease expiry
	svc.broadcastDeps.afterChunk = undefined;
	assert.deepEqual(await drain('w-fresh'), [id]);
	mid = (await call('GET', `/${id}`, sa.id)).data;
	assert.equal(mid.status, 'COMPLETED'); assert.deepEqual(mid.totals, { audience: 9, sent: 9, failed: 0, pending: 0 });
	const counts = await perUser();
	assert.equal(counts.size, 9); assert.ok([...counts.values()].every(n => n === 1)); assert.deepEqual([...counts.keys()].sort(), ms.map(m => m.id).sort());
	assert.equal((await notes()).length, 9);
});

test('worker: a crash between creating a notification and marking the recipient cannot exist (one transaction): a failing mark leaves no notification', opts, async () => {
	const { svc, prisma } = await env();
	const { id } = await queued(3);
	// a chunk whose notification insert succeeds but whose transaction then aborts must leave zero rows and zero SENT marks
	svc.broadcastDeps.createNotifications = async (tx: any, rows: any[]) => { await tx.notification.createMany({ data: rows }); throw new svc.WorkerCrash('died after insert, before commit'); };
	await assert.rejects(drain('w-x'), svc.WorkerCrash);
	assert.equal((await notes()).length, 0);
	assert.equal(await prisma.broadcastRecipient.count({ where: { broadcastId: id, status: 'SENT' } }), 0);
});

test('worker: two workers started simultaneously deliver every recipient exactly once with correct counters', opts, async () => {
	const { call, svc } = await env();
	const a = await queued(12);
	svc.broadcastDeps.chunkSize = 3;
	const [h1, h2] = await Promise.all([drain('w-1'), drain('w-2')]);
	const handled = [...h1, ...h2];
	assert.ok(handled.includes(a.id));
	const counts = await perUser();
	assert.ok([...counts.values()].every(n => n === 1));
	const d = (await call('GET', `/${a.id}`, sa.id)).data;
	assert.equal(d.status, 'COMPLETED'); assert.equal(d.totals.sent, d.totals.audience); assert.equal(d.totals.pending, 0);
	assert.equal((await notes()).length, counts.size);
});

test('worker: two workers racing on the SAME broadcast (lease ignored) cannot double deliver; a worker that lost its lease stops', opts, async () => {
	const { svc, prisma, call } = await env();
	const { id } = await queued(10);
	svc.broadcastDeps.chunkSize = 2;
	// w-old claims, then its lease expires and w-new takes over mid-job
	const claimed = await svc.claimBroadcast('w-old'); assert.equal(claimed, id);
	assert.equal(await svc.claimBroadcast('w-other'), null, 'a live lease blocks other workers');
	await prisma.broadcast.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
	assert.equal(await svc.claimBroadcast('w-new'), id, 'expired lease can be taken over');
	// the old worker (still running its loop in memory) now tries to deliver: it must stop at its first chunk
	const lateRun = await (svc as any).processBroadcastForTest(id, 'w-old');
	assert.equal(lateRun, 'lost'); assert.equal((await notes()).length, 0);
	const newRun = await (svc as any).processBroadcastForTest(id, 'w-new');
	assert.equal(newRun, 'done');
	const counts = await perUser(); assert.equal(counts.size, 10); assert.ok([...counts.values()].every(n => n === 1));
	assert.equal((await call('GET', `/${id}`, sa.id)).data.status, 'COMPLETED');
	// concurrent processing under two different owners: only the lease holder delivers
	const second = await queued(6); await svc.claimBroadcast('w-a');
	const [r1, r2] = await Promise.all([(svc as any).processBroadcastForTest(second.id, 'w-a'), (svc as any).processBroadcastForTest(second.id, 'w-b')]);
	assert.deepEqual([r1, r2], ['done', 'lost']);
	const sc = await perUser(second.id); assert.equal(sc.size, 16); assert.ok([...sc.values()].every(n => n === 1));
});

test('worker: empty and changed audience behave as before and enqueue nothing; replay returns the same broadcast', opts, async () => {
	const { prisma } = await env();
	const d0 = await newDraft(); const p0 = await preview(d0.id);
	assert.equal((await send(d0.id, p0.previewToken, key())).json.code, 'AUDIENCE_EMPTY');
	await marketers(2);
	const d = await newDraft(); const p = await preview(d.id); await marketers(1);
	assert.equal((await send(d.id, p.previewToken, key())).json.code, 'PREVIEW_STALE');
	assert.equal(await prisma.broadcast.count(), 0);
	const p2 = await preview(d.id); const k = key();
	const first = await send(d.id, p2.previewToken, k); const again = await send(d.id, p2.previewToken, k);
	assert.equal(first.status, 202); assert.equal(again.status, 200); assert.equal(again.data.replayed, true);
	assert.equal(again.data.broadcast.id, first.data.broadcast.id); assert.equal(await prisma.broadcast.count(), 1);
});

test('worker: the background timer starts only when asked, resumes queued jobs by itself and stops', opts, async () => {
	const { svc, call } = await env();
	const { id } = await queued(3);
	const w = svc.startBroadcastWorker({ intervalMs: 20, owner: 'w-timer' });
	for (let i = 0; i < 100 && (await call('GET', `/${id}`, sa.id)).data.status !== 'COMPLETED'; i++) await new Promise(r => setTimeout(r, 50));
	w.stop();
	assert.equal((await call('GET', `/${id}`, sa.id)).data.status, 'COMPLETED'); assert.equal((await notes()).length, 3);
});

test('flag OFF: confirm and retry are refused before any write; everything else works; flag ON: same draft and same key succeed', opts, async () => {
	const { call, svc, prisma } = await env();
	await marketers(3);
	const rowCounts = async () => [await prisma.broadcast.count(), await prisma.broadcastRecipient.count(), await prisma.notification.count()];
	const flag = (v?: string) => { if (v === undefined) delete process.env.ADMIN_BROADCAST_WORKER_ENABLED; else process.env.ADMIN_BROADCAST_WORKER_ENABLED = v; };
	// a finished broadcast exists to test retry against
	const old = await queued(0); await drain();
	await prisma.broadcastRecipient.updateMany({ where: { broadcastId: old.id }, data: { status: 'FAILED', errorCode: 'X' } });
	await prisma.broadcast.update({ where: { id: old.id }, data: { status: 'PARTIAL' } });
	await prisma.notification.deleteMany({}); 
	const d = await newDraft(); const k = key();
	for (const off of [undefined, 'false', 'TRUE', '1', '']) {
		flag(off);
		const p = await preview(d.id);
		assert.equal(p.deliveryEnabled, false); assert.equal(p.canSend, true);
		const before = await rowCounts();
		const r = await send(d.id, p.previewToken, k);
		assert.equal(r.status, 503); assert.equal(r.json.code, 'BROADCAST_WORKER_DISABLED'); assert.match(r.json.message, /غير مفعّل/);
		assert.deepEqual(await rowCounts(), before);
		assert.equal((await call('POST', `/${old.id}/retry`, sa.id)).json.code, 'BROADCAST_WORKER_DISABLED');
		assert.equal(await prisma.broadcastRecipient.count({ where: { broadcastId: old.id, status: 'FAILED' } }), 3, 'retry changed nothing');
		assert.equal((await prisma.broadcastDraft.findUniqueOrThrow({ where: { id: d.id } })).sentAt, null, 'draft state unchanged');
	}
	flag('false');
	// reads and drafts stay fully working
	assert.equal((await call('GET', '/status', sa.id)).data.deliveryEnabled, false);
	assert.equal((await call('GET', '/drafts/latest', sa.id)).data.id, d.id);
	assert.equal((await call('PATCH', `/drafts/${d.id}`, sa.id, { version: 1, title: 'ما زال قابلًا للتعديل' })).status, 200);
	assert.equal((await call('GET', '/', sa.id)).status, 200); assert.equal((await call('GET', `/${old.id}`, sa.id)).status, 200); assert.equal((await call('GET', '/active', sa.id)).status, 200);
	const status = await call('GET', '/status', sa.id);
	assert.deepEqual(Object.keys(status.data), ['deliveryEnabled']);
	const p = await preview(d.id);
	assert.doesNotMatch(JSON.stringify([status.json, p, (await call('POST', `/drafts/${d.id}/send`, sa.id, { previewToken: p.previewToken }, { 'Idempotency-Key': k })).json]), /ADMIN_BROADCAST_WORKER_ENABLED|JWT_SECRET|DATABASE_URL/);
	// flag ON: the SAME draft and SAME key now confirm
	flag('true');
	assert.equal((await call('GET', '/status', sa.id)).data.deliveryEnabled, true);
	const p2 = await preview(d.id); assert.equal(p2.deliveryEnabled, true);
	const ok = await send(d.id, p2.previewToken, k);
	assert.equal(ok.status, 202); assert.equal(await prisma.broadcast.count({ where: { idempotencyKey: k } }), 1);
	const w = svc.startBroadcastWorker({ intervalMs: 20, owner: 'w-flag' });
	for (let i = 0; i < 100 && (await call('GET', `/${ok.data.broadcast.id}`, sa.id)).data.status !== 'COMPLETED'; i++) await new Promise(r => setTimeout(r, 50));
	w.stop();
	const counts = await perUser(ok.data.broadcast.id);
	assert.equal(counts.size, 3); assert.ok([...counts.values()].every(n => n === 1));
	// flip off again: a second draft is refused without side effects
	flag('false');
	const d2 = await newDraft(); const p3 = await preview(d2.id); const before = await rowCounts();
	assert.equal((await send(d2.id, p3.previewToken, key())).status, 503); assert.deepEqual(await rowCounts(), before);
	assert.equal((await send(d.id, p2.previewToken, k)).status, 200, 'replay of an already accepted confirm stays a harmless read');
});
