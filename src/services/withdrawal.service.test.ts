import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Regression guard for the USD-canonical transition: new withdrawal requests
// must explicitly carry currency USD (never rely on the Withdrawal schema's
// historical SAR default). Existing/historical Withdrawal rows are untouched
// by this — DEV currently has zero withdrawal rows to begin with.

function createWithdrawalMockPrisma(t: TestContext, opts: { availableBalance?: number } = {}) {
	const createSpy = t.mock.fn(async (args: any) => ({ id: 'withdrawal-1', ...args.data }));

	const prismaMock: any = {
		withdrawal: {
			aggregate: async () => ({ _sum: { amount: 0 } }),
			create: createSpy
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	t.mock.module('./provider-finance.service', {
		namedExports: {
			providerFinanceService: {
				getWallet: async () => ({ summary: { availableBalance: opts.availableBalance ?? 1000, currency: 'USD' } })
			}
		}
	});

	return { createSpy };
}

async function loadService(t: TestContext, opts?: Parameters<typeof createWithdrawalMockPrisma>[1]) {
	const mocks = createWithdrawalMockPrisma(t, opts);
	const moduleUrl = `./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { withdrawalService } = await import(moduleUrl);
	return { withdrawalService, ...mocks };
}

test('createForProvider: a new withdrawal request is explicitly created with currency USD', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, { availableBalance: 500 });

	await withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' });

	assert.equal(createSpy.mock.callCount(), 1);
	assert.equal(createSpy.mock.calls[0].arguments[0].data.currency, 'USD');
	assert.equal(createSpy.mock.calls[0].arguments[0].data.amount, 200);
});

test('createForProvider: still rejects a request exceeding the available (escrow-derived) balance', async (t) => {
	const { withdrawalService, createSpy } = await loadService(t, { availableBalance: 100 });

	await assert.rejects(() => withdrawalService.createForProvider('provider-1', { amount: 200, method: 'bank_transfer', iban: 'SA0000000000000000000000' }));
	assert.equal(createSpy.mock.callCount(), 0);
});
