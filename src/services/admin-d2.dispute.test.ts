import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Admin dispute back office: assign / internal note / status / resolve, the audit trail and the notifications to BOTH parties.
// prisma, the notification helpers are mocked; the audit store is an in-memory stand-in for account_audit_logs.
type Fx = { audit: any[]; providerNotes: any[]; clientNotes: any[]; dispute: any };

async function load(t: TestContext, overrides: Partial<any> = {}) {
	const fx: Fx = { audit: [], providerNotes: [], clientNotes: [], dispute: { id: 'd1', requestId: null, projectId: 'p1', openedById: 'client-1', againstUserId: 'prov-1', status: 'OPEN', reason: 'r', description: 'd', evidence: [], ...overrides } };
	const prisma: any = {
		dispute: {
			findUnique: async ({ where }: any) => (where.id === 'd1' ? { ...fx.dispute, request: null, project: { id: 'p1' }, openedBy: { id: 'client-1' }, againstUser: { id: 'prov-1' }, resolvedBy: null } : null),
			update: async ({ data }: any) => { Object.assign(fx.dispute, data); return { ...fx.dispute }; },
			updateMany: async ({ where, data }: any) => { if (where.status?.in && !where.status.in.includes(fx.dispute.status)) return { count: 0 }; Object.assign(fx.dispute, data); return { count: 1 }; },
			findFirst: async () => null,
			groupBy: async () => [], findMany: async () => [], count: async () => 0
		},
		user: { findUnique: async ({ where }: any) => (where.id === 'admin-2' ? { id: 'admin-2', firstName: 'Sara', lastName: 'A', accountType: 'ADMIN' } : where.id === 'client-1' ? { id: 'client-1', accountType: 'CLIENT_INDIVIDUAL' } : null) },
		project: { findUnique: async () => ({ providerId: 'prov-1', contract: { providerId: 'prov-1' } }) },
		proposal: { findFirst: async () => null },
		escrow: { findUnique: async () => ({ amount: 100, releasedAmount: 40, status: 'HELD', fundedAt: null, project: { contract: { price: 100, status: 'DISPUTED' } } }) },
		accountAuditLog: {
			create: async ({ data }: any) => { const row = { id: `a${fx.audit.length + 1}`, occurredAt: new Date(fx.audit.length + 1), user: { id: data.userId, firstName: 'Ad', lastName: 'Min' }, ...data }; fx.audit.push(row); return row; },
			findMany: async ({ where }: any) => fx.audit.filter(r => (!where.eventType || where.eventType === r.eventType || where.eventType.in?.includes(r.eventType)) && (!where.AND || where.AND.every((c: any) => r.context[c.context.path[0]] === c.context.equals))).slice().reverse()
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	// the audit module is cached across tests: load a fresh copy bound to THIS test's prisma mock
	t.mock.module('./admin-audit.service', { namedExports: { adminAudit: (await import(`./admin-audit.service.ts?fixture=${Date.now()}-${Math.random()}`)).adminAudit } });
	t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { disputeOpened: async () => {}, disputeResolved: async (n: any) => { fx.providerNotes.push(n); } } } });
	t.mock.module('./client-notifications.service', { namedExports: { clientNotifications: { send: async (n: any) => { fx.clientNotes.push(n); } }, clientNotificationFor: { disputeOpened: () => ({}), disputeResolved: (p: any) => ({ userId: p.clientId, type: 'DISPUTE_RESOLVED', ...p }) } } });
	const { disputeService } = await import(`./dispute.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { svc: disputeService, fx };
}

test('assign: only an admin / super-admin can be the assignee, and the assignment is audit-logged and shown on the detail', async (t) => {
	const { svc, fx } = await load(t);
	await assert.rejects(() => svc.assign('d1', 'admin-1', 'client-1'), /مشرف أو مدير/);
	assert.equal(fx.audit.length, 0);
	const r = await svc.assign('d1', 'admin-1', 'admin-2');
	assert.deepEqual(r.assignedTo, { id: 'admin-2', name: 'Sara A' });
	assert.equal(fx.audit[0].eventType, 'DISPUTE_ASSIGNED');
	assert.equal(fx.audit[0].userId, 'admin-1');
	const detail = await svc.getForAdmin('d1');
	assert.equal(detail.assignedTo.id, 'admin-2');
	assert.equal(detail.timeline.length, 1);
});

test('note: stored in the admin audit store (body only in context, never in the summary) and returned by the admin detail', async (t) => {
	const { svc, fx } = await load(t);
	await svc.addNote('d1', 'admin-1', 'العميل أرسل لقطات إضافية');
	assert.equal(fx.audit[0].eventType, 'DISPUTE_NOTE');
	assert.ok(!String(fx.audit[0].summary).includes('لقطات'));
	assert.equal(fx.audit[0].context.body, 'العميل أرسل لقطات إضافية');
	const detail = await svc.getForAdmin('d1');
	assert.equal(detail.notes[0].body, 'العميل أرسل لقطات إضافية');
});

test('status: OPEN -> UNDER_REVIEW is audited; same status and a closed dispute are refused', async (t) => {
	const { svc, fx } = await load(t);
	const r = await svc.setStatus('d1', 'admin-1', 'UNDER_REVIEW');
	assert.equal(r.status, 'UNDER_REVIEW');
	assert.equal(fx.audit[0].eventType, 'DISPUTE_STATUS_CHANGED');
	assert.deepEqual(fx.audit[0].afterData, { status: 'UNDER_REVIEW' });
	await assert.rejects(() => svc.setStatus('d1', 'admin-1', 'UNDER_REVIEW'), /مسبقاً/);
	fx.dispute.status = 'RESOLVED';
	await assert.rejects(() => svc.setStatus('d1', 'admin-1', 'OPEN'), /مسبقاً/);
});

test('resolve: audit row with before/after, and BOTH the provider and the client are notified of the decision', async (t) => {
	const { svc, fx } = await load(t);
	const r = await svc.resolve('d1', 'admin-1', { action: 'resolve', resolution: 'MUTUAL_CLOSE', resolutionNote: 'تسوية' });
	assert.equal(r.status, 'RESOLVED');
	assert.equal(fx.audit[0].eventType, 'DISPUTE_RESOLVED');
	assert.equal(fx.audit[0].severity, 'WARNING');
	assert.equal(fx.providerNotes.length, 1);
	assert.equal(fx.providerNotes[0].providerId, 'prov-1');
	assert.equal(fx.clientNotes.length, 1);
	assert.equal(fx.clientNotes[0].userId, 'client-1');
	await assert.rejects(() => svc.resolve('d1', 'admin-1', { action: 'reject', resolution: 'x1' }), /مسبقاً/);
});

test('detail: escrow status and held amount come from the database; unknown dispute is 404', async (t) => {
	const { svc } = await load(t);
	const d = await svc.getForAdmin('d1');
	assert.equal(d.escrow.status, 'HELD');
	assert.equal(d.heldEscrowAmount, 60);
	await assert.rejects(() => svc.getForAdmin('nope'), /غير موجود/);
});
