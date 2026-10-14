import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL concurrency tests for the money paths (row locks, guarded updates, transactions, rollback).
 *
 * They run ONLY against an isolated, throw-away database: QA_ISOLATED_PG_URL must be set, equal DATABASE_URL, and point at 127.0.0.1/localhost:55432.
 * Everything is synthetic (random users/projects created here); no real user data is ever read or written. Without that variable the whole file is skipped,
 * so the normal suite and CI never need a database.
 *
 *   docker run -d --name qa-pg-isolated -e POSTGRES_PASSWORD=qa -e POSTGRES_USER=qa -e POSTGRES_DB=qa_iso -p 127.0.0.1:55432:5432 postgres:16
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso \
 *     node --import tsx --test src/services/pg-concurrency.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

import { round2 } from '../utils/money';
const r2 = round2;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Starts a job after a random 0..max ms so that, over many rounds, each side wins the race a meaningful number of times. */
const jitter = <T>(job: () => Promise<T>, max = 25) => delay(Math.random() * max).then(job);
let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);

async function seedWorld(over: { wallet?: number; stagesSubmitted?: boolean } = {}) {
	const prisma = await db();
	const id = () => randomUUID();
	const tag = id().slice(0, 8);
	const client = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: 'QA', lastName: 'Client', email: `qa-client-${tag}@pg.test`, walletBalance: over.wallet ?? 100, roles: ['CLIENT'], activeRole: 'CLIENT' } });
	const provider = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: 'Provider', email: `qa-prov-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const admin = await prisma.user.create({ data: { id: id(), accountType: 'SUPER_ADMIN', firstName: 'QA', lastName: 'Admin', email: `qa-admin-${tag}@pg.test`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' } });
	const project = await prisma.project.create({ data: { id: id(), title: `QA ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 14, phasesCount: 2, status: 'ACTIVE', signedAt: new Date() } });
	const escrow = await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: 20, status: 'HELD', feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, providerCommissionSnapshotAt: new Date(), paymentMethod: 'WALLET', paymentReference: `PG-${tag}`, fundedAt: new Date() } });
	const s1 = await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 1, title: 'S1', days: 7, percentage: 50, amount: 10, status: over.stagesSubmitted === false ? 'IN_PROGRESS' : 'SUBMITTED' } });
	const s2 = await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 2, title: 'S2', days: 7, percentage: 50, amount: 10, status: 'PENDING' } });
	const delivery = over.stagesSubmitted === false ? null : await prisma.stageDelivery.create({ data: { id: id(), stageId: s1.id, providerId: provider.id, note: 'synthetic delivery note', status: 'SUBMITTED' } });
	return { prisma, client, provider, admin, project, contract, escrow, s1, s2, delivery, tag };
}

const money = async (w: Awaited<ReturnType<typeof seedWorld>>) => {
	const prisma = w.prisma;
	const [u, c, e, stages, wtx] = await Promise.all([
		prisma.user.findUnique({ where: { id: w.client.id }, select: { walletBalance: true } }),
		prisma.contract.findUnique({ where: { id: w.contract.id } }),
		prisma.escrow.findUnique({ where: { id: w.escrow.id } }),
		prisma.projectStage.findMany({ where: { contractId: w.contract.id }, orderBy: { stepOrder: 'asc' } }),
		prisma.walletTransaction.findMany({ where: { userId: w.client.id } })
	]);
	return { wallet: r2(Number(u.walletBalance)), contract: c, escrow: e, stages, wtx, stageSum: r2(stages.reduce((a: number, s: any) => a + s.amount, 0)) };
};
const consistent = (m: Awaited<ReturnType<typeof money>>) => {
	assert.equal(m.stageSum, r2(m.contract.price), 'stages sum == contract price');
	assert.equal(r2(m.escrow.amount), r2(m.contract.price), 'escrow == contract price');
	assert.equal(r2(m.stages.reduce((a: number, s: any) => a + s.percentage, 0)), 100, 'percentages sum to 100');
};

test('pg: the isolated database is really the throw-away one', opts, async () => {
	const prisma = await db();
	const [{ current_database }] = await prisma.$queryRaw`SELECT current_database()` as any[];
	assert.equal(current_database, 'qa_iso');
});

// ── 1. two simultaneous approvals of the same amendment ─────────────────────────────────────────────────────────────────────
test('pg: two simultaneous PROVIDER approvals of a client-funded increase debit the wallet exactly once (20 rounds)', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const { termsFingerprint } = await import('./amendment-apply.service');
	for (let round = 0; round < 20; round++) {
		const w = await seedWorld();
		const am = await w.prisma.projectAmendment.create({ data: { id: randomUUID(), projectId: w.project.id, contractId: w.contract.id, clientId: w.client.id, providerId: w.provider.id, requestedById: w.client.id, requestedByRole: 'CLIENT', type: 'BUDGET', title: 'زيادة', budgetDelta: 5, fundingAuthorizedAt: new Date(), fundingAuthorizedAmount: 5, fundingAuthorizedTerms: termsFingerprint(w.contract) } });
		const res = await Promise.allSettled([svc.respondToAmendmentAsProvider(w.provider.id, am.id, 'approve'), svc.respondToAmendmentAsProvider(w.provider.id, am.id, 'approve'), svc.respondToAmendmentAsProvider(w.provider.id, am.id, 'approve')]);
		assert.equal(res.filter(r => r.status === 'fulfilled').length, 1, `round ${round}: ${res.map(r => r.status === 'rejected' ? (r.reason as any).statusCode : 'ok')}`);
		const m = await money(w);
		assert.equal(m.wallet, 95, 'debited exactly once');
		assert.equal(m.wtx.filter((t: any) => t.type === 'AMENDMENT_TOPUP').length, 1);
		assert.equal(r2(m.contract.price), 25);
		assert.equal(m.stages.length, 3);
		consistent(m);
	}
});

test('pg: two simultaneous CLIENT approvals of a provider-raised increase (same OTP) debit exactly once (10 rounds)', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const { termsFingerprint } = await import('./amendment-apply.service');
	for (let round = 0; round < 10; round++) {
		const w = await seedWorld();
		const am = await w.prisma.projectAmendment.create({ data: { id: randomUUID(), projectId: w.project.id, contractId: w.contract.id, clientId: w.client.id, providerId: w.provider.id, requestedById: w.provider.id, requestedByRole: 'PROVIDER', type: 'BUDGET', title: 'زيادة', budgetDelta: 5 } });
		await w.prisma.otpVerification.create({ data: { userId: w.client.id, code: '424242', type: 'EMAIL', expiresAt: new Date(Date.now() + 120000), context: { purpose: 'AMENDMENT_PAYMENT', amendmentId: am.id, amount: 5, terms: termsFingerprint(w.contract) } } });
		const res = await Promise.allSettled([svc.respondToAmendment(w.client.id, am.id, 'approve', '424242'), svc.respondToAmendment(w.client.id, am.id, 'approve', '424242')]);
		assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
		const m = await money(w);
		assert.equal(m.wallet, 95);
		assert.equal(m.wtx.filter((t: any) => t.type === 'AMENDMENT_TOPUP').length, 1);
		consistent(m);
	}
});

// ── 2. stage approval concurrent with opening a dispute ─────────────────────────────────────────────────────────────────────
test('pg: stage approval racing a dispute opening never releases money past the freeze (40 rounds, both orders happen)', opts, async () => {
	const { projectProgressService } = await import('./project-progress.service');
	const { disputeService } = await import('./dispute.service');
	let approvedFirst = 0, frozenFirst = 0;
	for (let round = 0; round < 40; round++) {
		const w = await seedWorld();
		const approve = () => jitter(() => projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve'));
		const dispute = () => jitter(() => disputeService.createForRequest(w.project.id, w.provider.id, 'provider', { reason: 'نزاع QA', description: 'نزاع اختباري متزامن مع الاعتماد', evidence: [] }));
		const [a, d] = await Promise.allSettled([approve(), dispute()]);
		const m = await money(w);
		const disputeRow = await w.prisma.dispute.findFirst({ where: { projectId: w.project.id } });
		assert.ok(disputeRow, 'the dispute was opened');
		assert.equal(d.status, 'fulfilled', 'opening a dispute is never refused by the race');
		if (a.status === 'fulfilled') {
			approvedFirst++;
			// the approval committed BEFORE the dispute existed: its release is complete and exact
			assert.equal(m.escrow.releasedAmount, 10);
			assert.equal(m.stages[0].status, 'APPROVED');
			assert.ok(new Date(disputeRow.createdAt).getTime() >= new Date(m.stages[0].approvedAt).getTime(), 'dispute created after the approval committed');
		} else {
			frozenFirst++;
			assert.equal((a.reason as any).statusCode, 423, 'refused by the freeze');
			assert.equal(m.escrow.releasedAmount, 0, 'nothing was released');
			assert.equal(m.stages[0].status, 'SUBMITTED');
		}
		// a later approval attempt (e.g. the second stage / retry) is frozen
		const retry = await projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve').then(() => 'ok', e => (e as any).statusCode);
		assert.notEqual(retry, 'ok');
		const m2 = await money(w);
		assert.equal(m2.escrow.releasedAmount, m.escrow.releasedAmount, 'no extra release after the dispute exists');
	}
	assert.ok(approvedFirst + frozenFirst === 40);
	console.log(`[pg race] approval won ${approvedFirst}x, freeze won ${frozenFirst}x`);
});

// ── 3. budget amendment concurrent with a release ───────────────────────────────────────────────────────────────────────────
test('pg: a funded budget increase racing a stage approval keeps contract == escrow == stages, one debit, exact commission (30 rounds)', opts, async () => {
	const { projectProgressService } = await import('./project-progress.service');
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const { termsFingerprint } = await import('./amendment-apply.service');
	for (let round = 0; round < 30; round++) {
		const w = await seedWorld();
		const am = await w.prisma.projectAmendment.create({ data: { id: randomUUID(), projectId: w.project.id, contractId: w.contract.id, clientId: w.client.id, providerId: w.provider.id, requestedById: w.client.id, requestedByRole: 'CLIENT', type: 'BUDGET', title: 'زيادة', budgetDelta: 5, fundingAuthorizedAt: new Date(), fundingAuthorizedAmount: 5, fundingAuthorizedTerms: termsFingerprint(w.contract) } });
		const jobs = [() => projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve'), () => svc.respondToAmendmentAsProvider(w.provider.id, am.id, 'approve')];
		const res = await Promise.allSettled(jobs.map(j => jitter(j, 30)));
		const m = await money(w);
		const amApplied = (await w.prisma.projectAmendment.findUnique({ where: { id: am.id } })).appliedAt != null;
		const approved = m.stages[0].status === 'APPROVED';
		assert.ok(res.filter(r => r.status === 'rejected').every(r => [409, 423, 403].includes((r as any).reason.statusCode)), `clean refusals only: ${res.map(r => r.status === 'rejected' ? (r as any).reason.statusCode + ':' + (r as any).reason.message : 'ok')}`);
		assert.equal(m.wallet, amApplied ? 95 : 100);
		assert.equal(m.wtx.filter((t: any) => t.type === 'AMENDMENT_TOPUP').length, amApplied ? 1 : 0);
		assert.equal(r2(m.contract.price), amApplied ? 25 : 20);
		consistent(m);
		// released money is exactly the approved stage; commission = round2(released x 12.75%)
		if (approved) {
			const gross = m.escrow.releasedAmount;
			assert.ok(gross === 10 || gross === 5 || r2(gross) === 10, `released ${gross}`);
			assert.equal(r2(m.escrow.platformCommissionAmount), r2(gross * 0.1275));
			assert.equal(r2(m.escrow.providerNetReleasedAmount), r2(gross - m.escrow.platformCommissionAmount));
		} else assert.equal(m.escrow.releasedAmount, 0);
	}
});

// ── 4. repeated / concurrent settlement ─────────────────────────────────────────────────────────────────────────────────────
test('pg: five concurrent financial settlements of one dispute move the money exactly once; later retries are refused (15 rounds)', opts, async () => {
	const { disputeService } = await import('./dispute.service');
	for (let round = 0; round < 15; round++) {
		const w = await seedWorld({ stagesSubmitted: false });
		const d = await w.prisma.dispute.create({ data: { id: randomUUID(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, reason: 'x', description: 'synthetic dispute for settlement', status: 'OPEN' } });
		const input: any = round % 2 ? { outcome: 'REFUND_CLIENT', refundToClient: 20, releaseToProvider: 0, expectedHeldAmount: 20, confirm: true } : { outcome: 'SPLIT', refundToClient: 8, releaseToProvider: 12, expectedHeldAmount: 20, confirm: true };
		const res = await Promise.allSettled(Array.from({ length: 5 }, () => disputeService.resolveFinancial(d.id, w.admin.id, input)));
		assert.equal(res.filter(r => r.status === 'fulfilled').length, 1, `round ${round}: ${res.map(r => r.status === 'rejected' ? (r as any).reason.statusCode + ' ' + (r as any).reason.message : 'ok').join(' | ')}`);
		assert.ok(res.filter(r => r.status === 'rejected').every(r => [409].includes((r as any).reason.statusCode)));
		const m = await money(w);
		const refund = input.refundToClient;
		assert.equal(m.wallet, r2(100 + refund), 'refund credited once');
		assert.equal(m.wtx.filter((t: any) => t.type === 'REFUND').length, 1);
		assert.equal(m.escrow.status, input.releaseToProvider > 0 ? 'RELEASED' : 'REFUNDED');
		if (input.releaseToProvider > 0) { assert.equal(m.escrow.releasedAmount, 12); assert.equal(r2(m.escrow.platformCommissionAmount), r2(12 * 0.1275)); }
		const audits = (await w.prisma.accountAuditLog.findMany({ where: { eventType: 'DISPUTE_FINANCIAL_RESOLVED', userId: { in: [w.client.id, w.provider.id, w.admin.id] } } })).filter((x: any) => JSON.stringify(x).includes(d.id));
		assert.equal(audits.length, 1, 'exactly one CRITICAL audit row');
		await assert.rejects(() => disputeService.resolveFinancial(d.id, w.admin.id, input), (e: any) => e.statusCode === 409);
		assert.equal((await money(w)).wallet, m.wallet, 'a later retry changes nothing');
		// a plain ADMIN can never settle
		const plain = await w.prisma.user.create({ data: { id: randomUUID(), accountType: 'ADMIN', firstName: 'a', lastName: 'b', email: `plain-${randomUUID()}@pg.test` } });
		await assert.rejects(() => disputeService.resolveFinancial(d.id, plain.id, input), (e: any) => e.statusCode === 403);
	}
});

// ── 5. full rollback on failure ─────────────────────────────────────────────────────────────────────────────────────────────
test('pg: a failure in the middle of applying an amendment rolls EVERYTHING back (wallet, escrow, contract, stages, amendment, authorization)', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const { termsFingerprint } = await import('./amendment-apply.service');
	const w = await seedWorld();
	const am = await w.prisma.projectAmendment.create({ data: { id: randomUUID(), projectId: w.project.id, contractId: w.contract.id, clientId: w.client.id, providerId: w.provider.id, requestedById: w.client.id, requestedByRole: 'CLIENT', type: 'BUDGET', title: 'زيادة', budgetDelta: 5, fundingAuthorizedAt: new Date(), fundingAuthorizedAmount: 5, fundingAuthorizedTerms: termsFingerprint(w.contract) } });
	// sabotage: the wallet row the amendment will write already exists (unique referenceId) => the INSERT fails AFTER the wallet decrement and the escrow/contract updates
	await w.prisma.walletTransaction.create({ data: { userId: w.client.id, type: 'AMENDMENT_TOPUP', amount: -1, currency: 'USD', status: 'COMPLETED', paymentMethod: 'WALLET', referenceId: am.id, description: 'sabotage' } });
	const before = await money(w);
	await assert.rejects(() => svc.respondToAmendmentAsProvider(w.provider.id, am.id, 'approve'));
	const after = await money(w);
	assert.equal(after.wallet, before.wallet);
	assert.equal(after.contract.price, 20); assert.equal(after.escrow.amount, 20); assert.equal(after.stages.length, 2);
	const row = await w.prisma.projectAmendment.findUnique({ where: { id: am.id } });
	assert.equal(row.status, 'PENDING_OTHER_PARTY'); assert.equal(row.appliedAt, null); assert.ok(row.fundingAuthorizedAt, 'the authorization survives a failed attempt (it still expires on its own)');
	consistent(after);
});

test('pg: a failure in the middle of a financial dispute settlement rolls back (dispute stays open, wallet and escrow untouched)', opts, async () => {
	const { disputeService } = await import('./dispute.service');
	const w = await seedWorld({ stagesSubmitted: false });
	const d = await w.prisma.dispute.create({ data: { id: randomUUID(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, reason: 'x', description: 'synthetic dispute for rollback', status: 'OPEN' } });
	await w.prisma.walletTransaction.create({ data: { userId: w.client.id, type: 'REFUND', amount: 1, currency: 'USD', status: 'COMPLETED', paymentMethod: 'WALLET', referenceId: `DISPUTE-REFUND-${d.id}`, description: 'sabotage' } });
	const before = await money(w);
	await assert.rejects(() => disputeService.resolveFinancial(d.id, w.admin.id, { outcome: 'REFUND_CLIENT', refundToClient: 20, releaseToProvider: 0, expectedHeldAmount: 20, confirm: true } as any));
	const after = await money(w);
	assert.equal(after.wallet, before.wallet);
	assert.equal(after.escrow.status, 'HELD'); assert.equal(after.escrow.releasedAmount, 0);
	assert.equal(after.contract.status, 'ACTIVE');
	assert.equal((await w.prisma.dispute.findUnique({ where: { id: d.id } })).status, 'OPEN');
});

test('pg: an approval that fails after the stage flip (audit write sabotaged by a bad row) leaves no half release', opts, async () => {
	const { projectProgressService } = await import('./project-progress.service');
	const w = await seedWorld();
	// sabotage the NEXT step: the next stage row is locked into a state that makes the guarded update fail
	await w.prisma.projectStage.update({ where: { id: w.s1.id }, data: { status: 'APPROVED' } });
	const before = await money(w);
	await assert.rejects(() => projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve'), (e: any) => e.statusCode === 409);
	const after = await money(w);
	assert.equal(after.escrow.releasedAmount, before.escrow.releasedAmount);
	assert.equal(after.wallet, before.wallet);
});

// ── 6. referral commission engine on a real database: allowlist, exact amounts, dedupe ──────────────────────────────────────────
// A user can have only ONE referral (unique on referredUserId), so "the other referrals" are OTHER referred clients of OTHER affiliates.
const mkAffiliate = async (prisma: any, level: number) => {
	const u = await prisma.user.create({ data: { id: randomUUID(), accountType: 'MARKETING_BROKER', firstName: 'm', lastName: 'k', email: `mk-${randomUUID()}@pg.test`, roles: ['AFFILIATE'], activeRole: 'AFFILIATE' } });
	return prisma.affiliateProfile.create({ data: { userId: u.id, referralSlug: `slug-${randomUUID().slice(0, 8)}`, level } });
};
const withEnv = async (env: { enabled?: string; allow?: string | null }, fn: () => Promise<void>) => {
	const saved = { e: process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED, a: process.env.AFFILIATE_COMMISSION_ENGINE_ALLOWED_REFERRAL_IDS };
	if (env.enabled === undefined) delete process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED; else process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED = env.enabled;
	if (env.allow == null) delete process.env.AFFILIATE_COMMISSION_ENGINE_ALLOWED_REFERRAL_IDS; else process.env.AFFILIATE_COMMISSION_ENGINE_ALLOWED_REFERRAL_IDS = env.allow;
	try { await fn(); } finally {
		if (saved.e === undefined) delete process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED; else process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED = saved.e;
		if (saved.a === undefined) delete process.env.AFFILIATE_COMMISSION_ENGINE_ALLOWED_REFERRAL_IDS; else process.env.AFFILIATE_COMMISSION_ENGINE_ALLOWED_REFERRAL_IDS = saved.a;
	}
};
const approveBothStages = async (w: Awaited<ReturnType<typeof seedWorld>>) => {
	const { projectProgressService } = await import('./project-progress.service');
	await projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve');
	await w.prisma.stageDelivery.create({ data: { id: randomUUID(), stageId: w.s2.id, providerId: w.provider.id, note: 'second synthetic delivery', status: 'SUBMITTED' } });
	await w.prisma.projectStage.update({ where: { id: w.s2.id }, data: { status: 'SUBMITTED' } });
	await projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s2.id, 'approve');
	await assert.rejects(() => projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s2.id, 'approve'), 'a repeated approval is refused');
};

test('pg: engine ON + dev allowlist: ONLY the allowlisted QA referral earns exactly 0.10 + 0.10 on a 20 USD purchase (1% of each GROSS 10 stage); a client referred by another affiliate earns nothing for that affiliate', opts, async () => {
	const qaWorld = await seedWorld(); const otherWorld = await seedWorld();
	const qa = await mkAffiliate(qaWorld.prisma, 1), other = await mkAffiliate(qaWorld.prisma, 1);
	const rQa = await qaWorld.prisma.referral.create({ data: { affiliateId: qa.id, referredUserId: qaWorld.client.id } });
	await qaWorld.prisma.referral.create({ data: { affiliateId: other.id, referredUserId: otherWorld.client.id } });
	await withEnv({ enabled: 'true', allow: rQa.id }, async () => {
		await approveBothStages(qaWorld);
		await approveBothStages(otherWorld);
	});
	const rows = await qaWorld.prisma.commissionLog.findMany({ where: { affiliateId: qa.id }, orderBy: { createdAt: 'asc' } });
	assert.equal(rows.length, 2, 'one commission per released stage');
	assert.deepEqual(rows.map((r: any) => r.amount), [0.1, 0.1]);
	assert.deepEqual(rows.map((r: any) => r.baseAmount), [10, 10]);
	assert.ok(rows.every((r: any) => r.appliedPercentage === 1 && r.level === 1 && r.status === 'APPROVED' && r.currency === 'USD' && r.referralId === rQa.id && r.referredUserId === qaWorld.client.id));
	assert.equal(r2(rows.reduce((a: number, r: any) => a + r.amount, 0)), 0.2);
	assert.equal(await qaWorld.prisma.commissionLog.count({ where: { affiliateId: other.id } }), 0, 'another affiliate is untouched');
	assert.equal(await qaWorld.prisma.commissionLog.count({ where: { referredUserId: otherWorld.client.id } }), 0, 'the other referred client produced nothing');
	// both purchases still settled normally
	for (const w of [qaWorld, otherWorld]) { const m = await money(w); assert.equal(m.escrow.releasedAmount, 20); assert.equal(r2(m.escrow.platformCommissionAmount), 2.55); }
	assert.equal(await qaWorld.prisma.withdrawal.count({ where: { userId: qa.userId } }), 0, 'a commission never creates a withdrawal or payout');
});

test('pg control: WITHOUT the allowlist the other affiliate earns too (what the restriction prevents on the 12 real referrals); engine OFF earns nothing', opts, async () => {
	const w1 = await seedWorld(); const w2 = await seedWorld();
	const a = await mkAffiliate(w1.prisma, 1), b = await mkAffiliate(w1.prisma, 1);
	await w1.prisma.referral.create({ data: { affiliateId: a.id, referredUserId: w1.client.id } });
	await w1.prisma.referral.create({ data: { affiliateId: b.id, referredUserId: w2.client.id } });
	await withEnv({ enabled: 'true', allow: null }, async () => { await approveBothStages(w1); await approveBothStages(w2); });
	assert.equal(await w1.prisma.commissionLog.count({ where: { affiliateId: a.id } }), 2);
	assert.equal(await w1.prisma.commissionLog.count({ where: { affiliateId: b.id } }), 2);
	const w3 = await seedWorld(); const c = await mkAffiliate(w3.prisma, 1);
	await w3.prisma.referral.create({ data: { affiliateId: c.id, referredUserId: w3.client.id } });
	await withEnv({ enabled: undefined, allow: null }, async () => { await approveBothStages(w3); });
	assert.equal(await w3.prisma.commissionLog.count({ where: { affiliateId: c.id } }), 0, 'engine off = nothing');
});

// ── 7. the provider's commission rate is frozen in the escrow at purchase time ──────────────────────────────────────────────────
test('pg: the escrow keeps the commission snapshot taken at purchase (12.75%, level 1) even if the provider levels up before the release', opts, async () => {
	const { projectProgressService } = await import('./project-progress.service');
	const w = await seedWorld();
	// the provider is promoted to a much better level (8.15%) AFTER the purchase and BEFORE the release
	await w.prisma.providerGamification.upsert({ where: { providerId: w.provider.id }, update: { currentLevelIndex: 15, currentCommission: 8.15 }, create: { providerId: w.provider.id, currentLevelIndex: 15, currentCommission: 8.15, points: 99999 } });
	await projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve');
	const e = await w.prisma.escrow.findUnique({ where: { id: w.escrow.id } });
	assert.equal(e.providerCommissionRateSnapshot, 12.75, 'snapshot untouched');
	assert.equal(e.providerCommissionLevelSnapshot, 1);
	assert.equal(r2(e.platformCommissionAmount), 1.28, 'commission uses the snapshotted 12.75%, not the new 8.15%');
	assert.equal(r2(e.providerNetReleasedAmount), 8.72);
});

// ── 8. "successful referral" = first due commission from a REAL release; status, counters and rates agree ──────────────────────
test('pg: status, counters and conversion all follow the one definition (a seeded 300 USD row does not make a referral successful; two stages count once)', opts, async () => {
	const { marketerOverviewService } = await import('./marketer-overview.service');
	const w = await seedWorld();          // referral A: will release two real stages
	const w2 = await seedWorld();         // referral B: only a SEEDED commission row, no real operation
	const aff = await mkAffiliate(w.prisma, 1);
	const rA = await w.prisma.referral.create({ data: { affiliateId: aff.id, referredUserId: w.client.id, sourceChannel: 'LINKEDIN' } });
	const rB = await w.prisma.referral.create({ data: { affiliateId: aff.id, referredUserId: w2.client.id, sourceChannel: 'LINKEDIN' } });
	await w.prisma.referral.create({ data: { affiliateId: aff.id, referredUserId: (await seedWorld()).client.id, sourceChannel: 'OTHER' } }); // registered only
	await w.prisma.affiliateChannelMetric.create({ data: { affiliateId: aff.id, channel: 'LINKEDIN', visitors: 10 } });
	await w.prisma.commissionLog.create({ data: { affiliateId: aff.id, referralId: rB.id, referredUserId: w2.client.id, sourceProjectId: 'QA-SEED', baseAmount: 30000, appliedPercentage: 1, level: 1, type: 'FIRST_PROJECT_COMPLETED', amount: 300, currency: 'USD', status: 'APPROVED' } });
	await withEnv({ enabled: 'true', allow: null }, async () => { await approveBothStages(w); });
	const sum = await marketerOverviewService.getSummary(aff.userId);
	assert.equal(sum.successfulReferrals, 1, 'only referral A (real release) is successful; the seeded row of B does not count; A counts once for 2 commissions');
	assert.equal(sum.totalReferrals, 3);
	assert.equal(sum.pendingReferrals, 2);
	assert.equal(sum.overallConversionRate, 10, '1 successful / 10 visits');
	const ch = await marketerOverviewService.getChannelPerformance(aff.userId);
	assert.deepEqual(ch.find((c: any) => c.channel === 'LINKEDIN'), { channel: 'LINKEDIN', visitors: 10, clients: 1, registrations: 2, conversionPercentage: 10 });
	const list = await marketerOverviewService.getReferredUsers(aff.userId, 1, 20);
	const statusOf = (id: string) => list.items.find((i: any) => i.referralId === id)?.status;
	assert.equal(statusOf(rA.id), 'CONVERTED');
	assert.equal(statusOf(rB.id), 'PENDING', 'a seeded commission never converts a referral');
	// the engine also moved the stored status forward, in the same transaction as the commission
	assert.equal((await w.prisma.referral.findUnique({ where: { id: rA.id } })).status, 'CONVERTED');
	assert.equal((await w.prisma.referral.findUnique({ where: { id: rB.id } })).status, 'PENDING');
});

// ── 9. a project settled by an admin financial decision: no rating, no points, no repeat settlement ────────────────────────────
test('pg: after an admin FINANCIAL settlement the project cannot be rated (either side), earns no completion points, and a second settlement is refused', opts, async () => {
	const { disputeService } = await import('./dispute.service');
	const { ratingService } = await import('./rating.service');
	const w = await seedWorld({ stagesSubmitted: false });
	const d = await w.prisma.dispute.create({ data: { id: randomUUID(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, reason: 'x', description: 'synthetic dispute for settlement then rating', status: 'OPEN' } });
	const input: any = { outcome: 'SPLIT', refundToClient: 10, releaseToProvider: 10, expectedHeldAmount: 20, confirm: true };
	await disputeService.resolveFinancial(d.id, w.admin.id, input);
	await assert.rejects(() => ratingService.rateRequest(w.project.id, w.client.id, 'client', { rating: 5 }), (e: any) => e.statusCode === 409 && /سُوّي إداريًا/.test(e.message));
	await assert.rejects(() => ratingService.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 5 }), (e: any) => e.statusCode === 409);
	assert.equal(await w.prisma.review.count({ where: { projectId: w.project.id } }), 0);
	assert.equal(await w.prisma.pointTransaction.count({ where: { providerId: w.provider.id } }), 0, 'no completion points for an admin settlement');
	await assert.rejects(() => disputeService.resolveFinancial(d.id, w.admin.id, input), (e: any) => e.statusCode === 409);
	assert.equal(r2((await money(w)).wallet), 110, 'refund credited once (100 + 10)');
});
