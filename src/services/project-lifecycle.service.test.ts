import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLifecycle, evaluateAction, summarizeLifecycle, type LifecycleInput, type LifecycleStageInput } from './project-lifecycle.service';

// computeLifecycle is PURE: every state of a project is checked here with synthetic rows (no database, no mocks).

const d = (status: string) => ({ status });
const stage = (id: string, stepOrder: number, status: string, deliveries: Array<{ status: string }> = [], amount = 10): LifecycleStageInput => ({ id, stepOrder, status, amount, deliveries, approvedAt: status === 'APPROVED' ? new Date('2026-10-01T10:00:00Z') : null });
const NOT_SETTLED = { settled: false } as const;
const SETTLED = { settled: true, disputeId: 'dsp-1', outcome: 'SPLIT', outcomeLabel: 'تقسيم', settledAt: new Date('2026-10-10T10:00:00Z') } as const;
const base = (over: Partial<LifecycleInput> = {}): LifecycleInput => ({
	viewer: { role: 'client', isOwner: true }, contractStatus: 'ACTIVE', contractPrice: 20,
	escrow: { status: 'HELD', amount: 20, releasedAmount: 0 },
	stages: [stage('s1', 1, 'SUBMITTED', [d('SUBMITTED')]), stage('s2', 2, 'PENDING')],
	activeDisputes: { count: 0, latestId: null }, settlement: NOT_SETTLED, ...over
});
const as = (role: 'client' | 'provider' | 'admin', over: Partial<LifecycleInput> = {}) => base({ ...over, viewer: { role, isOwner: role !== 'admin' } });

test('normal ACTIVE project, stage delivered: «بانتظار مراجعة العميل», the client may review / approve / request revision, the provider may not upload on it', () => {
	const c = computeLifecycle(base());
	assert.equal(c.operationalStatus, 'ACTIVE');
	assert.equal(c.completedByDelivery, false);
	assert.equal(c.closedBySettlement, false);
	assert.equal(c.stages[0].displayStatusLabel, 'بانتظار مراجعة العميل');
	assert.equal(c.stages[0].awaitingClientReview, true);
	for (const a of ['review', 'approve', 'requestRevision'] as const) assert.equal(c.stages[0].eligibility[a].allowed, true, a);
	assert.equal(c.stages[0].amountState, 'HELD');
	assert.equal(c.financial.heldNow, 20);
	// later stage follows the real order: not started, nothing to review
	assert.equal(c.stages[1].displayStatusLabel, 'لم تبدأ بعد');
	assert.equal(c.stages[1].eligibility.approve.code, 'STAGE_NOT_STARTED');
	const p = computeLifecycle(as('provider'));
	assert.equal(p.stages[0].eligibility.upload.code, 'STAGE_AWAITING_REVIEW');
	assert.equal(p.stages[0].eligibility.approve.code, 'WRONG_ROLE');
	assert.equal(p.stages[0].eligibility.approve.httpStatus, 403);
});

test('undelivered stage is never a delivery ready for review: no approval, specific reason; the provider may deliver', () => {
	const stages = [stage('s1', 1, 'IN_PROGRESS'), stage('s2', 2, 'PENDING')];
	const c = computeLifecycle(base({ stages }));
	assert.equal(c.stages[0].awaitingClientReview, false);
	for (const a of ['review', 'approve', 'requestRevision'] as const) { assert.equal(c.stages[0].eligibility[a].allowed, false); assert.equal(c.stages[0].eligibility[a].code, 'STAGE_NOT_DELIVERED'); assert.equal(c.stages[0].eligibility[a].httpStatus, 409); }
	assert.match(c.stages[0].eligibility.approve.reason!, /لم يسلّم مقدم الخدمة/);
	const p = computeLifecycle(as('provider', { stages }));
	assert.equal(p.stages[0].eligibility.upload.allowed, true);
	assert.equal(p.stages[0].eligibility.submit.allowed, true);
	assert.equal(p.stages[1].eligibility.upload.code, 'STAGE_NOT_STARTED');
	// a stage whose latest delivery was sent back for revision is not awaiting review either
	const rev = computeLifecycle(base({ stages: [stage('s1', 1, 'REVISION_REQUESTED', [d('REVISION_REQUESTED')])] }));
	assert.equal(rev.stages[0].eligibility.approve.code, 'STAGE_NOT_DELIVERED');
});

test('an already approved stage shows its decision and date and offers no new decision', () => {
	const c = computeLifecycle(base({ stages: [stage('s1', 1, 'APPROVED', [d('APPROVED')]), stage('s2', 2, 'SUBMITTED', [d('SUBMITTED')])], escrow: { status: 'HELD', amount: 20, releasedAmount: 10 } }));
	assert.equal(c.stages[0].decided, true);
	assert.equal(c.stages[0].decision?.status, 'APPROVED');
	assert.ok(c.stages[0].decision?.decidedAt);
	assert.equal(c.stages[0].eligibility.approve.code, 'STAGE_ALREADY_DECIDED');
	assert.equal(c.stages[0].amountState, 'RELEASED');
	assert.equal(c.stages[1].eligibility.approve.allowed, true);
	assert.equal(c.financial.releasedByStageApprovals, 10);
	assert.equal(c.financial.heldNow, 10);
	assert.equal(c.focalStageId, 's2');
});

test('delivery-completed project: COMPLETED + all approved, nothing operational is offered, money is fully paid through stage approvals', () => {
	const c = computeLifecycle(base({ contractStatus: 'COMPLETED', escrow: { status: 'RELEASED', amount: 20, releasedAmount: 20, platformCommissionAmount: 2.55, providerNetReleasedAmount: 17.45 }, stages: [stage('s1', 1, 'APPROVED', [d('APPROVED')]), stage('s2', 2, 'APPROVED', [d('APPROVED')])] }));
	assert.equal(c.operationalStatus, 'COMPLETED_BY_DELIVERY');
	assert.equal(c.closureReason, 'DELIVERY_COMPLETED');
	assert.equal(c.completedByDelivery, true);
	assert.equal(c.allStagesApproved, true);
	assert.equal(c.closedBySettlement, false);
	assert.equal(c.financial.fullyPaidToProvider, true);
	assert.equal(c.financial.escrowReleasedIsSettlement, false);
	assert.equal(c.financial.heldNow, 0);
	assert.equal(c.financial.releasedByStageApprovals, 20);
	assert.equal(c.financial.settlement, null);
	assert.equal(c.financial.contractValueNote, null);
	for (const a of ['review', 'approve', 'requestRevision', 'amend'] as const) assert.equal(c.eligibility[a].code, 'CONTRACT_COMPLETED', a);
	assert.equal(as('provider', { contractStatus: 'COMPLETED', stages: [stage('s1', 1, 'APPROVED', [d('APPROVED')])] }).viewer.role, 'provider');
});

test('CT-4C2582 (settled, split): closed by settlement, no fake progress, nothing held, stages «أُغلقت بالتسوية», figures from the settlement, escrow RELEASED is NOT «all paid»', () => {
	const input = base({
		contractStatus: 'COMPLETED', contractPrice: 25, settlement: SETTLED,
		escrow: { status: 'RELEASED', amount: 25, releasedAmount: 15, platformCommissionAmount: 1.86, providerNetReleasedAmount: 13.14 },
		stages: [stage('s1', 1, 'SUBMITTED', [d('SUBMITTED')], 8), stage('s2', 2, 'PENDING', [], 8), stage('s3', 3, 'PENDING', [], 9)],
		settlementDistribution: { refundToClient: 10, releaseToProvider: 15, platformCommission: 1.86, providerNet: 13.14 }
	});
	const c = computeLifecycle(input);
	assert.equal(c.operationalStatus, 'CLOSED_BY_SETTLEMENT');
	assert.equal(c.operationalLabel, 'أُغلق بتسوية نزاع');
	assert.equal(c.closureReason, 'DISPUTE_SETTLEMENT');
	assert.equal(c.closedBySettlement, true);
	assert.equal(c.completedByDelivery, false);
	assert.equal(c.approvedStagesCount, 0);
	assert.equal(c.allStagesApproved, false);
	// stages keep their stored status but read «أُغلقت بالتسوية»; the delivery is not "waiting for the client"
	for (const s of c.stages) { assert.equal(s.displayStatusLabel, 'أُغلقت بالتسوية'); assert.equal(s.closedBySettlement, true); assert.equal(s.amountState, 'HISTORICAL'); assert.match(s.amountLabel!, /ليست مبلغًا ينتظر الإفراج/); assert.equal(s.awaitingClientReview, false); }
	assert.equal(c.stages[0].storedStatus, 'SUBMITTED');
	assert.equal(c.stages[0].decided, false);
	// no approve / revise / amend / upload for either party
	for (const a of ['review', 'approve', 'requestRevision', 'amend'] as const) { assert.equal(c.eligibility[a].code, 'CLOSED_BY_SETTLEMENT', a); assert.equal(c.eligibility[a].httpStatus, 409); assert.equal(c.stages[0].eligibility[a].allowed, false); }
	assert.match(c.stages[0].eligibility.approve.reason!, /تسوية نزاع/);
	const p = computeLifecycle({ ...input, viewer: { role: 'provider', isOwner: true } });
	assert.equal(p.stages[0].eligibility.upload.code, 'CLOSED_BY_SETTLEMENT');
	assert.equal(p.stages[0].eligibility.submit.allowed, false);
	// money
	assert.equal(c.financial.contractValue, 25);
	assert.match(c.financial.contractValueNote!, /وليست مبلغًا ينتظر الإفراج/);
	assert.equal(c.financial.heldNow, 0);
	assert.equal(c.financial.releasedByStageApprovals, 0, 'the settlement release is not a stage approval');
	assert.deepEqual({ ...c.financial.settlement!, disputeId: undefined, settledAt: undefined, outcome: undefined }, { disputeId: undefined, settledAt: undefined, outcome: undefined, refundToClient: 10, releaseToProvider: 15, platformCommission: 1.86, providerNet: 13.14 });
	assert.equal(c.financial.escrowReleasedIsSettlement, true);
	assert.equal(c.financial.fullyPaidToProvider, false);
	assert.equal(c.hasActiveDispute, false);
});

test('settled with refund only (contract CANCELLED, escrow REFUNDED): closed by settlement, not «cancelled», nothing held, nothing released', () => {
	const c = computeLifecycle(base({ contractStatus: 'CANCELLED', settlement: { ...SETTLED, outcome: 'REFUND_CLIENT' }, escrow: { status: 'REFUNDED', amount: 20, releasedAmount: 0 }, settlementDistribution: { refundToClient: 20, releaseToProvider: 0, platformCommission: 0, providerNet: 0 } }));
	assert.equal(c.operationalStatus, 'CLOSED_BY_SETTLEMENT');
	assert.equal(c.closureReason, 'DISPUTE_SETTLEMENT');
	assert.equal(c.financial.heldNow, 0);
	assert.equal(c.financial.releasedByStageApprovals, 0);
	assert.equal(c.financial.settlement!.refundToClient, 20);
	assert.equal(c.financial.escrowReleasedIsSettlement, false);
	assert.equal(c.eligibility.approve.code, 'CLOSED_BY_SETTLEMENT');
});

test('a settled project that had earlier approved stages keeps them approved; only the stage approvals count as «released through stage approvals»', () => {
	const c = computeLifecycle(base({ contractStatus: 'COMPLETED', settlement: SETTLED, contractPrice: 20, escrow: { status: 'RELEASED', amount: 20, releasedAmount: 15 }, stages: [stage('s1', 1, 'APPROVED', [d('APPROVED')], 10), stage('s2', 2, 'SUBMITTED', [d('SUBMITTED')], 10)], settlementDistribution: { refundToClient: 5, releaseToProvider: 5, platformCommission: 0.6, providerNet: 4.4 } }));
	assert.equal(c.stages[0].displayStatusLabel, 'مكتملة ومعتمدة');
	assert.equal(c.stages[0].amountState, 'RELEASED');
	assert.equal(c.stages[1].displayStatusLabel, 'أُغلقت بالتسوية');
	assert.equal(c.financial.releasedByStageApprovals, 10);
	assert.equal(c.financial.settlement!.releaseToProvider, 5);
	assert.equal(c.approvedStagesCount, 1);
});

test('open dispute: freeze reason shown, approval 423, but revision request and delivery stay possible', () => {
	const c = computeLifecycle(base({ activeDisputes: { count: 1, latestId: 'dsp-9' } }));
	assert.equal(c.hasActiveDispute, true);
	assert.equal(c.activeDisputeId, 'dsp-9');
	assert.match(c.activeDisputeReason!, /نزاع مفتوح/);
	assert.equal(c.eligibility.approve.code, 'ACTIVE_DISPUTE_FREEZE');
	assert.equal(c.eligibility.approve.httpStatus, 423);
	assert.match(c.eligibility.approve.reason!, /نزاع مفتوح/);
	assert.equal(c.eligibility.requestRevision.allowed, true);
	assert.equal(c.eligibility.amend.code, 'ACTIVE_DISPUTE_FREEZE');
	assert.equal(c.operationalStatus, 'ACTIVE', 'a dispute is not an ended contract');
	const p = computeLifecycle(as('provider', { stages: [stage('s1', 1, 'IN_PROGRESS')], activeDisputes: { count: 1, latestId: 'dsp-9' } }));
	assert.equal(p.stages[0].eligibility.upload.allowed, true, 'delivery is allowed during a dispute');
	// the freeze reason is never confused with "contract ended" / "not the owner"
	assert.notEqual(c.eligibility.approve.code, 'NOT_OWNER');
	assert.notEqual(c.eligibility.approve.code, 'CONTRACT_ENDED');
});

test('two active disputes: still frozen when one is closed (count 1), lifted only at 0', () => {
	assert.equal(computeLifecycle(base({ activeDisputes: { count: 2, latestId: 'b' } })).activeDisputeCount, 2);
	assert.equal(computeLifecycle(base({ activeDisputes: { count: 1, latestId: 'a' } })).eligibility.approve.code, 'ACTIVE_DISPUTE_FREEZE');
	assert.equal(computeLifecycle(base({ activeDisputes: { count: 0, latestId: null } })).eligibility.approve.allowed, true);
});

test('text-closed dispute: no settlement, no active dispute: eligibility returns per the real contract and stage state, the project is NOT complete', () => {
	const c = computeLifecycle(base({ activeDisputes: { count: 0, latestId: null }, settlement: NOT_SETTLED }));
	assert.equal(c.operationalStatus, 'ACTIVE');
	assert.equal(c.completedByDelivery, false);
	assert.equal(c.closedBySettlement, false);
	assert.equal(c.eligibility.approve.allowed, true);
	assert.equal(c.stages[0].eligibility.approve.allowed, true);
});

test('the only 403 is non-ownership; an ended contract, a settlement or a stage state are 409 with their own reason', () => {
	const stranger = computeLifecycle(base({ viewer: { role: 'client', isOwner: false } }));
	assert.equal(stranger.eligibility.approve.httpStatus, 403);
	assert.equal(stranger.eligibility.approve.code, 'NOT_OWNER');
	assert.match(stranger.eligibility.approve.reason!, /لا تملك صلاحية/);
	const ended = computeLifecycle(base({ contractStatus: 'COMPLETED' }));
	assert.equal(ended.eligibility.approve.httpStatus, 409);
	assert.doesNotMatch(ended.eligibility.approve.reason!, /لا تملك صلاحية/);
	assert.equal(computeLifecycle(base({ contractStatus: 'CANCELLED' })).eligibility.approve.code, 'CONTRACT_CANCELLED');
	assert.equal(computeLifecycle(base({ contractStatus: 'PENDING_PAYMENT' })).eligibility.approve.code, 'CONTRACT_NOT_STARTED');
	// admin is a viewer, never an operator
	const admin = computeLifecycle(as('admin'));
	assert.equal(admin.eligibility.approve.httpStatus, 403);
	for (const a of ['upload', 'submit', 'review', 'approve', 'requestRevision'] as const) assert.equal(admin.eligibility[a].allowed, false);
});

test('project without a contract yet / without stages: explicit reasons, nothing allowed', () => {
	const none = computeLifecycle(base({ contractStatus: null, stages: [], escrow: null }));
	assert.equal(none.operationalStatus, 'NOT_STARTED');
	assert.equal(none.eligibility.approve.code, 'CONTRACT_NOT_STARTED');
	const noStages = computeLifecycle(as('provider', { stages: [] }));
	assert.equal(noStages.eligibility.upload.code, 'NO_STAGES');
});

test('list summary uses the same rules (settled beats COMPLETED, a dispute is orthogonal)', () => {
	assert.equal(summarizeLifecycle('COMPLETED', true, 0).operationalStatus, 'CLOSED_BY_SETTLEMENT');
	assert.equal(summarizeLifecycle('COMPLETED', false, 0).completedByDelivery, true);
	assert.equal(summarizeLifecycle('ACTIVE', false, 2).hasActiveDispute, true);
	assert.equal(summarizeLifecycle('CANCELLED', true, 0).completedByDelivery, false);
});

test('evaluateAction on a lone stage matches the project computation (the guard and the read model cannot drift)', () => {
	const input = base();
	const c = computeLifecycle(input);
	for (const a of ['upload', 'submit', 'review', 'approve', 'requestRevision', 'amend'] as const) assert.deepEqual(evaluateAction(input, a, input.stages[0]), c.stages[0].eligibility[a]);
});
