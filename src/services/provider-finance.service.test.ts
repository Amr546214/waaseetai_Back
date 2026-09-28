import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// provider-finance.service.ts::getWallet() is purely computed from Escrow/
// Contract/ProjectStage — it never reads/writes User.walletBalance at all.
// Regression guard for the USD-canonical transition: only the currency
// LABEL changes (SAR -> USD); the summation arithmetic must stay byte-for-
// byte identical, since the source amounts were never converted.

function createEscrowMockPrisma(t: TestContext, escrows: any[]) {
	const prismaMock: any = {
		escrow: { findMany: async () => escrows }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	return prismaMock;
}

async function loadService(t: TestContext, escrows: any[]) {
	createEscrowMockPrisma(t, escrows);
	const moduleUrl = `./provider-finance.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { providerFinanceService } = await import(moduleUrl);
	return providerFinanceService;
}

function makeEscrow(overrides: any = {}) {
	return {
		id: 'escrow-1',
		amount: 1000,
		releasedAmount: 400,
		status: 'HELD',
		updatedAt: new Date('2026-01-15'),
		createdAt: new Date('2026-01-01'),
		project: {
			id: 'project-1',
			title: 'مشروع تجريبي',
			status: 'IN_PROGRESS',
			contract: {
				price: 1000,
				stages: [
					{ id: 'stage-1', title: 'مرحلة أولى', amount: 400, approvedAt: new Date('2026-01-10') }
				]
			}
		},
		...overrides
	};
}

test('getWallet: summary.currency is USD', async (t) => {
	const service = await loadService(t, [makeEscrow()]);
	const wallet = await service.getWallet('provider-1');
	assert.equal(wallet.summary.currency, 'USD');
});

test('getWallet: availableBalance/escrowBalance arithmetic is unchanged — still the sum of releasedAmount / remaining entitlement', async (t) => {
	const service = await loadService(t, [makeEscrow({ amount: 1000, releasedAmount: 400 })]);
	const wallet = await service.getWallet('provider-1');
	// availableBalance = sum(releasedAmount) = 400
	assert.equal(wallet.summary.availableBalance, 400);
	// escrowBalance = sum(max(0, contract.price - releasedAmount)) = 1000 - 400 = 600
	assert.equal(wallet.summary.escrowBalance, 600);
});

test('getWallet: stage-release transaction entries carry currency USD', async (t) => {
	const service = await loadService(t, [makeEscrow()]);
	const wallet = await service.getWallet('provider-1');
	const stageTx = wallet.transactions.find((tx: any) => tx.category === 'STAGE_RELEASE');
	assert.ok(stageTx, 'expected a STAGE_RELEASE transaction entry');
	assert.equal(stageTx.currency, 'USD');
	assert.equal(stageTx.amount, 400); // unchanged from source stage.amount
});

test('getTransactions: escrow-funded entries carry currency USD, amount unchanged', async (t) => {
	const service = await loadService(t, [makeEscrow()]);
	const result = await service.getTransactions('provider-1');
	const fundingEvent = result.events.find((tx: any) => tx.category === 'ESCROW_FUNDED');
	assert.ok(fundingEvent, 'expected an ESCROW_FUNDED transaction entry');
	assert.equal(fundingEvent.currency, 'USD');
	assert.equal(fundingEvent.amount, 1000); // unchanged from source contract.price
});
