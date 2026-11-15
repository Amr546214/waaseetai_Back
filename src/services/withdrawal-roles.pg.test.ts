import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL (isolated local database only, synthetic data): an account that holds BOTH the provider role and the marketer role has TWO independent withdrawal ledgers.
 * Each request carries its `source`; the provider's earnings are reduced only by provider withdrawals and the marketer's commissions only by marketer withdrawals,
 * in the requests, the wallets, the histories, the admin approval check and the notifications. A legacy row (source NULL) keeps its historical meaning.
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

test('pg: provider + marketer in ONE account: independent balances, requests, histories and approvals; legacy NULL rows follow the historical rule', opts, async () => {
	const { prisma } = await import('../config/db'); const { withdrawalService } = await import('./withdrawal.service'); const { providerFinanceService } = await import('./provider-finance.service'); const { marketerWalletService } = await import('./marketer-wallet.service');
	const id = () => randomUUID(); const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER', 'AFFILIATE'] as any, activeRole: 'PROVIDER' as any, status: 'ACTIVE', firstName: 'QA', lastName: 'both', email: `qa-both-${tag}@pg.test` } as any });
	const admin = await prisma.user.create({ data: { id: id(), accountType: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'] as any, activeRole: 'SUPER_ADMIN' as any, status: 'ACTIVE', firstName: 'QA', lastName: 'sa', email: `qa-sa-${tag}@pg.test` } as any });
	await prisma.providerProfile.create({ data: { userId: user.id, paypalPayoutEmail: `prov-${tag}@paypal.test` } as any });
	const aff = await prisma.affiliateProfile.create({ data: { userId: user.id, referralSlug: `s-${tag}`, paypalPayoutEmail: `mkt-${tag}@paypal.test` } as any });
	const client = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'] as any, activeRole: 'CLIENT' as any, status: 'ACTIVE', firstName: 'QA', lastName: 'cl', email: `qa-cl-${tag}@pg.test` } as any });
	// provider earnings: 200 released on one project; marketer commissions: 300 approved
	const project = await prisma.project.create({ data: { id: id(), title: `QA ${tag}`, description: 'x', specialty: 'x', deliveryDays: 5, clientId: client.id, providerId: user.id, status: 'COMPLETED' } as any });
	await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: user.id, price: 200, durationDays: 5, phasesCount: 1, status: 'COMPLETED', signedAt: new Date() } as any });
	await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: 200, releasedAmount: 200, status: 'RELEASED' } as any });
	const referred = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', roles: ['CLIENT'] as any, activeRole: 'CLIENT' as any, status: 'ACTIVE', firstName: 'QA', lastName: 'ref', email: `qa-ref-${tag}@pg.test` } as any });
	const ref = await prisma.referral.create({ data: { affiliateId: aff.id, referredUserId: referred.id } });
	await prisma.commissionLog.create({ data: { affiliateId: aff.id, referralId: ref.id, referredUserId: referred.id, baseAmount: 6000, appliedPercentage: 5, level: 2, type: 'FIRST_PROJECT_COMPLETED', amount: 300, currency: 'USD', status: 'APPROVED' } as any });

	// both wallets start with their own money, nothing blocked
	const p0: any = await providerFinanceService.getWallet(user.id); assert.equal(p0.summary.withdrawableBalance, 200);
	const m0: any = await marketerWalletService.getWallet(user.id); assert.equal(m0.withdrawableBalance, 300); assert.equal(m0.withdrawBlockedReason, null);
	// a marketer withdrawal of 250 (needs the commissions, ignores the provider earnings), then a provider withdrawal of 150
	const mw = await withdrawalService.createForMarketer(user.id, { amount: 250 } as any); assert.equal((mw as any).source, 'MARKETER');
	const pw = await withdrawalService.createForProvider(user.id, { amount: 150, method: 'paypal' } as any); assert.equal((pw as any).source, 'PROVIDER'); assert.equal(pw.paypalEmail, `prov-${tag}@paypal.test`); assert.equal(mw.paypalEmail, `mkt-${tag}@paypal.test`);
	// independence: each wallet is reduced only by ITS request
	const p1: any = await providerFinanceService.getWallet(user.id); assert.equal(p1.summary.pendingWithdrawals, 150); assert.equal(p1.summary.withdrawableBalance, 50);
	const m1: any = await marketerWalletService.getWallet(user.id); assert.equal(m1.withdrawableBalance, 50); assert.equal(m1.reservedWithdrawals ?? 250, 250);
	// limits are per ledger: 60 exceeds each balance (50) even though the sum of both would cover it
	await assert.rejects(() => withdrawalService.createForMarketer(user.id, { amount: 60 } as any), (e: any) => e.statusCode === 400);
	await assert.rejects(() => withdrawalService.createForProvider(user.id, { amount: 60, method: 'paypal' } as any), (e: any) => e.statusCode === 400);
	// histories never mix
	const provList = await withdrawalService.listForUser(user.id, undefined, 1, 50, 'PROVIDER' as any); const mktList = await withdrawalService.listForMarketer(user.id, undefined, 1, 50);
	assert.deepEqual(provList.items.map((r: any) => r.id), [pw.id]); assert.deepEqual(mktList.items.map((r: any) => r.id), [mw.id]);
	// the admin approves each against ITS ledger: the marketer one against the commissions (250 of 300), the provider one against the earnings (150 of 200)
	const detail: any = await withdrawalService.get(mw.id); assert.equal(detail.availableBalance, 300, 'the detail shows the commission balance');
	assert.equal((await withdrawalService.approve(mw.id, admin.id, {} as any)).status, 'APPROVED');
	assert.equal((await withdrawalService.approve(pw.id, admin.id, {} as any)).status, 'APPROVED');
	const p2: any = await providerFinanceService.getWallet(user.id); const m2: any = await marketerWalletService.getWallet(user.id);
	assert.equal(p2.summary.withdrawableBalance, 50); assert.equal(m2.withdrawableBalance, 50);
	// notifications follow the ledger: one marketer notice for the marketer request, one provider notice for the provider request
	const notes = await prisma.notification.findMany({ where: { userId: user.id, type: { in: ['WITHDRAWAL_REQUESTED', 'WITHDRAWAL_APPROVED'] } } as any, select: { type: true, actionUrl: true } });
	assert.equal(notes.filter(n => n.actionUrl === '/marketer-overview/withdraw').length, 2); assert.equal(notes.filter(n => n.actionUrl !== '/marketer-overview/withdraw').length, 2);
	// a LEGACY row (source NULL) of this provider-identity user belongs to the PROVIDER ledger (the historical rule): it reduces the provider balance and not the commissions
	await prisma.withdrawal.create({ data: { userId: user.id, amount: 20, currency: 'USD', method: 'paypal', status: 'PENDING', referenceId: `W-${id()}` } });
	const p3: any = await providerFinanceService.getWallet(user.id); const m3: any = await marketerWalletService.getWallet(user.id);
	assert.equal(p3.summary.withdrawableBalance, 30); assert.equal(m3.withdrawableBalance, 50);
});
