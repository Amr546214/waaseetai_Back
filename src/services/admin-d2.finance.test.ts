import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toCsv } from '../utils/csv.util';

// Admin finance / withdrawals / projects read models and actions. prisma is mocked; every figure asserted here is derived from the mock rows.

test('csv: BOM, quoting, and spreadsheet-formula neutralisation', () => {
	const out = toCsv(['a', 'b'], [['=cmd()', 'x,"y"'], [5, null]]);
	assert.ok(out.startsWith('﻿'));
	assert.ok(out.includes("'=cmd()"));
	assert.ok(out.includes('"x,""y"""'));
	assert.ok(out.includes('\r\n5,'));
});

test('withdrawal approve / reject write an audit row (before/after + amount) and notify via the provider/marketer helper', async (t) => {
	const audit: any[] = []; const notified: any[] = [];
	const rows: any = { w1: { id: 'w1', userId: 'aff-user', amount: 300, currency: 'USD', method: 'paypal', status: 'PENDING', referenceId: 'r1' } };
	const prisma: any = {
		withdrawal: {
			findUnique: async ({ where }: any) => rows[where.id] ?? null,
			aggregate: async () => ({ _sum: { amount: 0 } }),
			updateMany: async ({ where, data }: any) => { if (rows[where.id].status !== where.status) return { count: 0 }; Object.assign(rows[where.id], data); return { count: 1 }; },
			findUniqueOrThrow: async ({ where }: any) => ({ ...rows[where.id] })
		},
		user: { findUnique: async () => ({ accountType: 'MARKETING_BROKER', roles: ['AFFILIATE'], activeRole: 'AFFILIATE', affiliateProfile: { id: 'aff-1' } }) },
		commissionLog: { aggregate: async () => ({ _sum: { amount: 500 } }) },
		walletTransaction: { create: async () => ({}) },
		accountAuditLog: { create: async ({ data }: any) => { audit.push(data); return { id: 'a', occurredAt: new Date() }; } },
		$transaction: async (fn: any) => fn(prisma)
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	t.mock.module('./provider-finance.service', { namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 0 } }) } } });
	t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { withdrawal: async (id: string, ev: string) => { notified.push([id, ev]); } } } });
	t.mock.module('./admin-audit.service', { namedExports: { adminAudit: (await import(`./admin-audit.service.ts?f=${Math.random()}`)).adminAudit } });
	const { withdrawalService } = await import(`./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const approved = await withdrawalService.approve('w1', 'admin-1', { adminNote: 'ok' });
	assert.equal(approved.status, 'APPROVED');
	assert.equal(audit[0].eventType, 'WITHDRAWAL_APPROVED');
	assert.equal(audit[0].userId, 'admin-1');
	assert.equal(audit[0].context.amount, 300);
	assert.deepEqual(notified, [['w1', 'APPROVED']]);
	// an approved request can no longer be approved or rejected (state machine), and no second audit row is written
	await assert.rejects(() => withdrawalService.approve('w1', 'admin-1', {}), /مسبقاً/);
	await assert.rejects(() => withdrawalService.reject('w1', 'admin-1', { rejectionReason: 'x' }), /مسبقاً/);
	assert.equal(audit.length, 1);
	rows.w2 = { id: 'w2', userId: 'aff-user', amount: 100, currency: 'USD', method: 'paypal', status: 'PENDING' };
	const rejected = await withdrawalService.reject('w2', 'admin-1', { rejectionReason: 'بيانات ناقصة' });
	assert.equal(rejected.status, 'REJECTED');
	assert.equal(audit[1].eventType, 'WITHDRAWAL_REJECTED');
	assert.equal(audit[1].context.rejectionReason, 'بيانات ناقصة');
	assert.deepEqual(notified[1], ['w2', 'REJECTED']);
});

test('approve cannot overpay: more than the withdrawable commission is refused, nothing audited', async (t) => {
	const audit: any[] = [];
	const rows: any = { w1: { id: 'w1', userId: 'u', amount: 600, currency: 'USD', status: 'PENDING' } };
	const prisma: any = {
		withdrawal: { findUnique: async ({ where }: any) => rows[where.id], aggregate: async () => ({ _sum: { amount: 0 } }), updateMany: async () => ({ count: 1 }) },
		user: { findUnique: async () => ({ accountType: 'MARKETING_BROKER', roles: ['AFFILIATE'], activeRole: 'AFFILIATE', affiliateProfile: { id: 'aff-1' } }) },
		commissionLog: { aggregate: async () => ({ _sum: { amount: 500 } }) },
		accountAuditLog: { create: async ({ data }: any) => { audit.push(data); return {}; } },
		$transaction: async (fn: any) => fn(prisma)
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	t.mock.module('./provider-finance.service', { namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 0 } }) } } });
	const { withdrawalService } = await import(`./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`);
	await assert.rejects(() => withdrawalService.approve('w1', 'admin-1', {}), /غير كافٍ/);
	assert.equal(audit.length, 0);
});

test('affiliate withdrawal notifications: paid / failed wording and the marketer route', async (t) => {
	const sent: any[] = [];
	t.mock.module('../config/db', { namedExports: { prisma: { withdrawal: { findUnique: async () => ({ id: 'w1', userId: 'aff', amount: 300, currency: 'USD', rejectionReason: null }) } } } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async (n: any) => { sent.push(n); } } } });
	const { affiliateWithdrawalNotifications } = await import(`./affiliate-withdrawal-notifications.service.ts?f=${Math.random()}`);
	await affiliateWithdrawalNotifications.withdrawal('w1', 'PAID');
	await affiliateWithdrawalNotifications.withdrawal('w1', 'FAILED');
	assert.equal(sent[0].type, 'WITHDRAWAL_PAID');
	assert.match(sent[0].message, /300 \$/);
	assert.equal(sent[1].type, 'WITHDRAWAL_FAILED');
	assert.match(sent[1].message, /ولم يُخصم/);
	assert.ok(sent.every(n => n.userId === 'aff' && n.actionUrl === '/marketer-overview/withdraw'));
});

test('finance overview: totals and monthly series come from the aggregates / rows (no fixed numbers)', async (t) => {
	const prisma: any = {
		escrow: { aggregate: async (a: any) => (a.where?.status === 'HELD' ? { _count: { _all: 2 }, _sum: { amount: 1000, releasedAmount: 250 } } : { _sum: { releasedAmount: 400, platformCommissionAmount: 60, providerNetReleasedAmount: 340 } }) },
		walletTransaction: { aggregate: async () => ({ _count: { _all: 3 }, _sum: { amount: 700 } }), findMany: async () => [{ amount: 100, createdAt: new Date('2026-10-02') }, { amount: 50, createdAt: new Date('2026-09-02') }] },
		paypalPayment: { aggregate: async () => ({ _sum: { feeAmount: '12.5' } }) },
		withdrawal: { groupBy: async () => [{ status: 'PENDING', _count: { _all: 1 }, _sum: { amount: 80 } }], findMany: async () => [{ amount: 30, updatedAt: new Date('2026-10-05') }] },
		commissionLog: { groupBy: async () => [{ status: 'APPROVED', _count: { _all: 2 }, _sum: { amount: 40 } }], findMany: async () => [] },
		projectStage: { findMany: async () => [{ amount: 200, approvedAt: new Date('2026-10-09') }] }
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	const { adminFinanceService } = await import(`./admin-finance.service.ts?f=${Math.random()}`);
	const o = await adminFinanceService.overview(2, new Date('2026-10-14'));
	assert.equal(o.totals.escrowHeldAmount, 750);
	assert.equal(o.totals.platformCommission, 60);
	assert.equal(o.totals.paymentGatewayFees, 12.5);
	assert.deepEqual(o.withdrawals.PENDING, { count: 1, amount: 80 });
	assert.deepEqual(o.series.map((b: any) => b.month), ['2026-09', '2026-10']);
	assert.equal(o.series[1].deposits, 100);
	assert.equal(o.series[1].releasedGross, 200);
	assert.equal(o.series[1].withdrawalsPaid, 30);
	assert.equal(o.series[0].deposits, 50);
});

test('projects list / detail: escrow status and held amount from the DB, 404 for an unknown project', async (t) => {
	const project = { id: 'p1', title: 'متجر', status: 'IN_PROGRESS', createdAt: new Date(), deliveryDays: 30, client: { id: 'c', firstName: 'A', lastName: 'B' }, provider: { id: 'v', firstName: 'C', lastName: 'D' }, escrow: { status: 'HELD', amount: 100, releasedAmount: 25, platformCommissionAmount: 0, providerNetReleasedAmount: 0 }, contract: { id: 'k1', price: 100, status: 'ACTIVE', stages: [{ status: 'APPROVED' }, { status: 'PENDING' }] } };
	const prisma: any = {
		project: { findMany: async () => [project], count: async () => 1, groupBy: async () => [{ status: 'IN_PROGRESS', _count: { _all: 1 } }], findUnique: async ({ where }: any) => (where.id === 'p1' ? { ...project, description: 'd', specialty: 's', contract: { ...project.contract, durationDays: 30, signedAt: null, clientSignedAt: null, providerSignedAt: null, stages: [], amendments: [] } } : null) },
		escrow: { aggregate: async () => ({ _count: { _all: 1 }, _sum: { amount: 100, releasedAmount: 25 } }) },
		dispute: { findMany: async () => [{ id: 'd1', status: 'OPEN' }] }
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	t.mock.module('./admin-audit.service', { namedExports: { adminAudit: { listForEntity: async () => [] } } });
	const { adminOperationsService } = await import(`./admin-operations.service.ts?f=${Math.random()}`);
	const list = await adminOperationsService.listProjects({});
	assert.equal(list.items[0].escrow.status, 'HELD');
	assert.equal(list.items[0].escrow.heldAmount, 75);
	assert.equal(list.items[0].progress.percent, 50);
	assert.equal(list.kpis.escrowHeldTotal, 75);
	const detail = await adminOperationsService.getProject('p1');
	assert.equal(detail.openDisputes, 1);
	await assert.rejects(() => adminOperationsService.getProject('nope'), /غير موجود/);
});

test('admin routes: every admin router is gated by ADMIN/SUPER_ADMIN and there is no escrow release / refund / hold route', () => {
	for (const f of ['admin-finance.routes.ts', 'admin-projects.routes.ts', 'admin-disputes.routes.ts', 'admin-withdrawals.routes.ts']) {
		const src = fs.readFileSync(path.join(__dirname, '../routes', f), 'utf8');
		assert.match(src, /authenticate,\s*requireActiveUser,\s*authorize\(AccountType\.ADMIN,\s*AccountType\.SUPER_ADMIN\)/, f);
		assert.doesNotMatch(src, /\/(release|refund|hold)\b/, f);
	}
});

test('authorize: a SUPER_ADMIN whose activeRole is CLIENT passes the admin gate; a client / provider / affiliate does not', async () => {
	const { authorize } = await import('../middlewares/auth.middleware');
	const gate = authorize('ADMIN' as any, 'SUPER_ADMIN' as any);
	const run = (user: any) => { let err: any; gate({ user } as any, {} as any, (e?: any) => { err = e; }); return err; };
	assert.equal(run({ accountType: 'SUPER_ADMIN', activeRole: 'CLIENT', roles: ['CLIENT'] }), undefined);
	assert.equal(run({ accountType: 'ADMIN', activeRole: 'CLIENT', roles: [] }), undefined);
	for (const accountType of ['CLIENT_INDIVIDUAL', 'PROVIDER_INDIVIDUAL', 'MARKETING_BROKER']) assert.equal(run({ accountType, activeRole: 'CLIENT', roles: ['CLIENT'] })?.statusCode, 403);
	assert.equal(run(undefined)?.statusCode, 401);
});
