import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL tests for the remaining amendment kinds (duration, scope, price DECREASE) and the dispute freeze lifecycle (text closure unfreezes,
 * several active disputes, a text closure never completes a project). Isolated database only (see pg-concurrency.pg.test.ts); synthetic data only.
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


const raise = (w: Awaited<ReturnType<typeof seedWorld>>, by: 'PROVIDER' | 'CLIENT', data: Record<string, unknown>) =>
	w.prisma.projectAmendment.create({ data: { id: randomUUID(), projectId: w.project.id, contractId: w.contract.id, clientId: w.client.id, providerId: w.provider.id, requestedById: by === 'PROVIDER' ? w.provider.id : w.client.id, requestedByRole: by, title: 'QA', ...data } });
const stageDays = async (w: Awaited<ReturnType<typeof seedWorld>>) => (await w.prisma.projectStage.findMany({ where: { contractId: w.contract.id } })).reduce((a: number, s: any) => a + s.days, 0);

// ── amendments: duration, scope, price decrease ─────────────────────────────────────────────────────────────────────────────────
test('pg: a DURATION amendment moves the contract days and the stage days together and no money', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const w = await seedWorld();
	const before = await money(w); const daysBefore = await stageDays(w);
	const am = await raise(w, 'PROVIDER', { type: 'DURATION', durationDeltaDays: 3 });
	await svc.respondToAmendment(w.client.id, am.id, 'approve');
	const m = await money(w);
	assert.equal(m.contract.durationDays, 17); assert.equal(await stageDays(w), daysBefore + 3, 'sum(stage days) moves by exactly the delta');
	assert.equal(m.wallet, before.wallet); assert.equal(m.contract.price, before.contract.price); assert.equal(m.wtx.length, before.wtx.length);
	consistent(m);
});

test('pg: a SCOPE amendment creates a versioned addendum (termsVersion + 1) and changes no money or days', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const w = await seedWorld();
	const before = await money(w);
	const am = await raise(w, 'CLIENT', { type: 'SCOPE', description: 'إضافة صفحة تواصل جديدة ضمن النطاق دون تكلفة إضافية' });
	await svc.respondToAmendmentAsProvider(w.provider.id, am.id, 'approve');
	const m = await money(w);
	assert.equal(m.contract.termsVersion, 2);
	const versions = await w.prisma.contractTermsVersion.findMany({ where: { contractId: w.contract.id } });
	assert.equal(versions.length, 1); assert.equal(versions[0].version, 2); assert.equal(versions[0].amendmentId, am.id);
	assert.equal(m.wallet, before.wallet); assert.equal(m.contract.price, before.contract.price); assert.equal(m.contract.durationDays, before.contract.durationDays);
	consistent(m);
});

test('pg: a price DECREASE takes from the last undelivered unreleased stage, refunds the client once, and never touches a delivered stage', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const w = await seedWorld();   // s1 SUBMITTED (has a delivery), s2 PENDING (nothing delivered)
	const before = await money(w);
	const am = await raise(w, 'PROVIDER', { type: 'BUDGET', budgetDelta: -4 });
	await svc.respondToAmendment(w.client.id, am.id, 'approve');
	const m = await money(w);
	assert.equal(r2(m.contract.price), 16); assert.equal(r2(m.escrow.amount), 16);
	assert.equal(m.stages[0].amount, 10, 'the delivered stage is untouched'); assert.equal(m.stages[1].amount, 6, 'only the undelivered stage absorbed the decrease');
	assert.equal(m.wallet, r2(before.wallet + 4), 'refund credited once');
	assert.equal(m.wtx.filter((t: any) => t.type === 'AMENDMENT_REFUND').length, 1);
	consistent(m);
	await assert.rejects(() => svc.respondToAmendment(w.client.id, am.id, 'approve'), (e: any) => e.statusCode === 409); // retry: nothing more is refunded
	assert.equal((await money(w)).wallet, m.wallet);
});

test('pg: a price decrease is REFUSED when it would go below what is released, or when no stage can absorb it; nothing changes', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	// (a) no editable stage: both stages already delivered
	const w = await seedWorld();
	await w.prisma.stageDelivery.create({ data: { id: randomUUID(), stageId: w.s2.id, providerId: w.provider.id, note: 'second delivery', status: 'SUBMITTED' } });
	await w.prisma.projectStage.update({ where: { id: w.s2.id }, data: { status: 'SUBMITTED' } });
	const before = await money(w);
	const a1 = await raise(w, 'PROVIDER', { type: 'BUDGET', budgetDelta: -3 });
	await assert.rejects(() => svc.respondToAmendment(w.client.id, a1.id, 'approve'), (e: any) => e.statusCode === 409);
	// (b) more than the unreleased part
	const w2 = await seedWorld();
	const a2 = await raise(w2, 'PROVIDER', { type: 'BUDGET', budgetDelta: -25 });
	await assert.rejects(() => svc.respondToAmendment(w2.client.id, a2.id, 'approve'), (e: any) => e.statusCode === 409);
	for (const [world, snap] of [[w, before], [w2, null]] as const) {
		const m = await money(world);
		assert.equal(r2(m.contract.price), 20); assert.equal(r2(m.escrow.amount), 20); assert.equal(m.wtx.filter((t: any) => t.type === 'AMENDMENT_REFUND').length, 0);
		if (snap) assert.equal(m.wallet, snap.wallet);
	}
});

// ── dispute lifecycle: text closure, several active disputes ────────────────────────────────────────────────────────────────────
test('pg: a TEXT closure unfreezes the project (approval works again) but does NOT complete it; the contract stays ACTIVE', opts, async () => {
	const { projectProgressService } = await import('./project-progress.service');
	const { disputeService } = await import('./dispute.service');
	const w = await seedWorld();
	const d = await disputeService.createForRequest(w.project.id, w.provider.id, 'provider', { reason: 'نزاع نصي', description: 'نزاع اختباري يُغلق نصيًا دون أثر مالي', evidence: [] });
	await assert.rejects(() => projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve'), (e: any) => e.statusCode === 423);
	const frozen = await money(w); assert.equal(frozen.escrow.releasedAmount, 0);
	await disputeService.resolve(d.id, w.admin.id, { action: 'resolve', resolution: 'MUTUAL_CLOSE' } as any);
	const afterClose = await money(w);
	assert.equal(afterClose.contract.status, 'ACTIVE', 'a text closure does not complete or cancel the contract');
	assert.equal(afterClose.escrow.status, 'HELD'); assert.equal(afterClose.escrow.releasedAmount, 0); assert.equal(afterClose.wallet, frozen.wallet, 'no money moved');
	await projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve'); // unfrozen: the real stage approval now works
	const m = await money(w);
	assert.equal(m.stages[0].status, 'APPROVED'); assert.equal(m.escrow.releasedAmount, 10); assert.equal(m.contract.status, 'ACTIVE', 'one of two stages approved: still active');
	assert.equal(m.stages[1].status, 'IN_PROGRESS');
});

test('pg: with two active disputes on one project, closing one keeps the freeze; closing both lifts it', opts, async () => {
	const { projectProgressService } = await import('./project-progress.service');
	const { disputeService } = await import('./dispute.service');
	const w = await seedWorld();
	const d1 = await disputeService.createForRequest(w.project.id, w.provider.id, 'provider', { reason: 'نزاع أول', description: 'نزاع اختباري أول على المشروع نفسه', evidence: [] });
	const d2 = await disputeService.createForRequest(w.project.id, w.client.id, 'client', { reason: 'نزاع ثان', description: 'نزاع اختباري ثان على المشروع نفسه', evidence: [] });
	await disputeService.resolve(d1.id, w.admin.id, { action: 'resolve', resolution: 'NO_FINANCIAL_CHANGE' } as any);
	await assert.rejects(() => projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve'), (e: any) => e.statusCode === 423, 'still frozen by the second dispute');
	await disputeService.resolve(d2.id, w.admin.id, { action: 'resolve', resolution: 'MUTUAL_CLOSE' } as any);
	await projectProgressService.reviewDelivery(w.client.id, w.contract.id, w.s1.id, 'approve');
	assert.equal((await money(w)).escrow.releasedAmount, 10);
});

test('pg: a pending amendment cannot be applied once the contract was closed by a settlement, and the history stays', opts, async () => {
	const { projectAmendmentService: svc } = await import('./project-amendment.service');
	const { disputeService } = await import('./dispute.service');
	const w = await seedWorld({ stagesSubmitted: false });
	const am = await raise(w, 'PROVIDER', { type: 'DURATION', durationDeltaDays: 2 });
	const d = await w.prisma.dispute.create({ data: { id: randomUUID(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, reason: 'x', description: 'synthetic dispute for amendment closure', status: 'OPEN' } });
	await disputeService.resolveFinancial(d.id, w.admin.id, { outcome: 'SPLIT', refundToClient: 8, releaseToProvider: 12, expectedHeldAmount: 20, confirm: true } as any);
	await assert.rejects(() => svc.respondToAmendment(w.client.id, am.id, 'approve'), (e: any) => e.statusCode === 409);
	const row = await w.prisma.projectAmendment.findUnique({ where: { id: am.id } });
	assert.equal(row.status, 'PENDING_OTHER_PARTY'); assert.equal(row.appliedAt, null);
	assert.equal((await money(w)).contract.durationDays, 14);
});
