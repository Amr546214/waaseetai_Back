import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// getWallet()'s top-level summary.currency is 'USD' (balance and escrow/pricing are USD-only) and every WalletTransaction row exposes
// its own stored currency unchanged.

function createWalletMockPrisma(t: TestContext, opts: { walletBalance?: number; transactions?: any[]; projects?: any[]; failedDeposits?: any[] } = {}) {
	const prismaMock: any = {
		user: {
			findUnique: async () => ({ id: 'client-1', firstName: 'Amr', lastName: 'Okasha', walletBalance: opts.walletBalance ?? 0 })
		},
		project: {
			findMany: async () => opts.projects ?? []
		},
		walletTransaction: {
			findMany: async () => opts.transactions ?? []
		},
		paypalPayment: {
			findMany: async () => opts.failedDeposits ?? []
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	return prismaMock;
}

async function loadService(t: TestContext, opts?: Parameters<typeof createWalletMockPrisma>[1]) {
	createWalletMockPrisma(t, opts);
	const moduleUrl = `./client-finance.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { clientFinanceService } = await import(moduleUrl);
	return clientFinanceService;
}

test('getWallet: the top-level summary.currency is USD (canonical wallet balance + active escrow/pricing)', async (t) => {
	const service = await loadService(t, { walletBalance: 100 });
	const wallet = await service.getWallet('client-1');
	assert.equal(wallet.summary.currency, 'USD');
});

test('getWallet: a new PayPal WalletTransaction row keeps exposing USD, unaffected by the summary-level change', async (t) => {
	const service = await loadService(t, {
		walletBalance: 100,
		transactions: [
			{ id: 'tx-usd', type: 'DEPOSIT', amount: 50, currency: 'USD', status: 'COMPLETED', paymentMethod: 'PAYPAL', referenceId: 'CAPTURE-1', description: null, createdAt: new Date('2026-02-01') }
		]
	});
	const wallet = await service.getWallet('client-1');
	const tx = wallet.transactions.find((t: any) => t.id === 'tx-usd');
	assert.equal(tx.currency, 'USD');
});

test('getInvoices: the invoice summary currency is USD (contract/stage pricing is now USD-semantic)', async (t) => {
	t.mock.module('../config/db', {
		namedExports: {
			prisma: {
				contract: { findMany: async () => [] }
			}
		}
	});
	const moduleUrl = `./client-finance.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { clientFinanceService } = await import(moduleUrl);
	const result = await clientFinanceService.getInvoices('client-1');
	assert.equal(result.summary.currency, 'USD');
});

test('getWallet: the balance is the stored wallet balance; a failed PayPal deposit is listed as FAILED and is not counted as deposited', async (t) => {
	const service = await loadService(t, {
		walletBalance: 40,
		transactions: [{ id: 'tx-ok', type: 'DEPOSIT', amount: 40, currency: 'USD', status: 'COMPLETED', paymentMethod: 'PAYPAL', referenceId: 'CAP-1', description: null, createdAt: new Date('2026-02-01') }],
		failedDeposits: [{ id: 'pp-1', userId: 'client-1', reference: 'REF-1', amount: 107, netAmount: 100, currency: 'USD', status: 'FAILED', createdAt: new Date('2026-02-02') }]
	});
	const wallet = await service.getWallet('client-1');
	assert.equal(wallet.summary.availableBalance, 40);
	assert.equal(wallet.summary.totalDeposited, 40);
	const failed = wallet.transactions.find((x: any) => x.id === 'paypal-failed-pp-1');
	assert.equal(failed.status, 'FAILED');
	assert.equal(failed.amount, 100);
	assert.match(failed.description, /لم يُضف أي مبلغ/);
	assert.equal(wallet.transactions[0].id, 'paypal-failed-pp-1'); // newest first
});

test('getWallet: an unknown user is refused', async (t) => {
	t.mock.module('../config/db', { namedExports: { prisma: { user: { findUnique: async () => null } } } });
	const { clientFinanceService } = await import(`./client-finance.service.ts?fixture=${Date.now()}-${Math.random()}`);
	await assert.rejects(clientFinanceService.getWallet('ghost'), /المستخدم غير موجود/);
});
