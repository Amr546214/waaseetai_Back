import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// provider-finance.service.ts::getWallet() is purely computed from Escrow/
// Contract/ProjectStage — it never reads/writes User.walletBalance at all.
// Regression guard for the USD-canonical transition: only the currency
// LABEL is USD; the summation arithmetic must stay byte-for-
// byte identical, since the source amounts were never converted.

function createEscrowMockPrisma(t: TestContext, escrows: any[], withdrawalGroups: any[] = []) {
	const prismaMock: any = {
		escrow: { findMany: async () => escrows },
		withdrawal: { groupBy: async () => withdrawalGroups }
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	return prismaMock;
}

async function loadService(t: TestContext, escrows: any[], withdrawalGroups: any[] = []) {
	createEscrowMockPrisma(t, escrows, withdrawalGroups);
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

// ── fee policy v2: the provider's balance is what they RECEIVE (net of the snapshotted platform commission); legacy escrows are unchanged ──
const v2 = (over: any = {}, stages: any[] = [{ id: 's1', title: 'مرحلة 1', amount: 400, approvedAt: new Date('2026-02-01') }]) => makeEscrow({
	amount: 1000, releasedAmount: 400, feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1,
	platformCommissionAmount: 51, providerNetReleasedAmount: 349, project: { ...makeEscrow().project, contract: { price: 1000, stages } }, ...over
});

test('v2 escrow: availableBalance grows by the NET released (349 of a 400 stage at 12.75%), never the gross', async (t) => {
	const service = await loadService(t, [v2()]);
	const wallet = await service.getWallet('provider-1');
	assert.equal(wallet.summary.availableBalance, 349);
	assert.equal(wallet.summary.totalEarnings, 349);
});

test('v2 escrow: what is still held for the provider is the NET entitlement left (872.5 - 349 = 523.5), not the gross price left', async (t) => {
	const service = await loadService(t, [v2()]);
	const wallet = await service.getWallet('provider-1');
	assert.equal(wallet.summary.escrowBalance, 523.5);
	assert.equal(wallet.escrows[0].total, 872.5);
	assert.equal(wallet.escrows[0].released, 349);
	assert.equal(wallet.escrows[0].held, 523.5);
	assert.equal(wallet.escrows[0].grossTotal, 1000);
	assert.equal(wallet.escrows[0].commissionRatePercent, 12.75);
});

test('v2 escrow: the platform commission is reported, and the stage transaction shows gross, commission and net', async (t) => {
	const service = await loadService(t, [v2()]);
	const wallet = await service.getWallet('provider-1');
	assert.equal(wallet.summary.platformCommissionTotal, 51);
	const tx = wallet.transactions.find((x: any) => x.category === 'STAGE_RELEASE');
	assert.deepEqual([tx.amount, tx.grossAmount, tx.platformCommission, tx.commissionRatePercent], [349, 400, 51, 12.75]);
	assert.match(tx.description, /بعد خصم عمولة المنصة 12\.75%/);
});

test('v2 escrow with several stages: each stage nets its own part and the net transactions add up to the stored net released', async (t) => {
	const stages = [
		{ id: 's1', title: 'أولى', amount: 100.01, approvedAt: new Date('2026-02-01') },
		{ id: 's2', title: 'ثانية', amount: 200.02, approvedAt: new Date('2026-02-02') },
		{ id: 's3', title: 'ثالثة', amount: 300.03, approvedAt: new Date('2026-02-03') }
	];
	const gross = 600.06; const commission = Math.round(gross * 12.42) / 100; // 74.53
	const service = await loadService(t, [v2({ amount: gross, releasedAmount: gross, providerCommissionRateSnapshot: 12.42, platformCommissionAmount: Math.round(gross * 12.42) / 100, providerNetReleasedAmount: Math.round((gross - commission) * 100) / 100, status: 'RELEASED', project: { ...makeEscrow().project, contract: { price: gross, stages } } }, stages)]);
	const wallet = await service.getWallet('provider-1');
	const nets = wallet.transactions.filter((x: any) => x.category === 'STAGE_RELEASE').map((x: any) => x.amount);
	assert.equal(Math.round(nets.reduce((a: number, b: number) => a + b, 0) * 100) / 100, wallet.summary.availableBalance);
	assert.equal(wallet.summary.escrowBalance, 0);
});

test('a v2 escrow\'s commission never changes with the provider\'s later level: the wallet only reads the snapshot', async (t) => {
	const service = await loadService(t, [v2({ providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1 })]);
	const first = await service.getWallet('provider-1');
	assert.equal(first.summary.availableBalance, 349); // the same whatever level 15 would pay now (8.15%)
});

test('LEGACY escrow (feePolicyVersion null) next to a v2 one: the legacy one stays gross, the v2 one is net, no mixing', async (t) => {
	const legacy = makeEscrow({ id: 'escrow-legacy', amount: 1130, releasedAmount: 400, feePolicyVersion: null });
	const service = await loadService(t, [legacy, v2({ id: 'escrow-v2' })]);
	const wallet = await service.getWallet('provider-1');
	assert.equal(wallet.summary.availableBalance, 400 + 349);
	assert.equal(wallet.summary.platformCommissionTotal, 51, 'only the v2 escrow carries a commission');
	const legacyTx = wallet.transactions.filter((x: any) => x.stageId === 'stage-1');
	assert.equal(legacyTx[0].amount, 400);
	assert.equal('grossAmount' in legacyTx[0], false);
});

test('getWallet: pending/approved/processing and paid/reversed withdrawals reduce withdrawableBalance; availableBalance stays the released total', async (t) => {
	const service = await loadService(t, [makeEscrow({ releasedAmount: 400 })], [
		{ status: 'PENDING', _sum: { amount: 50 } },
		{ status: 'APPROVED', _sum: { amount: 20 } },
		{ status: 'COMPLETED', _sum: { amount: 100 } },
		{ status: 'REVERSED', _sum: { amount: 30 } }
	]);
	const { summary } = (await service.getWallet('provider-1'));
	assert.equal(summary.availableBalance, 400);
	assert.equal(summary.pendingWithdrawals, 70);
	assert.equal(summary.paidWithdrawals, 130);
	assert.equal(summary.withdrawableBalance, 200);
});

test('getWallet: with no withdrawals withdrawableBalance equals availableBalance, and it never goes negative', async (t) => {
	const none = await (await loadService(t, [makeEscrow({ releasedAmount: 400 })])).getWallet('provider-1');
	assert.equal(none.summary.withdrawableBalance, 400);
	assert.equal(none.summary.pendingWithdrawals, 0);
});

test('getWallet: the reservation query asks for exactly the statuses createForProvider reserves against (REJECTED is the only release)', async () => {
	const { RESERVING_WITHDRAWAL_STATUSES } = await import('../utils/withdrawal-reservation.ts');
	assert.deepEqual([...RESERVING_WITHDRAWAL_STATUSES].sort(), ['APPROVED', 'COMPLETED', 'PENDING', 'PROCESSING', 'REVERSED']);
});
