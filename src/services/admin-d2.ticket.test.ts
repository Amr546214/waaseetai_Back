import { test } from 'node:test';
import assert from 'node:assert/strict';

// Admin ticket back office: owner-visible reply / status, ownership, and INTERNAL notes that the ticket owner can never read.
async function load(t: any, ownerType = 'PROVIDER_INDIVIDUAL') {
	const audit: any[] = [];
	const notifications: any[] = [];
	const ticket: any = { id: 't1', ticketNumber: 'TK-1', userId: 'owner', status: 'OPEN', priority: 'عادية', resolvedAt: null, closedAt: null };
	const messages: any[] = [{ id: 'm0', ticketId: 't1', senderId: 'owner', body: 'original', createdAt: new Date(1) }];
	const prisma: any = {
		user: { findUnique: async ({ where }: any) => (where.id === 'owner' ? { id: 'owner', accountType: ownerType, firstName: 'O', lastName: 'W', email: 'o@x' } : where.id === 'admin-2' ? { id: 'admin-2', firstName: 'Sara', lastName: 'A', accountType: 'ADMIN' } : { id: where.id, accountType: 'PROVIDER_INDIVIDUAL' }) },
		supportTicket: { findUnique: async ({ where }: any) => (where.id === 't1' ? { ...ticket } : null), update: async ({ data }: any) => { Object.assign(ticket, data); return { ...ticket }; } },
		supportTicketMessage: {
			create: async ({ data }: any) => { const m = { id: `m${messages.length}`, createdAt: new Date(), ...data, sender: { id: data.senderId, accountType: 'ADMIN' } }; messages.push(m); return m; },
			findMany: async () => messages.map(m => ({ ...m, sender: m.sender ?? { id: m.senderId, accountType: ownerType } }))
		},
		accountAuditLog: {
			create: async ({ data }: any) => { const row = { id: `a${audit.length + 1}`, occurredAt: new Date(audit.length + 1), user: { id: data.userId, firstName: 'Ad', lastName: 'Min' }, ...data }; audit.push(row); return row; },
			findMany: async ({ where }: any) => audit.filter(r => (!where.eventType || where.eventType === r.eventType) && (!where.AND || where.AND.every((c: any) => r.context[c.context.path[0]] === c.context.equals))).slice().reverse()
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	// the audit module is cached across tests: load a fresh copy bound to THIS test's prisma mock
	t.mock.module('./admin-audit.service', { namedExports: { adminAudit: (await import(`./admin-audit.service.ts?fixture=${Date.now()}-${Math.random()}`)).adminAudit } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async (n: any) => { notifications.push(n); } } } });
	const { supportTicketService } = await import(`./support-ticket.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { svc: supportTicketService, audit, notifications, ticket, messages };
}

test('admin reply is visible in the owner thread, notifies the owner and is audit-logged (provider)', async (t) => {
	const { svc, audit, notifications } = await load(t);
	await svc.replyAsStaff('t1', 'admin-1', 'تم استلام طلبك');
	const owner = await svc.getForUser('t1', 'owner');
	assert.equal(owner.messages[owner.messages.length - 1].body, 'تم استلام طلبك');
	assert.equal(notifications[0].actionUrl, '/provider-overview/help/tickets/t1');
	assert.equal(audit[0].eventType, 'TICKET_REPLIED');
});

test('admin reply notifies an affiliate (marketer) owner with a marketer-router destination', async (t) => {
	const { svc, notifications } = await load(t, 'MARKETING_BROKER');
	await svc.replyAsStaff('t1', 'admin-1', 'مرحبا');
	assert.equal(notifications[0].userId, 'owner');
	assert.equal(notifications[0].actionUrl, '/marketer-overview/help');
});

test('internal note is NEVER visible to the ticket owner but is returned to the admin detail', async (t) => {
	const { svc, messages } = await load(t);
	await svc.addInternalNote('t1', 'admin-1', 'ملاحظة سرية: العميل متكرر الشكاوى');
	const owner = await svc.getForUser('t1', 'owner');
	assert.equal(JSON.stringify(owner).includes('سرية'), false);
	assert.equal(messages.length, 1);
	const admin = await svc.getForAdmin('t1');
	assert.equal(admin.internalNotes[0].body, 'ملاحظة سرية: العميل متكرر الشكاوى');
});

test('status change: owner sees the new status + is notified; audit row has before/after', async (t) => {
	const { svc, audit, notifications } = await load(t);
	await svc.setStatus('t1', 'RESOLVED', 'admin-1');
	assert.equal((await svc.getForUser('t1', 'owner')).ticket.status, 'RESOLVED');
	assert.equal(notifications[0].metadata.event, 'status_changed');
	assert.deepEqual(audit[0].beforeData, { status: 'OPEN' });
	assert.deepEqual(audit[0].afterData, { status: 'RESOLVED' });
});

test('assign + priority: assignee must be staff; priority change is audited and visible to the owner ticket', async (t) => {
	const { svc, audit } = await load(t);
	await assert.rejects(() => svc.assign('t1', 'admin-1', 'owner'), /مشرف أو مدير/);
	await svc.assign('t1', 'admin-1', 'admin-2');
	assert.equal((await svc.getForAdmin('t1')).assignedTo.name, 'Sara A');
	await svc.setPriority('t1', 'admin-1', 'عاجلة');
	assert.equal((await svc.getForUser('t1', 'owner')).ticket.priority, 'عاجلة');
	assert.ok(audit.some(a => a.eventType === 'TICKET_PRIORITY_CHANGED'));
	await assert.rejects(() => svc.setPriority('t1', 'admin-1', 'عاجلة'), /مسبقًا/);
});

test('another user cannot read the ticket (404), and staff routes are gated to ADMIN / SUPER_ADMIN', async (t) => {
	const { svc } = await load(t);
	await assert.rejects(() => svc.getForUser('t1', 'stranger'), /غير موجودة/);
	const fs = await import('node:fs'); const path = await import('node:path');
	const src = fs.readFileSync(path.join(__dirname, '../routes/admin-tickets.routes.ts'), 'utf8');
	assert.match(src, /router\.use\(authenticate,\s*requireActiveUser,\s*authorize\(AccountType\.ADMIN,\s*AccountType\.SUPER_ADMIN\)\)/);
	for (const r of ["'/:id/assign'", "'/:id/notes'", "'/:id/priority'"]) assert.ok(src.indexOf(r) > src.indexOf('router.use('), r);
});
