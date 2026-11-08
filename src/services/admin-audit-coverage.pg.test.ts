import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { env, opts, closeEnv } from '../testing/admin-team.pgenv';

/**
 * Admin audit coverage on REAL PostgreSQL (isolated database qa_iso_audit_*): every audited operation writes exactly ONE row, with the actor, the time,
 * the case (context.entity / entityId) and the outcome, in the SAME transaction as the change, and with no body / e-mail / token in it.
 * A failure is forced INSIDE the transaction by a database trigger that rejects the audit insert: the change must roll back and leave NO row.
 * No notification is delivered: the notification service is stubbed.
 */
after(async () => { tpl?.server.closeAllConnections?.(); if (tpl) await new Promise(r => tpl!.server.close(r)); await closeEnv(); });
let tpl: { server: http.Server; call: (m: string, p: string, who: string, body?: any) => Promise<{ status: number; json: any }> } | null = null;

async function boot() {
	const e = await env();
	if (tpl) return e;
	const { notificationService } = await import('./notification.service');
	for (const k of ['createAndEmit', 'emitStored', 'send']) (notificationService as any)[k] = async () => ({ id: 'stub' });
	const express = (await import('express')).default;
	const { globalErrorHandler } = await import('../middlewares/error.middleware');
	const templates = (await import('../routes/admin-notification-templates.routes')).default;
	const account = (await import('../routes/admin-account.routes')).default;
	const app = express(); app.use(express.json()); app.use('/admin/notification-templates', templates); app.use('/admin/console', account); app.use(globalErrorHandler as any);
	const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	const port = (server.address() as AddressInfo).port;
	tpl = { server, call: async (method, path, who, body) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': who, connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
		return { status: res.status, json };
	} };
	return e;
}

const rowsFor = (e: any, entity: string, entityId: string, eventType?: string) => e.prisma.accountAuditLog.findMany({
	where: { source: 'ADMIN', ...(eventType ? { eventType } : {}), AND: [{ context: { path: ['entity'], equals: entity } }, { context: { path: ['entityId'], equals: entityId } }] }, orderBy: { occurredAt: 'asc' }
});
const mkTicket = async (e: any, owner: any, extra: any = {}) => e.prisma.supportTicket.create({ data: { ticketNumber: `TK-${randomUUID().slice(0, 8)}`, userId: owner.id, subject: 'موضوع', category: 'عام', description: 'نص التذكرة السري', ...extra } });
const mkDispute = async (e: any, owner: any, other: any) => e.prisma.dispute.create({ data: { openedById: owner.id, againstUserId: other.id, reason: 'سبب', description: 'وصف النزاع السري' } });
/** a trigger that rejects the audit insert of one event type: the transaction of the change must roll back with it */
async function breakAudit(e: any, eventType: string) {
	const n = `qa_audit_fail_${eventType.toLowerCase()}`;
	await e.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${n}() RETURNS trigger AS $$ BEGIN IF NEW."eventType" = '${eventType}' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
	await e.prisma.$executeRawUnsafe(`CREATE TRIGGER ${n} BEFORE INSERT ON account_audit_logs FOR EACH ROW EXECUTE FUNCTION ${n}()`);
	return async () => { await e.prisma.$executeRawUnsafe(`DROP TRIGGER ${n} ON account_audit_logs`); await e.prisma.$executeRawUnsafe(`DROP FUNCTION ${n}()`); };
}
const noLeak = (row: any, ...secrets: string[]) => { const text = JSON.stringify(row); for (const s of secrets) assert.ok(!text.includes(s), `audit row leaks «${s}»: ${text}`); };
const hasActorCaseTime = (row: any, adminId: string, entity: string, entityId: string) => {
	assert.equal(row.userId, adminId); assert.ok(row.occurredAt instanceof Date && Date.now() - row.occurredAt.getTime() < 60_000);
	assert.equal(row.context.entity, entity); assert.equal(row.context.entityId, entityId); assert.equal(row.status, 'COMPLETED'); assert.equal(row.source, 'ADMIN');
};

test('ticket: status, priority, reply and assign each write ONE row (actor, time, case, outcome) and never the reply text or the owner e-mail', opts, async () => {
	const e = await boot(); const owner = await e.mkUser('CLIENT_INDIVIDUAL', 'tk'); const t = await mkTicket(e, owner);
	const REPLY = 'نص الرد السري للعميل';
	assert.equal((await e.call('PATCH', `/admin/tickets/${t.id}/status`, e.sa.id, { status: 'IN_PROGRESS' })).status, 200);
	assert.equal((await e.call('PATCH', `/admin/tickets/${t.id}/priority`, e.sa.id, { priority: 'عاجلة' })).status, 200);
	const rep = await e.call('POST', `/admin/tickets/${t.id}/reply`, e.sa.id, { body: REPLY }); assert.equal(rep.status, 201, JSON.stringify(rep.json));
	assert.equal((await e.call('POST', `/admin/tickets/${t.id}/assign`, e.sa.id, { assigneeId: e.sa.id })).status, 200);
	const rows = await rowsFor(e, 'TICKET', t.id);
	assert.deepEqual(rows.map((r: any) => r.eventType).sort(), ['TICKET_ASSIGNED', 'TICKET_PRIORITY_CHANGED', 'TICKET_REPLIED', 'TICKET_STATUS_CHANGED']);
	for (const r of rows) { hasActorCaseTime(r, e.sa.id, 'TICKET', t.id); noLeak(r, REPLY, owner.email, 'نص التذكرة السري'); }
	const by = (c: string) => rows.find((r: any) => r.eventType === c);
	assert.deepEqual(by('TICKET_STATUS_CHANGED').beforeData, { status: 'OPEN' }); assert.deepEqual(by('TICKET_STATUS_CHANGED').afterData, { status: 'IN_PROGRESS' });
	assert.deepEqual(by('TICKET_PRIORITY_CHANGED').afterData, { priority: 'عاجلة' });
	const reply = by('TICKET_REPLIED'); assert.deepEqual(reply.afterData, { status: 'AWAITING_CUSTOMER' }); assert.equal(reply.context.messageId, rep.json.data.message.id); assert.equal(reply.context.attachmentCount, 0);
	assert.equal(by('TICKET_ASSIGNED').context.assigneeId, e.sa.id);
	// double submit of the same status: the second is refused and writes nothing
	assert.equal((await e.call('PATCH', `/admin/tickets/${t.id}/status`, e.sa.id, { status: 'AWAITING_CUSTOMER' })).status, 409);
	assert.equal((await rowsFor(e, 'TICKET', t.id, 'TICKET_STATUS_CHANGED')).length, 1);
});

test('ticket: a failing audit insert rolls the change back and leaves NO success row (status, priority, reply)', opts, async () => {
	const e = await boot(); const owner = await e.mkUser('CLIENT_INDIVIDUAL', 'tf'); const t = await mkTicket(e, owner);
	for (const [code, call, check] of [
		['TICKET_STATUS_CHANGED', () => e.call('PATCH', `/admin/tickets/${t.id}/status`, e.sa.id, { status: 'RESOLVED' }), async () => (await e.prisma.supportTicket.findUnique({ where: { id: t.id } })).status === 'OPEN'],
		['TICKET_PRIORITY_CHANGED', () => e.call('PATCH', `/admin/tickets/${t.id}/priority`, e.sa.id, { priority: 'عاجلة' }), async () => (await e.prisma.supportTicket.findUnique({ where: { id: t.id } })).priority === 'عادية'],
		['TICKET_REPLIED', () => e.call('POST', `/admin/tickets/${t.id}/reply`, e.sa.id, { body: 'رد' }), async () => (await e.prisma.supportTicketMessage.count({ where: { ticketId: t.id } })) === 0],
	] as const) {
		const restore = await breakAudit(e, code);
		try { assert.equal((await call()).status, 500, code); } finally { await restore(); }
		assert.ok(await check(), `${code}: the change must be rolled back`);
		assert.equal((await rowsFor(e, 'TICKET', t.id, code)).length, 0, `${code}: no success row`);
	}
	assert.equal((await e.prisma.supportTicket.findUnique({ where: { id: t.id } })).status, 'OPEN');
});

test('dispute: assign, status, text resolve, staff message write ONE row each; no decision text, message text or party e-mail in any row', opts, async () => {
	const e = await boot(); const a = await e.mkUser('CLIENT_INDIVIDUAL', 'da'); const b = await e.mkUser('PROVIDER_INDIVIDUAL', 'db'); const d = await mkDispute(e, a, b);
	const MSG = 'رسالة الإدارة السرية', DECISION = 'قرار نصي سري للنزاع', NOTE = 'ملاحظة القرار السرية';
	assert.equal((await e.call('POST', `/admin/disputes/${d.id}/assign`, e.sa.id, { assigneeId: e.sa.id })).status, 200);
	assert.equal((await e.call('PATCH', `/admin/disputes/${d.id}/status`, e.sa.id, { status: 'UNDER_REVIEW' })).status, 200);
	const m = await e.call('POST', `/admin/disputes/${d.id}/messages`, e.sa.id, { body: MSG }); assert.equal(m.status, 201, JSON.stringify(m.json));
	const r = await e.call('POST', `/admin/disputes/${d.id}/resolve`, e.sa.id, { action: 'resolve', resolution: DECISION, resolutionNote: NOTE }); assert.equal(r.status, 200, JSON.stringify(r.json));
	const rows = await rowsFor(e, 'DISPUTE', d.id);
	assert.deepEqual(rows.map((x: any) => x.eventType).sort(), ['DISPUTE_ASSIGNED', 'DISPUTE_RESOLVED', 'DISPUTE_STAFF_MESSAGE_SENT', 'DISPUTE_STATUS_CHANGED']);
	for (const x of rows) { hasActorCaseTime(x, e.sa.id, 'DISPUTE', d.id); noLeak(x, MSG, DECISION, NOTE, a.email, b.email, 'وصف النزاع السري'); }
	const by = (c: string) => rows.find((x: any) => x.eventType === c);
	assert.deepEqual(by('DISPUTE_STATUS_CHANGED').beforeData, { status: 'OPEN' }); assert.deepEqual(by('DISPUTE_STATUS_CHANGED').afterData, { status: 'UNDER_REVIEW' });
	assert.equal(by('DISPUTE_STAFF_MESSAGE_SENT').context.messageId, m.json.data.id);
	const res = by('DISPUTE_RESOLVED'); assert.deepEqual(res.beforeData, { status: 'UNDER_REVIEW' }); assert.deepEqual(res.afterData, { status: 'RESOLVED' }); assert.equal(res.severity, 'WARNING'); assert.equal(res.context.decision, 'resolve');
	// double submit: refused, one row, the decision text still lives on the dispute itself
	assert.equal((await e.call('POST', `/admin/disputes/${d.id}/resolve`, e.sa.id, { action: 'resolve', resolution: DECISION })).status, 409);
	assert.equal((await rowsFor(e, 'DISPUTE', d.id, 'DISPUTE_RESOLVED')).length, 1);
	assert.equal((await e.prisma.dispute.findUnique({ where: { id: d.id } })).resolutionNote, NOTE);
});

test('dispute: a failing audit insert rolls back the status change, the text resolution and the staff message', opts, async () => {
	const e = await boot(); const a = await e.mkUser('CLIENT_INDIVIDUAL', 'dfa'); const b = await e.mkUser('PROVIDER_INDIVIDUAL', 'dfb'); const d = await mkDispute(e, a, b);
	for (const [code, call, check] of [
		['DISPUTE_STATUS_CHANGED', () => e.call('PATCH', `/admin/disputes/${d.id}/status`, e.sa.id, { status: 'UNDER_REVIEW' }), async () => (await e.prisma.dispute.findUnique({ where: { id: d.id } })).status === 'OPEN'],
		['DISPUTE_STAFF_MESSAGE_SENT', () => e.call('POST', `/admin/disputes/${d.id}/messages`, e.sa.id, { body: 'x' }), async () => (await e.prisma.disputeMessage.count({ where: { disputeId: d.id } })) === 0],
		['DISPUTE_RESOLVED', () => e.call('POST', `/admin/disputes/${d.id}/resolve`, e.sa.id, { action: 'resolve', resolution: 'قرار' }), async () => { const x = await e.prisma.dispute.findUnique({ where: { id: d.id } }); return x.status === 'OPEN' && x.resolvedAt === null; }],
	] as const) {
		const restore = await breakAudit(e, code);
		try { assert.equal((await call()).status, 500, code); } finally { await restore(); }
		assert.ok(await check(), `${code}: the change must be rolled back`);
		assert.equal((await rowsFor(e, 'DISPUTE', d.id, code)).length, 0, `${code}: no success row`);
	}
});

test('notification templates: create / edit write ONE row with id and versions only (no name, title or text); a failing audit rolls the change back; the trail shows Arabic labels', opts, async () => {
	const e = await boot(); await boot();
	const NAME = `قالب-${randomUUID().slice(0, 6)}`, TITLE = 'عنوان القالب السري', TEXT = 'نص القالب السري';
	const c = await tpl!.call('POST', '/admin/notification-templates', e.sa.id, { name: NAME, title: TITLE, message: TEXT }); assert.equal(c.status, 201, JSON.stringify(c.json));
	const id = c.json.data.id;
	const u = await tpl!.call('PATCH', `/admin/notification-templates/${id}`, e.sa.id, { name: NAME, title: `${TITLE} 2`, message: TEXT, version: 1 }); assert.equal(u.status, 200, JSON.stringify(u.json));
	const rows = await rowsFor(e, 'NOTIFICATION_TEMPLATE', id);
	assert.deepEqual(rows.map((r: any) => r.eventType), ['NOTIFICATION_TEMPLATE_CREATED', 'NOTIFICATION_TEMPLATE_UPDATED']);
	for (const r of rows) { hasActorCaseTime(r, e.sa.id, 'NOTIFICATION_TEMPLATE', id); noLeak(r, NAME, TITLE, TEXT); }
	assert.deepEqual(rows[1].beforeData, { version: 1 }); assert.deepEqual(rows[1].afterData, { version: 2 }); assert.deepEqual(rows[1].context.changedFields, ['message', 'name', 'title']);
	// a stale edit (409) writes no row
	assert.equal((await tpl!.call('PATCH', `/admin/notification-templates/${id}`, e.sa.id, { name: NAME, title: 'x', message: TEXT, version: 1 })).status, 409);
	assert.equal((await rowsFor(e, 'NOTIFICATION_TEMPLATE', id, 'NOTIFICATION_TEMPLATE_UPDATED')).length, 1);
	// forced audit failure: the edit is rolled back, the create leaves no template
	let restore = await breakAudit(e, 'NOTIFICATION_TEMPLATE_UPDATED');
	try { assert.equal((await tpl!.call('PATCH', `/admin/notification-templates/${id}`, e.sa.id, { name: NAME, title: 'غيّر', message: TEXT, version: 2 })).status, 500); } finally { await restore(); }
	const cur = await e.prisma.notificationTemplate.findUnique({ where: { id } }); assert.equal(cur.version, 2); assert.equal(cur.title, `${TITLE} 2`);
	assert.equal((await rowsFor(e, 'NOTIFICATION_TEMPLATE', id, 'NOTIFICATION_TEMPLATE_UPDATED')).length, 1);
	const NAME2 = `قالب-${randomUUID().slice(0, 6)}`;
	restore = await breakAudit(e, 'NOTIFICATION_TEMPLATE_CREATED');
	try { assert.equal((await tpl!.call('POST', '/admin/notification-templates', e.sa.id, { name: NAME2, title: 't', message: 'm' })).status, 500); } finally { await restore(); }
	assert.equal(await e.prisma.notificationTemplate.count({ where: { name: NAME2 } }), 0);
	// the audit trail screen lists the new codes with their Arabic names, entity and actor
	const trail = await tpl!.call('GET', '/admin/console/audit-log?limit=200', e.sa.id); assert.equal(trail.status, 200, JSON.stringify(trail.json));
	const items: any[] = trail.json.data.items;
	const created = items.find(i => i.eventType === 'NOTIFICATION_TEMPLATE_CREATED' && i.target?.id === id)!;
	assert.equal(created.actionLabel, 'إنشاء قالب إشعار'); assert.equal(created.target.typeLabel, 'قالب إشعار'); assert.equal(created.actor.id, e.sa.id); assert.equal(created.severity, 'INFO');
	assert.ok(items.some(i => i.eventType === 'NOTIFICATION_TEMPLATE_UPDATED' && i.actionLabel === 'تعديل قالب إشعار'));
});
