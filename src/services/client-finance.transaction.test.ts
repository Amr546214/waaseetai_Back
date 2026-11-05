import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// getTransaction(): the owner reads one wallet row by the id the list shows; anyone else gets the same 404 as a missing id.

const OWN = 'client-1';
const wtx = { id: 'tx-1', userId: OWN, type: 'DEPOSIT', amount: 50, currency: 'USD', status: 'COMPLETED', paymentMethod: 'PAYPAL', referenceId: 'CAP-1', description: null, metadata: null, createdAt: new Date('2026-02-01') };
const amend = { id: 'tx-2', userId: OWN, type: 'AMENDMENT_TOPUP', amount: -20, currency: 'USD', status: 'COMPLETED', paymentMethod: 'WALLET', referenceId: 'am-1', description: 'x', metadata: { projectId: 'p-1' }, createdAt: new Date('2026-02-02') };
const escrowProject = { id: 'p-1', clientId: OWN, title: 'مشروع', provider: { firstName: 'سارة', lastName: 'م' }, escrow: { id: 'e-1', amount: 300, releasedAmount: 100, status: 'HELD', paymentMethod: null, paymentReference: 'REF-E', fundedAt: new Date('2026-03-01'), createdAt: new Date('2026-03-01') } };
const failedPay = { id: 'pp-1', userId: OWN, status: 'FAILED', amount: 10, netAmount: null, currency: 'USD', reference: 'R-F', createdAt: new Date('2026-04-01') };

async function load(t: TestContext) {
	const prismaMock: any = {
		walletTransaction: { findFirst: async ({ where }: any) => [wtx, amend].find(r => r.id === where.id && r.userId === where.userId) ?? null },
		project: { findFirst: async ({ where }: any) => {
			if (where.escrow) return where.clientId === OWN && where.escrow.is.id === 'e-1' ? escrowProject : null;
			return where.id === 'p-1' && where.clientId === OWN ? { id: 'p-1', title: 'مشروع', provider: null } : null;
		} },
		paypalPayment: { findFirst: async ({ where }: any) => where.id === failedPay.id && where.userId === OWN && where.status === 'FAILED' ? failedPay : null }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const { clientFinanceService } = await import(`./client-finance.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return clientFinanceService;
}

const rejects404 = (p: Promise<unknown>) => assert.rejects(p, (e: any) => e.statusCode === 404 || e.status === 404);

test('getTransaction: the owner reads a stored wallet transaction with its real fields', async (t) => {
	const s = await load(t);
	const r = await s.getTransaction(OWN, 'tx-1');
	assert.equal(r.id, 'tx-1'); assert.equal(r.amount, 50); assert.equal(r.currency, 'USD'); assert.equal(r.status, 'COMPLETED'); assert.equal(r.referenceId, 'CAP-1');
	assert.equal(r.project, null); assert.equal(r.escrow, null);
});

test('getTransaction: a stored row whose metadata names the client\'s project returns that project', async (t) => {
	const s = await load(t);
	assert.deepEqual((await s.getTransaction(OWN, 'tx-2')).project, { id: 'p-1', title: 'مشروع', providerName: null });
});

test('getTransaction: an escrow-<id> row returns the held / released amounts and the project', async (t) => {
	const s = await load(t);
	const r = await s.getTransaction(OWN, 'escrow-e-1');
	assert.equal(r.type, 'ESCROW_LOCK'); assert.equal(r.status, 'HELD'); assert.equal(r.project.id, 'p-1'); assert.equal(r.project.providerName, 'سارة م');
	assert.deepEqual(r.escrow, { amount: 300, releasedAmount: 100, status: 'HELD' });
});

test('getTransaction: a paypal-failed-<id> row is readable by its owner as FAILED', async (t) => {
	const s = await load(t);
	const r = await s.getTransaction(OWN, 'paypal-failed-pp-1');
	assert.equal(r.status, 'FAILED'); assert.equal(r.amount, 10);
});

test('getTransaction: another account, a missing id and a malformed id are all 404', async (t) => {
	const s = await load(t);
	await rejects404(s.getTransaction('intruder', 'tx-1'));
	await rejects404(s.getTransaction('intruder', 'escrow-e-1'));
	await rejects404(s.getTransaction('intruder', 'paypal-failed-pp-1'));
	await rejects404(s.getTransaction(OWN, 'nope'));
	await rejects404(s.getTransaction(OWN, ''));
});
