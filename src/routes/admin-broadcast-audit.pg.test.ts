import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Broadcast audit rows on REAL PostgreSQL (database qa_iso_audit_*): the audit row of confirm / retry / cancel / review / re-approval is written in the SAME transaction as the
 * change, so a failing audit insert (forced by a trigger) rolls the change back and leaves NO success row, and the row carries ids, statuses and counts, never the reason text.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\/qa_iso_audit_/.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL to a qa_iso_audit_* database on the isolated local PostgreSQL (:55432) to run' };
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
	svc.broadcastDeps.chunkSize = 200; svc.broadcastDeps.leaseMs = 60_000; svc.broadcastDeps.afterChunk = undefined; process.env.ADMIN_BROADCAST_WORKER_ENABLED = 'true'; delete process.env.BROADCAST_MAX_QUEUE_AGE_HOURS; svc.broadcastDeps.createNotifications = async (tx: any, rows: any[]) => { await tx.notification.createMany({ data: rows }); };
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
const queued = async (n: number, over: any = {}) => {
	const ms = await marketers(n);
	const d = await newDraft(over); const p = await preview(d.id);
	const r = await send(d.id, p.previewToken, key());
	assert.equal(r.status, 202);
	return { ms, id: r.data.broadcast.id as string, r };
};

const key = () => `key-${id()}`;
const rows = async (broadcastId: string, eventType: string) => (await env()).prisma.accountAuditLog.findMany({ where: { eventType, context: { path: ['entityId'], equals: broadcastId } } });
async function breakAudit(eventType: string) {
	const { prisma } = await env(); const n = `qa_bc_audit_fail_${eventType.toLowerCase()}`;
	await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${n}() RETURNS trigger AS $$ BEGIN IF NEW."eventType" = '${eventType}' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
	await prisma.$executeRawUnsafe(`CREATE TRIGGER ${n} BEFORE INSERT ON account_audit_logs FOR EACH ROW EXECUTE FUNCTION ${n}()`);
	return async () => { await prisma.$executeRawUnsafe(`DROP TRIGGER ${n} ON account_audit_logs`); await prisma.$executeRawUnsafe(`DROP FUNCTION ${n}()`); };
}

test('confirm: one BROADCAST_SENT row (actor, case, audience, count) in the same transaction; a failing audit leaves no broadcast, no recipients and the draft unsent', opts, async () => {
	const { prisma } = await env(); await marketers(3);
	const d = await newDraft(); const p = await preview(d.id);
	const restore = await breakAudit('BROADCAST_SENT');
	try { assert.notEqual((await send(d.id, p.previewToken, key())).status, 202); } finally { await restore(); }
	assert.equal(await prisma.broadcast.count(), 0); assert.equal(await prisma.broadcastRecipient.count(), 0);
	assert.equal((await prisma.broadcastDraft.findUniqueOrThrow({ where: { id: d.id } })).sentAt, null);
	const k = key(); const ok = await send(d.id, p.previewToken, k); assert.equal(ok.status, 202);
	const bid = ok.data.broadcast.id; const r = await rows(bid, 'BROADCAST_SENT'); assert.equal(r.length, 1);
	assert.equal(r[0].userId, sa.id); assert.equal(r[0].severity, 'WARNING'); assert.deepEqual({ a: (r[0].context as any).audience, c: (r[0].context as any).audienceCount, e: (r[0].context as any).entity }, { a: 'MARKETERS', c: 3, e: 'BROADCAST' });
	assert.doesNotMatch(JSON.stringify(r[0]), /نص الرسالة|pg\.test/);
	assert.equal((await send(d.id, p.previewToken, k)).status, 200, 'replay'); assert.equal((await rows(bid, 'BROADCAST_SENT')).length, 1, 'a replay does not log twice');
});

test('cancel: one row with before/after and counts but NOT the reason text; a failing audit keeps the job QUEUED with its recipients PENDING', opts, async () => {
	const { call, prisma } = await env(); const a = await queued(2); const { call: _c } = await env(); process.env.ADMIN_BROADCAST_WORKER_ENABLED = 'true';
	const restore = await breakAudit('BROADCAST_CANCELLED');
	try { assert.equal((await call('POST', `/${a.id}/cancel`, sa.id, { reason: 'سبب الإلغاء السري' })).status, 500); } finally { await restore(); }
	assert.equal((await prisma.broadcast.findUniqueOrThrow({ where: { id: a.id } })).status, 'QUEUED');
	assert.equal(await prisma.broadcastRecipient.count({ where: { broadcastId: a.id, status: 'PENDING' } }), 2);
	assert.equal((await rows(a.id, 'BROADCAST_CANCELLED')).length, 0);
	assert.equal((await call('POST', `/${a.id}/cancel`, sa.id, { reason: 'سبب الإلغاء السري' })).status, 200);
	assert.equal((await call('POST', `/${a.id}/cancel`, sa.id, {})).status, 200);
	const r = await rows(a.id, 'BROADCAST_CANCELLED'); assert.equal(r.length, 1, 'idempotent cancel logs once');
	assert.equal(r[0].userId, sa.id); assert.deepEqual(r[0].beforeData, { status: 'QUEUED' }); assert.deepEqual(r[0].afterData, { status: 'CANCELLED' });
	assert.equal((r[0].context as any).hasReason, true); assert.equal((r[0].context as any).cancelledPending, 2);
	assert.doesNotMatch(JSON.stringify(r[0]), /سبب الإلغاء السري/);
});

test('review: one row; a failing audit leaves the job unreviewed', opts, async () => {
	const { call, prisma } = await env(); const a = await queued(1);
	const restore = await breakAudit('BROADCAST_REVIEWED');
	try { assert.equal((await call('POST', `/${a.id}/review`, sa.id)).status, 500); } finally { await restore(); }
	assert.equal((await prisma.broadcast.findUniqueOrThrow({ where: { id: a.id } })).reviewedAt, null); assert.equal((await rows(a.id, 'BROADCAST_REVIEWED')).length, 0);
	assert.equal((await call('POST', `/${a.id}/review`, sa.id)).status, 200); assert.equal((await call('POST', `/${a.id}/review`, sa.id)).status, 200);
	const r = await rows(a.id, 'BROADCAST_REVIEWED'); assert.equal(r.length, 1); assert.equal(r[0].userId, sa.id);
});

test('retry: row carries the requeued count; a failing audit keeps the failed recipients FAILED and the status PARTIAL', opts, async () => {
	const { call, prisma } = await env(); const a = await queued(2);
	await prisma.broadcastRecipient.updateMany({ where: { broadcastId: a.id }, data: { status: 'FAILED' } });
	await prisma.broadcast.update({ where: { id: a.id }, data: { status: 'PARTIAL', leaseOwner: null, leaseUntil: null } });
	const restore = await breakAudit('BROADCAST_RETRIED');
	try { assert.equal((await call('POST', `/${a.id}/retry`, sa.id)).status, 500); } finally { await restore(); }
	assert.equal((await prisma.broadcast.findUniqueOrThrow({ where: { id: a.id } })).status, 'PARTIAL');
	assert.equal(await prisma.broadcastRecipient.count({ where: { broadcastId: a.id, status: 'FAILED' } }), 2); assert.equal((await rows(a.id, 'BROADCAST_RETRIED')).length, 0);
	assert.equal((await call('POST', `/${a.id}/retry`, sa.id)).status, 200);
	const r = await rows(a.id, 'BROADCAST_RETRIED'); assert.equal(r.length, 1); assert.deepEqual(r[0].beforeData, { status: 'PARTIAL' }); assert.deepEqual(r[0].afterData, { status: 'QUEUED' }); assert.equal((r[0].context as any).requeuedCount, 2);
});
