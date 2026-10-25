import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL tests of the project lifecycle (single source of truth: project-lifecycle.service) and of the endpoints that enforce it.
 * Runs ONLY against the isolated throw-away database (QA_ISOLATED_PG_URL == DATABASE_URL on 127.0.0.1/localhost:55432); skipped otherwise. All data is synthetic.
 *
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_life npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --test src/services/pg-lifecycle.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const refused = (status: number, re?: RegExp, code?: string) => (e: any) => e.statusCode === status && (!re || re.test(e.message)) && (!code || e.errors?.[0]?.code === code);

type StageSeed = { status: string; amount: number; delivery?: 'SUBMITTED' | 'APPROVED' | 'REVISION_REQUESTED' | null };
async function seed(over: { price?: number; contractStatus?: string; stages?: StageSeed[]; rate?: number; escrowStatus?: string; released?: number } = {}) {
	const prisma = await db();
	const id = () => randomUUID();
	const tag = id().slice(0, 8);
	const price = over.price ?? 20;
	const client = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: 'QA', lastName: 'Client', email: `life-client-${tag}@pg.test`, walletBalance: 100, roles: ['CLIENT'], activeRole: 'CLIENT' } });
	const provider = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: 'Provider', email: `life-prov-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const stranger = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: 'QA', lastName: 'Stranger', email: `life-str-${tag}@pg.test`, roles: ['CLIENT'], activeRole: 'CLIENT' } });
	const admin = await prisma.user.create({ data: { id: id(), accountType: 'SUPER_ADMIN', status: 'ACTIVE', firstName: 'QA', lastName: 'Admin', email: `life-admin-${tag}@pg.test`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' } });
	const project = await prisma.project.create({ data: { id: id(), title: `QA lifecycle ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price, durationDays: 14, phasesCount: 2, status: over.contractStatus ?? 'ACTIVE', signedAt: new Date() } });
	const rate = over.rate ?? 12.4;
	const escrow = await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: price, status: over.escrowStatus ?? 'HELD', releasedAmount: over.released ?? 0, feePolicyVersion: 2, providerCommissionRateSnapshot: rate, providerCommissionLevelSnapshot: 1, providerCommissionSnapshotAt: new Date() } });
	const stageSeeds: StageSeed[] = over.stages ?? [{ status: 'SUBMITTED', amount: price / 2, delivery: 'SUBMITTED' }, { status: 'PENDING', amount: price / 2 }];
	const total = stageSeeds.reduce((a, s) => a + s.amount, 0);
	const stages: any[] = [];
	for (const [i, s] of stageSeeds.entries()) {
		const st = await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: i + 1, title: `المرحلة ${i + 1}: عنوان`, days: 5, percentage: Math.round((s.amount / total) * 10000) / 100, amount: s.amount, status: s.status, approvedAt: s.status === 'APPROVED' ? new Date() : null } });
		if (s.delivery) await prisma.stageDelivery.create({ data: { id: id(), stageId: st.id, providerId: provider.id, note: 'synthetic delivery note', status: s.delivery } });
		stages.push(st);
	}
	return { prisma, client, provider, stranger, admin, project, contract, escrow, stages, tag };
}
type World = Awaited<ReturnType<typeof seed>>;

const services = async () => ({
	progress: (await import('./project-progress.service')).projectProgressService,
	disputes: (await import('./dispute.service')).disputeService,
	clientRequests: (await import('./client-requests.service')).clientRequestsService,
	admin: (await import('./admin-operations.service')).adminOperationsService
});
const openDispute = async (w: World, by: 'client' | 'provider' = 'client') => {
	const { disputes } = await services();
	return disputes.createForRequest(w.project.id, by === 'client' ? w.client.id : w.provider.id, by, { reason: 'نزاع QA', description: 'نزاع اختباري لحالة دورة الحياة', evidence: [] } as any);
};
const snapshot = async (w: World) => {
	const [stages, contract, project, escrow] = await Promise.all([
		w.prisma.projectStage.findMany({ where: { contractId: w.contract.id }, orderBy: { stepOrder: 'asc' } }),
		w.prisma.contract.findUnique({ where: { id: w.contract.id } }), w.prisma.project.findUnique({ where: { id: w.project.id } }), w.prisma.escrow.findUnique({ where: { projectId: w.project.id } })
	]);
	return JSON.stringify({ stages: stages.map((s: any) => [s.id, s.status]), contract: contract.status, project: project.status, escrow: [escrow.status, escrow.releasedAmount], deliveries: await w.prisma.stageDelivery.count({ where: { stageId: { in: stages.map((s: any) => s.id) } } }) });
};

test('pg-life: the isolated database is really a throw-away one', opts, async () => {
	const prisma = await db();
	const [{ current_database }] = await prisma.$queryRaw`SELECT current_database()` as any[];
	assert.match(current_database, /^qa_iso/);
});

// ── normal ACTIVE project ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('pg-life: normal ACTIVE project with a delivered stage — «بانتظار مراجعة العميل», eligibility for both sides, approve moves to the next stage in real order', opts, async () => {
	const { progress } = await services();
	const w = await seed();
	const c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.operationalStatus, 'ACTIVE');
	assert.equal(c.completedByDelivery, false);
	assert.equal(c.closedBySettlement, false);
	assert.equal(c.lifecycle.stages[0].displayStatusLabel, 'بانتظار مراجعة العميل');
	assert.equal(c.stages[0].lifecycle.eligibility.approve.allowed, true);
	assert.equal(c.stages[1].lifecycle.eligibility.approve.code, 'STAGE_NOT_STARTED');
	assert.equal(c.canApproveStage, true);
	assert.equal(c.escrowHeld, 20);
	assert.equal(c.progress, 0);
	const p = await progress.getProjectProgress(w.provider.id, w.project.id);
	assert.equal(p.role, 'provider');
	assert.equal(p.canUploadDelivery, false);
	assert.match(p.uploadBlockedReason, /بانتظار مراجعة العميل/);
	// not the owner: the only 403
	await assert.rejects(() => progress.reviewDelivery(w.stranger.id, w.project.id, w.stages[0].id, 'approve'), refused(403, /لا تملك صلاحية/, 'NOT_OWNER'));
	await assert.rejects(() => progress.reviewDelivery(w.provider.id, w.project.id, w.stages[0].id, 'approve'), refused(403, /لا تملك صلاحية/));
	// the owner approves: stage 2 opens, money released for the stage only
	await progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve');
	const after = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(after.stages[0].lifecycle.decided, true);
	assert.equal(after.stages[1].status, 'in_progress');
	assert.equal(after.financial.releasedByStageApprovals, 10);
	assert.equal(after.financial.heldNow, 10);
	assert.equal(after.operationalStatus, 'ACTIVE');
	// approving the same stage again is «already decided» (409), never the generic message
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve'), refused(409, /اعتُمدت هذه المرحلة مسبقًا/, 'STAGE_ALREADY_DECIDED'));
});

test('pg-life: an undelivered stage cannot be approved or sent back — specific 409, nothing changes; the provider cannot deliver a stage that has not started', opts, async () => {
	const { progress } = await services();
	const w = await seed({ stages: [{ status: 'IN_PROGRESS', amount: 10 }, { status: 'PENDING', amount: 10 }] });
	const before = await snapshot(w);
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve'), refused(409, /لم يسلّم مقدم الخدمة/, 'STAGE_NOT_DELIVERED'));
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'revision', 'ملاحظات كافية للتعديل'), refused(409, /لم يسلّم مقدم الخدمة/));
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, w.stages[1].id, 'approve'), refused(409, /لم تبدأ بعد/, 'STAGE_NOT_STARTED'));
	await assert.rejects(() => progress.submitDelivery(w.provider.id, w.project.id, w.stages[1].id, 'تسليم المرحلة الثانية كاملة', ['https://example.com/x']), refused(409, /لم تبدأ بعد/));
	assert.equal(await snapshot(w), before);
	const c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.lifecycle.stages[0].awaitingClientReview, false);
	assert.equal(c.canApproveStage, true, 'the contract itself allows approvals; the stage does not');
});

// ── delivery-completed ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('pg-life: delivery-completed project (with a prior rating) — completed by delivery, fully paid, history readable, nothing operational, the rating untouched', opts, async () => {
	const { progress, clientRequests } = await services();
	const w = await seed({ stages: [{ status: 'SUBMITTED', amount: 10, delivery: 'SUBMITTED' }, { status: 'PENDING', amount: 10 }] });
	await progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve');
	const stage2 = (await w.prisma.projectStage.findMany({ where: { contractId: w.contract.id }, orderBy: { stepOrder: 'asc' } }))[1];
	await progress.submitDelivery(w.provider.id, w.project.id, stage2.id, 'تسليم المرحلة الثانية كاملة', ['https://example.com/final']);
	await progress.reviewDelivery(w.client.id, w.project.id, stage2.id, 'approve');
	await w.prisma.review.create({ data: { projectId: w.project.id, clientId: w.client.id, providerId: w.provider.id, reviewerRole: 'CLIENT', rating: 4, comment: 'تقييم سابق', tags: [] } });
	const reviews = await w.prisma.review.count({ where: { projectId: w.project.id } });

	const c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.operationalStatus, 'COMPLETED_BY_DELIVERY');
	assert.equal(c.closureReason, 'DELIVERY_COMPLETED');
	assert.equal(c.completedByDelivery, true);
	assert.equal(c.closedBySettlement, false);
	assert.equal(c.progress, 100);
	assert.equal(c.financial.fullyPaidToProvider, true);
	assert.equal(c.financial.releasedByStageApprovals, 20);
	assert.equal(c.financial.heldNow, 0);
	assert.equal(c.financial.settlement, null);
	for (const a of ['review', 'approve', 'requestRevision', 'amend'] as const) assert.equal(c.eligibility[a].code, 'CONTRACT_COMPLETED', a);
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, stage2.id, 'approve'), refused(409, /اكتمل المشروع/, 'CONTRACT_COMPLETED'));
	await assert.rejects(() => progress.submitDelivery(w.provider.id, w.project.id, stage2.id, 'تسليم بعد الاكتمال كاملة', ['https://example.com/x']), refused(409, /اكتمل المشروع/));
	const list = await clientRequests.getCompletedProjects(w.client.id);
	const row = list.items.find((i: any) => i.projectId === w.project.id)!;
	assert.equal(row.completedByDelivery, true);
	assert.equal(row.closedBySettlement, false);
	assert.equal(row.releasedAmount, 20);
	assert.equal(row.heldAmount, 0);
	assert.equal(row.hasRated, true);
	assert.equal(await w.prisma.review.count({ where: { projectId: w.project.id } }), reviews, 'the saved rating is untouched');
});

test('pg-life: a naturally completed contract with no stage rows (negotiation project) is still completed by delivery and offers nothing operational', opts, async () => {
	const { progress } = await services();
	const w = await seed({ contractStatus: 'COMPLETED', escrowStatus: 'RELEASED', released: 20, stages: [] });
	const c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.completedByDelivery, true);
	assert.equal(c.closedBySettlement, false);
	assert.equal(c.operationalStatus, 'COMPLETED_BY_DELIVERY');
	assert.equal(c.eligibility.approve.allowed, false);
	assert.equal(c.eligibility.upload.allowed, false);
	assert.equal(c.financial.fullyPaidToProvider, true);
});

// ── closed by settlement ────────────────────────────────────────────────────────────────────────────────────────────────────────
const settleCT = async (w: World, input: any) => { const { disputes } = await services(); const d = await openDispute(w); await disputes.resolveFinancial(d.id, w.admin.id, input); return d; };

test('pg-life: CT-4C2582-like settlement (25$: refund 10, release 15, commission 1.86, net 13.14) — every read model and every guard agrees', opts, async () => {
	const { progress, clientRequests, admin } = await services();
	const w = await seed({ price: 25, stages: [{ status: 'SUBMITTED', amount: 8, delivery: 'SUBMITTED' }, { status: 'PENDING', amount: 8 }, { status: 'PENDING', amount: 9 }] });
	await settleCT(w, { outcome: 'SPLIT', refundToClient: 10, releaseToProvider: 15, expectedHeldAmount: 25, confirm: true });
	const stored = await snapshot(w);
	const escrow = await w.prisma.escrow.findUnique({ where: { projectId: w.project.id } });
	assert.equal(escrow.status, 'RELEASED');
	assert.equal(escrow.releasedAmount, 15);

	for (const viewer of [w.client, w.provider]) {
		const c = await progress.getProjectProgress(viewer.id, w.project.id);
		assert.equal(c.operationalStatus, 'CLOSED_BY_SETTLEMENT');
		assert.equal(c.statusLabel, 'أُغلق بتسوية نزاع');
		assert.equal(c.closedBySettlement, true);
		assert.equal(c.completedByDelivery, false);
		assert.equal(c.progress, 0, 'no fake 100%');
		assert.equal(c.escrowHeld, 0);
		assert.equal(c.escrowReleased, 0, 'the settlement release is not a stage approval');
		assert.equal(c.financial.contractValue, 25);
		assert.match(c.financial.contractValueNote, /وليست مبلغًا ينتظر الإفراج/);
		assert.equal(c.financial.heldNow, 0);
		assert.equal(c.financial.releasedByStageApprovals, 0);
		assert.equal(c.financial.escrowReleasedIsSettlement, true);
		assert.equal(c.financial.fullyPaidToProvider, false);
		assert.deepEqual({ r: c.financial.settlement.refundToClient, g: c.financial.settlement.releaseToProvider, c: c.financial.settlement.platformCommission, n: c.financial.settlement.providerNet }, { r: 10, g: 15, c: 1.86, n: 13.14 });
		for (const s of c.stages) { assert.equal(s.displayStatusLabel, 'أُغلقت بالتسوية'); assert.equal(s.amountHeld, false); assert.equal(s.isWait, false); assert.equal(s.lifecycle.amountState, 'HISTORICAL'); }
		assert.equal(c.stages[0].status, 'submitted', 'the stored status is kept');
		assert.equal(c.canApproveStage, false);
		assert.match(c.approvalBlockedReason, /تسوية نزاع/);
		assert.equal(c.canUploadDelivery, false);
		for (const a of ['review', 'approve', 'requestRevision', 'amend', 'upload', 'submit'] as const) assert.equal(c.eligibility[a].allowed, false, a);
	}
	// guards: specific 409, never the generic 403 that mixes «contract ended» and «not the owner»
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve'), refused(409, /تسوية نزاع/, 'CLOSED_BY_SETTLEMENT'));
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'revision', 'ملاحظات كافية للتعديل'), refused(409, /تسوية نزاع/));
	await assert.rejects(() => progress.submitDelivery(w.provider.id, w.project.id, w.stages[0].id, 'تسليم بعد التسوية كاملة', ['https://example.com/x']), refused(409, /تسوية نزاع/));
	await assert.rejects(() => progress.uploadDeliveryFiles(w.provider.id, w.project.id, w.stages[0].id, [{ originalname: 'a.png', mimetype: 'image/png', size: 1, buffer: Buffer.alloc(1) }] as any), refused(409, /تسوية نزاع/));
	await assert.rejects(() => progress.reviewDelivery(w.stranger.id, w.project.id, w.stages[0].id, 'approve'), refused(403, /لا تملك صلاحية/, 'NOT_OWNER'));
	// archive + active tracking + admin
	const list = await clientRequests.getCompletedProjects(w.client.id);
	const row = list.items.find((i: any) => i.projectId === w.project.id)!;
	assert.equal(row.closedBySettlement, true);
	assert.equal(row.completedByDelivery, false);
	assert.equal(row.statusLabel, 'أُغلق بتسوية نزاع');
	assert.equal(row.totalPrice, 25);
	assert.equal(row.heldAmount, 0);
	assert.equal(row.releasedAmount, 0);
	assert.equal(row.financial.settlement.releaseToProvider, 15);
	assert.equal(row.canRate, false);
	const tracking = await clientRequests.getActiveProjectTracking(w.client.id, w.project.id);
	assert.equal(tracking.project.closedBySettlement, true);
	assert.equal(tracking.project.heldAmount, 0);
	assert.equal(tracking.project.progress, 0);
	assert.equal(tracking.project.completedMilestones, 0);
	const adm = await admin.getProject(w.project.id);
	assert.equal(adm.lifecycle.closedBySettlement, true);
	assert.equal(adm.financial.settlement.providerNet, 13.14);
	const admList = await admin.listProjects({} as any, 1, 100);
	assert.equal(admList.items.find((i: any) => i.id === w.project.id)!.lifecycle!.closedBySettlement, true);
	// nothing stored was changed by reading or by the refused attempts
	assert.equal(await snapshot(w), stored);
});

test('pg-life: refund-only settlement — closed by settlement, nothing held or released, contract CANCELLED is not shown as «ملغى»', opts, async () => {
	const { progress } = await services();
	const w = await seed({ stages: [{ status: 'IN_PROGRESS', amount: 10 }, { status: 'PENDING', amount: 10 }] });
	await settleCT(w, { outcome: 'REFUND_CLIENT', refundToClient: 20, releaseToProvider: 0, expectedHeldAmount: 20, confirm: true });
	const c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.contractStatus, 'CANCELLED');
	assert.equal(c.operationalStatus, 'CLOSED_BY_SETTLEMENT');
	assert.equal(c.statusLabel, 'أُغلق بتسوية نزاع');
	assert.equal(c.financial.heldNow, 0);
	assert.equal(c.financial.releasedByStageApprovals, 0);
	assert.equal(c.financial.settlement.refundToClient, 20);
	assert.equal(c.financial.settlement.releaseToProvider, 0);
	assert.equal(c.financial.escrowReleasedIsSettlement, false);
	await assert.rejects(() => progress.submitDelivery(w.provider.id, w.project.id, w.stages[0].id, 'تسليم بعد الاسترداد كاملة', ['https://example.com/x']), refused(409, /تسوية نزاع/));
});

test('pg-life: a settlement keeps stages approved BEFORE it approved and counts only those as «released through stage approvals»', opts, async () => {
	const { progress } = await services();
	const w = await seed({ stages: [{ status: 'SUBMITTED', amount: 10, delivery: 'SUBMITTED' }, { status: 'PENDING', amount: 10 }] });
	await progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve');
	await settleCT(w, { outcome: 'SPLIT', refundToClient: 5, releaseToProvider: 5, expectedHeldAmount: 10, confirm: true });
	const c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.closedBySettlement, true);
	assert.equal(c.stages[0].lifecycle.displayStatusLabel, 'مكتملة ومعتمدة');
	assert.equal(c.stages[1].lifecycle.displayStatusLabel, 'أُغلقت بالتسوية');
	assert.equal(c.financial.releasedByStageApprovals, 10);
	assert.equal(c.financial.settlement.releaseToProvider, 5);
	assert.equal(c.progress, 50);
});

// ── disputes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('pg-life: open dispute — freeze reason (423) on approval, revision request and delivery still allowed, not confused with an ended contract', opts, async () => {
	const { progress } = await services();
	const w = await seed({ stages: [{ status: 'SUBMITTED', amount: 10, delivery: 'SUBMITTED' }, { status: 'PENDING', amount: 10 }] });
	await openDispute(w);
	const c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.hasActiveDispute, true);
	assert.equal(c.operationalStatus, 'ACTIVE');
	assert.equal(c.canApproveStage, false);
	assert.match(c.approvalBlockedReason, /نزاع مفتوح/);
	assert.equal(c.stages[0].lifecycle.eligibility.approve.httpStatus, 423);
	assert.equal(c.stages[0].lifecycle.eligibility.requestRevision.allowed, true);
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve'), refused(423, /نزاع مفتوح/, 'PROJECT_FROZEN_BY_DISPUTE'));
	await progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'revision', 'يرجى التعديل كما في الملاحظات');
	const p = await progress.getProjectProgress(w.provider.id, w.project.id);
	assert.equal(p.canUploadDelivery, true, 'delivery stays allowed during a dispute');
	await progress.submitDelivery(w.provider.id, w.project.id, w.stages[0].id, 'تسليم معدل بعد الملاحظات', ['https://example.com/rev']);
	assert.equal((await w.prisma.projectStage.findUnique({ where: { id: w.stages[0].id } })).status, 'SUBMITTED');
});

test('pg-life: a TEXT closure does not complete the project — eligibility returns per the real contract and stages; the freeze stays while another dispute is active', opts, async () => {
	const { progress, disputes } = await services();
	const w = await seed({ stages: [{ status: 'SUBMITTED', amount: 10, delivery: 'SUBMITTED' }, { status: 'PENDING', amount: 10 }] });
	const d1 = await openDispute(w, 'client');
	const d2 = await openDispute(w, 'provider');
	assert.equal((await progress.getProjectProgress(w.client.id, w.project.id)).activeDisputeCount, 2);
	await disputes.resolve(d1.id, w.admin.id, { action: 'resolve', resolution: 'NO_FINANCIAL_CHANGE' } as any);
	let c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.hasActiveDispute, true, 'another active dispute keeps the freeze');
	assert.equal(c.activeDisputeCount, 1);
	await assert.rejects(() => progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve'), refused(423));
	await disputes.resolve(d2.id, w.admin.id, { action: 'resolve', resolution: 'NO_FINANCIAL_CHANGE' } as any);
	c = await progress.getProjectProgress(w.client.id, w.project.id);
	assert.equal(c.hasActiveDispute, false);
	assert.equal(c.closedBySettlement, false, 'a text closure is not a settlement');
	assert.equal(c.completedByDelivery, false, 'a text closure does not complete the project');
	assert.equal(c.operationalStatus, 'ACTIVE');
	assert.equal(c.canApproveStage, true);
	assert.equal(c.stages[0].lifecycle.eligibility.approve.allowed, true);
	await progress.reviewDelivery(w.client.id, w.project.id, w.stages[0].id, 'approve');
	assert.equal((await w.prisma.projectStage.findUnique({ where: { id: w.stages[0].id } })).status, 'APPROVED');
	assert.equal((await w.prisma.contract.findUnique({ where: { id: w.contract.id } })).status, 'ACTIVE');
});
