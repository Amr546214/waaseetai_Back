import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// client-finance.service.ts's constructor chain pulls in moyasar.service.ts,
// which only reads process.env lazily — no API key needed just to import it.
// Regression guard for the USD-canonical wallet transition: getWallet()'s
// top-level summary.currency must now be 'USD' (both availableBalance and
// escrow/pricing are USD-semantic now), while each individual historical
// WalletTransaction row must keep exposing its OWN stored currency
// (never relabeled — SAR stays SAR, USD stays USD).

function createWalletMockPrisma(t: TestContext, opts: { walletBalance?: number; transactions?: any[]; projects?: any[] } = {}) {
	const prismaMock: any = {
		user: {
			findUnique: async () => ({ id: 'client-1', firstName: 'Amr', lastName: 'Okasha', walletBalance: opts.walletBalance ?? 0 })
		},
		project: {
			findMany: async () => opts.projects ?? []
		},
		walletTransaction: {
			findMany: async () => opts.transactions ?? []
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

test('getWallet: a historical SAR WalletTransaction row keeps exposing its own stored currency, never relabeled', async (t) => {
	const service = await loadService(t, {
		walletBalance: 100,
		transactions: [
			{ id: 'tx-sar', type: 'DEPOSIT', amount: 1000, currency: 'SAR', status: 'COMPLETED', paymentMethod: 'MOYASAR_CARD', referenceId: 'pay_1', description: null, createdAt: new Date('2026-01-01') }
		]
	});
	const wallet = await service.getWallet('client-1');
	const tx = wallet.transactions.find((t: any) => t.id === 'tx-sar');
	assert.equal(tx.currency, 'SAR');
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

test('getWallet: mixed historical SAR and new USD transactions both keep their own currency in the same response', async (t) => {
	const service = await loadService(t, {
		walletBalance: 150,
		transactions: [
			{ id: 'tx-sar', type: 'DEPOSIT', amount: 1000, currency: 'SAR', status: 'COMPLETED', paymentMethod: 'MOYASAR_CARD', referenceId: 'pay_1', description: null, createdAt: new Date('2026-01-01') },
			{ id: 'tx-usd', type: 'DEPOSIT', amount: 50, currency: 'USD', status: 'COMPLETED', paymentMethod: 'PAYPAL', referenceId: 'CAPTURE-1', description: null, createdAt: new Date('2026-02-01') }
		]
	});
	const wallet = await service.getWallet('client-1');
	assert.equal(wallet.transactions.find((t: any) => t.id === 'tx-sar').currency, 'SAR');
	assert.equal(wallet.transactions.find((t: any) => t.id === 'tx-usd').currency, 'USD');
	assert.equal(wallet.summary.currency, 'USD');
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
