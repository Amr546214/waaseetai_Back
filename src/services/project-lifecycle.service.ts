import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { adminAudit } from './admin-audit.service';
import { ACTIVE_DISPUTE_STATUSES, PROJECT_FROZEN_CODE, PROJECT_FROZEN_MESSAGE, countActiveDisputes, getActiveDisputeForProject } from './dispute-freeze.service';
import { AdminSettlement, SETTLED_DISPUTE_WHERE, SETTLED_LABEL_AR, SETTLED_STAGE_LABEL_AR, STAGE_CLOSED_BY_SETTLEMENT, STAGE_STATUSES_CLOSED_BY_SETTLEMENT, adminSettlementFor } from './settlement-state.service';

/**
 * ONE source of truth for the lifecycle state of a project / contract / stage / delivery and for the eligibility of every action.
 *
 * Everything here is DERIVED from rows that already exist (contract, project, escrow, stages, deliveries, disputes and the settlement's audit row): no state is stored,
 * no row is rewritten, no migration. `computeLifecycle` is a PURE function (unit-testable, no I/O); `loadLifecycle*` only gather its inputs. Every read model
 * (client workspace, provider progress, lists, admin) and every guard (review / submit delivery) calls this module instead of re-deriving the state.
 *
 * Reasons are Arabic and specific. They distinguish: contract ended / closed, closed by settlement, active dispute freeze, stage not delivered,
 * stage already decided, stage not started, awaiting the other party, and "not the owner" (the only 403).
 */

export type LifecycleRole = 'client' | 'provider' | 'admin' | 'none';
export type OperationalStatus = 'NOT_STARTED' | 'PENDING_START' | 'ACTIVE' | 'COMPLETED_BY_DELIVERY' | 'CLOSED_BY_SETTLEMENT' | 'CANCELLED' | 'ENDED';
export type ClosureReason = 'DELIVERY_COMPLETED' | 'DISPUTE_SETTLEMENT' | 'CANCELLED' | null;
export type ActionName = 'upload' | 'submit' | 'review' | 'approve' | 'requestRevision' | 'amend';
export const ACTION_NAMES: ActionName[] = ['upload', 'submit', 'review', 'approve', 'requestRevision', 'amend'];

export interface Eligibility {
  allowed: boolean;
  /** Arabic, specific; null only when allowed. */
  reason: string | null;
  /** Machine code for the UI / tests; null when allowed. */
  code: BlockCode | null;
  /** The HTTP status the matching endpoint answers with when the action is attempted anyway; null when allowed. */
  httpStatus: 403 | 409 | 423 | null;
}
export type BlockCode =
  | 'NOT_OWNER' | 'WRONG_ROLE' | 'CLOSED_BY_SETTLEMENT' | 'CONTRACT_COMPLETED' | 'CONTRACT_CANCELLED' | 'CONTRACT_NOT_STARTED' | 'CONTRACT_ENDED'
  | 'ACTIVE_DISPUTE_FREEZE' | 'STAGE_NOT_STARTED' | 'STAGE_NOT_DELIVERED' | 'STAGE_ALREADY_DECIDED' | 'STAGE_AWAITING_REVIEW' | 'STAGE_NOT_OPEN' | 'NO_STAGES' | 'NO_STAGE_AVAILABLE';

export type Eligibilities = Record<ActionName, Eligibility>;

export interface LifecycleStageInput {
  id: string;
  stepOrder: number;
  status: string;
  amount: number;
  approvedAt?: Date | string | null;
  deliveries: Array<{ id?: string; status: string; submittedAt?: Date | string | null; reviewedAt?: Date | string | null; reviewNote?: string | null }>;
}
export interface SettlementDistribution { outcome?: string; refundToClient: number; releaseToProvider: number; platformCommission: number; providerNet: number }
export interface LifecycleEscrowInput { status: string; amount: number; releasedAmount?: number | null; platformCommissionAmount?: number | null; providerNetReleasedAmount?: number | null }

export interface LifecycleInput {
  viewer: { role: LifecycleRole; isOwner: boolean };
  contractStatus: string | null;
  contractPrice: number | null;
  escrow: LifecycleEscrowInput | null;
  stages: LifecycleStageInput[];
  activeDisputes: { count: number; latestId: string | null; latestStatus?: string | null };
  settlement: AdminSettlement;
  settlementDistribution?: SettlementDistribution | null;
}

// ---------------------------------------------------------------------------------------------------------- wording
export const NOT_OWNER_AR = 'لا تملك صلاحية على هذا المشروع';
/** The only 403 wording: the caller is not a party of this contract. */
export const notOwnerReason = (action: ActionName): string =>
  action === 'upload' || action === 'submit' ? 'لا تملك صلاحية التسليم على هذا المشروع'
  : action === 'review' || action === 'approve' || action === 'requestRevision' ? 'لا تملك صلاحية المراجعة على هذا المشروع' : NOT_OWNER_AR;
export const SETTLED_ACTION_AR = 'أُغلق المشروع بتسوية نزاع، ولم يعد هذا الإجراء متاحًا';
export const SETTLED_REVIEW_AR = 'انتهت مراجعة هذه المرحلة لأن المشروع أُغلق بتسوية نزاع. التسليم متاح للاطلاع فقط';
export const SETTLED_DELIVERY_AR = 'أُغلق المشروع بتسوية نزاع، ولا يقبل تسليمات جديدة';
export const CONTRACT_COMPLETED_AR = 'اكتمل المشروع باعتماد جميع المراحل، ولم يعد هذا الإجراء متاحًا';
export const CONTRACT_CANCELLED_AR = 'العقد ملغى، ولم يعد هذا الإجراء متاحًا';
export const CONTRACT_ENDED_AR = 'العقد منتهٍ، ولم يعد هذا الإجراء متاحًا';
export const STAGE_NOT_DELIVERED_AR = 'لم يسلّم مقدم الخدمة هذه المرحلة بعد، ولا يوجد تسليم لمراجعته';
export const STAGE_NOT_STARTED_AR = 'المرحلة لم تبدأ بعد، وتُفتح بعد اعتماد المرحلة السابقة';
export const STAGE_ALREADY_DECIDED_AR = 'اعتُمدت هذه المرحلة مسبقًا ولا تحتاج قرارًا جديدًا';
export const STAGE_ALREADY_DECIDED_DELIVERY_AR = 'اعتُمدت هذه المرحلة مسبقًا ولا تحتاج تسليمًا';
export const STAGE_AWAITING_REVIEW_AR = 'التسليم الحالي بانتظار مراجعة العميل';
export const STAGE_NOT_OPEN_AR = 'هذه المرحلة غير متاحة حاليًا';
export const NO_STAGES_AR = 'لم تُجهَّز مراحل المشروع بعد';
export const NO_STAGE_AVAILABLE_AR = 'لا توجد مرحلة متاحة لهذا الإجراء حاليًا';
export const AMEND_FROZEN_AR = 'لا يمكن تعديل العقد أثناء وجود نزاع مفتوح على المشروع';
const WRONG_ROLE_AR: Record<ActionName, string> = {
  upload: 'رفع التسليم من صلاحية مقدم الخدمة فقط', submit: 'إرسال التسليم من صلاحية مقدم الخدمة فقط',
  review: 'مراجعة التسليم من صلاحية العميل صاحب المشروع فقط', approve: 'اعتماد المرحلة من صلاحية العميل صاحب المشروع فقط',
  requestRevision: 'طلب التعديل من صلاحية العميل صاحب المشروع فقط', amend: 'طلب التعديل على العقد من صلاحية أطراف العقد فقط'
};
const CONTRACT_NOT_STARTED_AR: Record<string, string> = {
  PENDING_CLIENT_SIGNATURE: 'العقد بانتظار توقيع العميل، ولا يمكن تنفيذ هذا الإجراء قبل بدء العقد',
  PENDING_PROVIDER_SIGNATURE: 'العقد بانتظار توقيع مقدم الخدمة، ولا يمكن تنفيذ هذا الإجراء قبل بدء العقد',
  PENDING_PAYMENT: 'بانتظار إيداع العميل للضمان، ولا يمكن تنفيذ هذا الإجراء قبل تمويله'
};
/** The same reasons worded for the party whose signature is the missing one ("your signature"). */
const notStartedReason = (status: string, role: LifecycleRole): string =>
  status === 'PENDING_PROVIDER_SIGNATURE' && role === 'provider' ? 'العقد بانتظار توقيعك، ولا يمكن تنفيذ هذا الإجراء قبل بدء العقد'
  : status === 'PENDING_CLIENT_SIGNATURE' && role === 'client' ? 'العقد بانتظار توقيعك، ولا يمكن تنفيذ هذا الإجراء قبل بدء العقد'
  : CONTRACT_NOT_STARTED_AR[status];
export const CONTRACT_VALUE_HISTORICAL_AR = 'قيمة العقد التعاقدية قبل التسوية، وليست مبلغًا ينتظر الإفراج';
export const STAGE_AMOUNT_HISTORICAL_AR = 'قيمة المرحلة التعاقدية سابقًا، وليست مبلغًا ينتظر الإفراج';

const STAGE_LABEL_AR: Record<string, string> = { PENDING: 'لم تبدأ بعد', IN_PROGRESS: 'قيد التنفيذ', SUBMITTED: 'بانتظار مراجعة العميل', REVISION_REQUESTED: 'مطلوب تعديل', APPROVED: 'مكتملة ومعتمدة' };

const OK: Eligibility = { allowed: true, reason: null, code: null, httpStatus: null };
const no = (code: BlockCode, reason: string, httpStatus: 403 | 409 | 423 = 409): Eligibility => ({ allowed: false, reason, code, httpStatus });
const allBlocked = (e: Eligibility): Eligibilities => ({ upload: e, submit: e, review: e, approve: e, requestRevision: e, amend: e });
const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ------------------------------------------------------------------------------------------------------------ output
export interface StageLifecycle {
  stageId: string;
  stepOrder: number;
  storedStatus: string;
  /** What people see: the stored status worded for this moment (closed by settlement for an unreleased stage of a settled project). */
  displayStatus: string;
  displayStatusLabel: string;
  closedBySettlement: boolean;
  /** A delivery exists and is waiting for the client's decision. Never true for an undelivered stage. */
  awaitingClientReview: boolean;
  hasDelivery: boolean;
  /** Already decided: the stage was approved (decision + date), so no new decision is offered. */
  decided: boolean;
  decision: { status: 'APPROVED'; decidedAt: Date | string | null } | null;
  amount: number;
  /** RELEASED = approved and paid; HELD = still in a funded escrow; HISTORICAL = contractual value of a stage a settlement closed (not an amount awaiting release); NONE = nothing is held. */
  amountState: 'RELEASED' | 'HELD' | 'HISTORICAL' | 'NONE';
  amountLabel: string | null;
  eligibility: Eligibilities;
}

export interface FinancialSummary {
  currency: 'USD';
  contractValue: number;
  /** Shown next to the contract value when a settlement closed the project: the value is historical, not money awaiting release. */
  contractValueNote: string | null;
  escrowStatus: string | null;
  /** Money still sitting in the escrow. 0 once the escrow was settled / refunded / released. */
  heldNow: number;
  /** Gross money released through stage approvals ONLY (never the settlement total). */
  releasedByStageApprovals: number;
  platformCommissionTotal: number | null;
  providerNetReleasedTotal: number | null;
  /** The admin's financial decision, from its audit row. Present only for a project closed by settlement. */
  settlement: { disputeId: string; outcome: string; settledAt: Date | string | null; refundToClient: number; releaseToProvider: number; platformCommission: number; providerNet: number } | null;
  /** True when the escrow status RELEASED is the result of a settlement: it must NOT be read as "everything was paid to the provider". */
  escrowReleasedIsSettlement: boolean;
  /** True only when the whole contract value was paid through approved stages (delivery-completed). */
  fullyPaidToProvider: boolean;
}

export interface ProjectLifecycle {
  operationalStatus: OperationalStatus;
  /** Arabic label of the state, for headers / lists. */
  operationalLabel: string;
  closureReason: ClosureReason;
  closureLabel: string | null;
  completedByDelivery: boolean;
  closedBySettlement: boolean;
  hasActiveDispute: boolean;
  activeDisputeCount: number;
  activeDisputeId: string | null;
  activeDisputeReason: string | null;
  /** The contract's stored status, unchanged. */
  contractStatus: string | null;
  allStagesApproved: boolean;
  approvedStagesCount: number;
  stagesCount: number;
  /** The stage the project-level eligibility refers to (the one currently open / awaiting review / last). */
  focalStageId: string | null;
  eligibility: Eligibilities;
  stages: StageLifecycle[];
  financial: FinancialSummary;
}

const stageHasPendingDelivery = (s: LifecycleStageInput): boolean => s.status === 'SUBMITTED' && s.deliveries[s.deliveries.length - 1]?.status === 'SUBMITTED';

/** Contract-level reason (identical for every stage), or null when the contract state allows operating. */
function contractBlock(input: LifecycleInput, action: ActionName): Eligibility | null {
  const { viewer, contractStatus, settlement } = input;
  if (!viewer.isOwner) return no('NOT_OWNER', notOwnerReason(action), 403);
  const providerAction = action === 'upload' || action === 'submit';
  const clientAction = action === 'review' || action === 'approve' || action === 'requestRevision';
  if ((providerAction && viewer.role !== 'provider') || (clientAction && viewer.role !== 'client') || (action === 'amend' && viewer.role !== 'client' && viewer.role !== 'provider')) return no('WRONG_ROLE', WRONG_ROLE_AR[action], 403);
  if (settlement.settled) return no('CLOSED_BY_SETTLEMENT', action === 'review' || action === 'approve' || action === 'requestRevision' ? SETTLED_REVIEW_AR : providerAction ? SETTLED_DELIVERY_AR : SETTLED_ACTION_AR);
  if (!contractStatus) return no('CONTRACT_NOT_STARTED', 'لا يوجد عقد بعد، ولا يمكن تنفيذ هذا الإجراء قبل توقيعه');
  if (contractStatus === 'COMPLETED') return no('CONTRACT_COMPLETED', CONTRACT_COMPLETED_AR);
  if (contractStatus === 'CANCELLED') return no('CONTRACT_CANCELLED', CONTRACT_CANCELLED_AR);
  if (CONTRACT_NOT_STARTED_AR[contractStatus]) return no('CONTRACT_NOT_STARTED', notStartedReason(contractStatus, viewer.role));
  if (contractStatus !== 'ACTIVE') return no('CONTRACT_ENDED', contractStatus === 'DISPUTED' && input.activeDisputes.count > 0 ? PROJECT_FROZEN_MESSAGE : CONTRACT_ENDED_AR);
  return null;
}

/** Eligibility of one action on one stage. Check order: ownership / role -> settlement -> contract state -> stage state -> dispute freeze. */
export function evaluateAction(input: LifecycleInput, action: ActionName, stage: LifecycleStageInput | null): Eligibility {
  const blocked = contractBlock(input, action);
  if (blocked) return blocked;
  const frozen = input.activeDisputes.count > 0;
  if (action === 'amend') return frozen ? no('ACTIVE_DISPUTE_FREEZE', AMEND_FROZEN_AR, 423) : OK;
  if (!stage) return no(input.stages.length ? 'NO_STAGE_AVAILABLE' : 'NO_STAGES', input.stages.length ? NO_STAGE_AVAILABLE_AR : NO_STAGES_AR);
  if (action === 'upload' || action === 'submit') {
    if (stage.status === 'IN_PROGRESS' || stage.status === 'REVISION_REQUESTED') return OK; // delivery stays allowed during a dispute (approved rule)
    if (stage.status === 'PENDING') return no('STAGE_NOT_STARTED', STAGE_NOT_STARTED_AR);
    if (stage.status === 'SUBMITTED') return no('STAGE_AWAITING_REVIEW', STAGE_AWAITING_REVIEW_AR);
    if (stage.status === 'APPROVED') return no('STAGE_ALREADY_DECIDED', STAGE_ALREADY_DECIDED_DELIVERY_AR);
    return no('STAGE_NOT_OPEN', STAGE_NOT_OPEN_AR);
  }
  // review / approve / requestRevision: a delivery must exist and be waiting for the client
  if (stage.status === 'APPROVED') return no('STAGE_ALREADY_DECIDED', STAGE_ALREADY_DECIDED_AR);
  if (stage.status === 'PENDING') return no('STAGE_NOT_STARTED', STAGE_NOT_STARTED_AR);
  if (!stageHasPendingDelivery(stage)) return no('STAGE_NOT_DELIVERED', STAGE_NOT_DELIVERED_AR);
  // Approval and release are frozen by an open dispute; a revision request moves no money and stays possible.
  if (frozen && (action === 'approve')) return no('ACTIVE_DISPUTE_FREEZE', PROJECT_FROZEN_MESSAGE, 423);
  return OK;
}

const evaluateAll = (input: LifecycleInput, stage: LifecycleStageInput | null): Eligibilities => Object.fromEntries(ACTION_NAMES.map(a => [a, evaluateAction(input, a, stage)])) as Eligibilities;

export function computeLifecycle(input: LifecycleInput): ProjectLifecycle {
  const { contractStatus, settlement, stages, escrow } = input;
  const settled = settlement.settled;
  const approved = stages.filter(s => s.status === 'APPROVED');
  const allStagesApproved = stages.length > 0 && approved.length === stages.length;
  const completedByDelivery = contractStatus === 'COMPLETED' && !settled;
  const frozen = input.activeDisputes.count > 0;

  let operationalStatus: OperationalStatus;
  let closureReason: ClosureReason = null;
  if (settled) { operationalStatus = 'CLOSED_BY_SETTLEMENT'; closureReason = 'DISPUTE_SETTLEMENT'; }
  else if (!contractStatus) operationalStatus = 'NOT_STARTED';
  else if (contractStatus === 'COMPLETED') { operationalStatus = 'COMPLETED_BY_DELIVERY'; closureReason = 'DELIVERY_COMPLETED'; }
  else if (contractStatus === 'CANCELLED') { operationalStatus = 'CANCELLED'; closureReason = 'CANCELLED'; }
  else if (contractStatus === 'ACTIVE') operationalStatus = 'ACTIVE';
  else if (CONTRACT_NOT_STARTED_AR[contractStatus]) operationalStatus = 'PENDING_START';
  else operationalStatus = 'ENDED';
  const operationalLabel = ({ NOT_STARTED: 'لم يبدأ العقد بعد', PENDING_START: 'بانتظار بدء العقد', ACTIVE: 'مشروع نشط', COMPLETED_BY_DELIVERY: 'مكتمل بالتسليم', CLOSED_BY_SETTLEMENT: SETTLED_LABEL_AR, CANCELLED: 'ملغى', ENDED: 'منتهٍ' } as Record<OperationalStatus, string>)[operationalStatus];
  const closureLabel = closureReason === 'DISPUTE_SETTLEMENT' ? SETTLED_LABEL_AR : closureReason === 'DELIVERY_COMPLETED' ? 'اكتمل باعتماد جميع المراحل' : closureReason === 'CANCELLED' ? 'أُلغي العقد' : null;

  const ordered = [...stages].sort((a, b) => a.stepOrder - b.stepOrder);
  const heldStageAmount = !!escrow && escrow.status === 'HELD' && !settled;
  const stageViews: StageLifecycle[] = ordered.map(s => {
    const closed = settled && STAGE_STATUSES_CLOSED_BY_SETTLEMENT.includes(s.status);
    const awaiting = stageHasPendingDelivery(s);
    const amountState: StageLifecycle['amountState'] = s.status === 'APPROVED' ? 'RELEASED' : closed ? 'HISTORICAL' : heldStageAmount && contractStatus === 'ACTIVE' ? 'HELD' : 'NONE';
    return {
      stageId: s.id, stepOrder: s.stepOrder, storedStatus: s.status,
      displayStatus: closed ? STAGE_CLOSED_BY_SETTLEMENT : s.status,
      displayStatusLabel: closed ? SETTLED_STAGE_LABEL_AR : (STAGE_LABEL_AR[s.status] ?? s.status),
      closedBySettlement: closed, awaitingClientReview: awaiting && !closed, hasDelivery: s.deliveries.length > 0,
      decided: s.status === 'APPROVED', decision: s.status === 'APPROVED' ? { status: 'APPROVED', decidedAt: s.approvedAt ?? null } : null,
      amount: s.amount, amountState,
      amountLabel: amountState === 'HISTORICAL' ? STAGE_AMOUNT_HISTORICAL_AR : amountState === 'RELEASED' ? 'أُفرج عن المبلغ باعتماد المرحلة' : amountState === 'HELD' ? 'محتجز في الضمان' : null,
      eligibility: evaluateAll(input, s)
    };
  });

  // Project-level eligibility refers to the stage that matters now: an open one (IN_PROGRESS / REVISION), else one waiting for review, else the first unapproved, else the last.
  const focal = ordered.find(s => s.status === 'IN_PROGRESS' || s.status === 'REVISION_REQUESTED') ?? ordered.find(stageHasPendingDelivery) ?? ordered.find(s => s.status !== 'APPROVED') ?? ordered[ordered.length - 1] ?? null;
  const eligibility = {} as Eligibilities;
  for (const action of ACTION_NAMES) {
    // an action is allowed at project level when it is allowed on ANY stage (e.g. review while another stage is open); the reason is the focal stage's
    const any = ordered.map(s => evaluateAction(input, action, s)).find(e => e.allowed);
    eligibility[action] = any ?? evaluateAction(input, action, focal);
  }

  // ------------------------------------------------------------------ money
  const price = round2(input.contractPrice ?? escrow?.amount ?? 0);
  const dist = settled ? input.settlementDistribution ?? null : null;
  const escrowReleased = round2(escrow?.releasedAmount ?? 0);
  const approvedSum = round2(approved.reduce((sum, s) => sum + Number(s.amount || 0), 0));
  const releasedByStageApprovals = settled
    ? (dist ? Math.max(0, round2(escrowReleased - dist.releaseToProvider)) : approvedSum)
    : escrow ? escrowReleased : approvedSum;
  const heldNow = !settled && escrow && escrow.status === 'HELD' ? Math.max(0, round2(escrow.amount - escrowReleased)) : 0;
  const financial: FinancialSummary = {
    currency: 'USD', contractValue: price, contractValueNote: settled ? CONTRACT_VALUE_HISTORICAL_AR : null,
    escrowStatus: escrow?.status ?? null, heldNow, releasedByStageApprovals,
    platformCommissionTotal: escrow?.platformCommissionAmount != null ? round2(escrow.platformCommissionAmount) : null,
    providerNetReleasedTotal: escrow?.providerNetReleasedAmount != null ? round2(escrow.providerNetReleasedAmount) : null,
    settlement: settled ? {
      disputeId: settlement.disputeId, outcome: settlement.outcome, settledAt: settlement.settledAt,
      refundToClient: round2(dist?.refundToClient ?? 0), releaseToProvider: round2(dist?.releaseToProvider ?? 0), platformCommission: round2(dist?.platformCommission ?? 0), providerNet: round2(dist?.providerNet ?? 0)
    } : null,
    escrowReleasedIsSettlement: settled && escrow?.status === 'RELEASED',
    fullyPaidToProvider: completedByDelivery && escrow?.status === 'RELEASED' && price > 0 && escrowReleased >= price - 0.01
  };

  return {
    operationalStatus, operationalLabel, closureReason, closureLabel, completedByDelivery, closedBySettlement: settled,
    hasActiveDispute: frozen, activeDisputeCount: input.activeDisputes.count, activeDisputeId: frozen ? input.activeDisputes.latestId : null, activeDisputeReason: frozen ? PROJECT_FROZEN_MESSAGE : null,
    contractStatus, allStagesApproved, approvedStagesCount: approved.length, stagesCount: stages.length, focalStageId: focal?.id ?? null,
    eligibility, stages: stageViews, financial
  };
}

/** Eligibility of one stage looked up from a computed lifecycle (or a stage-less "blocked" answer when the stage is unknown). */
export function stageEligibility(lc: ProjectLifecycle, stageId: string): Eligibilities {
  return lc.stages.find(s => s.stageId === stageId)?.eligibility ?? allBlocked(no('NO_STAGE_AVAILABLE', NO_STAGE_AVAILABLE_AR));
}

/** Throws the specific error for a blocked action: 403 only for non-ownership / wrong role, 423 for the dispute freeze, 409 for everything else. */
export function assertAllowed(e: Eligibility): void {
  if (e.allowed) return;
  throw new AppError(e.reason ?? NOT_OWNER_AR, e.httpStatus ?? 409, e.code ? [{ code: e.code === 'ACTIVE_DISPUTE_FREEZE' ? PROJECT_FROZEN_CODE : e.code }] : undefined);
}

// --------------------------------------------------------------------------------------------------------- list summary
export interface LifecycleSummary {
  operationalStatus: OperationalStatus;
  operationalLabel: string;
  closureReason: ClosureReason;
  completedByDelivery: boolean;
  closedBySettlement: boolean;
  hasActiveDispute: boolean;
}
/** The light version for lists (no stage data needed). */
export function summarizeLifecycle(contractStatus: string | null, settled: boolean, activeDisputeCount: number): LifecycleSummary {
  const lc = computeLifecycle({ viewer: { role: 'none', isOwner: false }, contractStatus, contractPrice: null, escrow: null, stages: [], activeDisputes: { count: activeDisputeCount, latestId: null }, settlement: settled ? { settled: true, disputeId: '', outcome: '', outcomeLabel: '', settledAt: null } : { settled: false } });
  return { operationalStatus: lc.operationalStatus, operationalLabel: lc.operationalLabel, closureReason: lc.closureReason, completedByDelivery: lc.completedByDelivery, closedBySettlement: lc.closedBySettlement, hasActiveDispute: lc.hasActiveDispute };
}

/** projectId -> number of OPEN / UNDER_REVIEW disputes (one query, requestId-keyed legacy disputes included). */
export async function activeDisputeCounts(ids: string[], db: { dispute: { findMany: (args: any) => Promise<Array<{ projectId: string | null; requestId: string | null }>> } } = prisma as any): Promise<Map<string, number>> {
  const clean = Array.from(new Set(ids.filter(Boolean)));
  const out = new Map<string, number>();
  if (!clean.length) return out;
  const rows = await db.dispute.findMany({ where: { status: { in: ACTIVE_DISPUTE_STATUSES }, OR: [{ projectId: { in: clean } }, { requestId: { in: clean } }] }, select: { projectId: true, requestId: true } });
  for (const r of rows) { const k = r.projectId ?? r.requestId; if (k) out.set(k, (out.get(k) ?? 0) + 1); }
  return out;
}

/** The executed settlement figures from the dispute's own audit row, or null (never throws: a read model must not fail because the audit read did). */
export async function settlementDistributionOf(disputeId: string, audit: Pick<typeof adminAudit, 'listForEntity'> = adminAudit): Promise<SettlementDistribution | null> {
  try {
    const s = (await audit.listForEntity('DISPUTE', disputeId, ['DISPUTE_FINANCIAL_RESOLVED']))[0]?.context?.outcomeSummary as Record<string, unknown> | undefined;
    if (!s) return null;
    return { outcome: String(s.outcome ?? ''), refundToClient: Number(s.refundToClient ?? 0), releaseToProvider: Number(s.releaseToProvider ?? 0), platformCommission: Number(s.platformCommission ?? 0), providerNet: Number(s.providerNet ?? 0) };
  } catch { return null; }
}

/** Gathers the dispute-side inputs of one project: active disputes + settlement (+ its distribution when settled). */
export async function loadDisputeFacts(projectId: string, db: any = prisma): Promise<Pick<LifecycleInput, 'activeDisputes' | 'settlement' | 'settlementDistribution'>> {
  const [count, latest, settlement] = await Promise.all([countActiveDisputes(projectId, db), getActiveDisputeForProject(projectId, db), adminSettlementFor({ projectId }, db)]);
  return { activeDisputes: { count, latestId: latest?.id ?? null, latestStatus: latest?.status ?? null }, settlement, settlementDistribution: settlement.settled ? await settlementDistributionOf(settlement.disputeId) : null };
}

/**
 * Loads everything for one contract/project and computes the lifecycle for a viewer. `key` is the project id or the contract id. The viewer is "owner" when it is
 * the contract's client (role client) / provider (role provider); an admin never owns an operational action. Returns null when there is no such contract.
 */
export async function loadLifecycle(key: string, viewer: { userId: string | null; role: LifecycleRole }): Promise<{ lifecycle: ProjectLifecycle; contract: { id: string; projectId: string; clientId: string; providerId: string; status: string; price: number } } | null> {
  const contract = await prisma.contract.findFirst({
    where: { OR: [{ id: key }, { projectId: key }] },
    select: { id: true, projectId: true, clientId: true, providerId: true, status: true, price: true, project: { select: { escrow: true } }, stages: { orderBy: { stepOrder: 'asc' }, select: { id: true, stepOrder: true, status: true, amount: true, approvedAt: true, deliveries: { orderBy: { submittedAt: 'asc' }, select: { id: true, status: true, submittedAt: true, reviewedAt: true, reviewNote: true } } } } }
  });
  if (!contract) return null;
  const isOwner = viewer.role === 'client' ? contract.clientId === viewer.userId : viewer.role === 'provider' ? contract.providerId === viewer.userId : false;
  const facts = await loadDisputeFacts(contract.projectId);
  const lifecycle = computeLifecycle({ viewer: { role: viewer.role, isOwner }, contractStatus: contract.status, contractPrice: contract.price, escrow: contract.project?.escrow ?? null, stages: contract.stages, ...facts });
  return { lifecycle, contract: { id: contract.id, projectId: contract.projectId, clientId: contract.clientId, providerId: contract.providerId, status: contract.status, price: contract.price } };
}

/**
 * The BE guard behind the endpoints (provider upload / submit delivery, client approve / request revision): the SAME evaluation the read models expose.
 * Non-ownership (including "no such contract for you") is the only 403; a missing stage is 409; the settlement / ended contract / not delivered / already decided
 * cases are 409 with their specific reason; the dispute freeze is 423. Returns nothing: it throws.
 */
export async function assertStageActionAllowed(p: {
  role: 'client' | 'provider';
  userId: string;
  action: ActionName;
  contract: { projectId: string; clientId: string; providerId: string; status: string; price?: number | null } | null;
  stage: { id: string; stepOrder?: number | null; status: string; amount?: number | null; deliveries?: Array<{ status: string }> } | null;
  /** The caller's own prisma client (or transaction client), so the guard reads the same database the caller writes to. */
  db?: any;
}): Promise<void> {
  const owner = !!p.contract && (p.role === 'client' ? p.contract.clientId === p.userId : p.contract.providerId === p.userId);
  if (!p.contract || !owner) throw new AppError(notOwnerReason(p.action), 403, [{ code: 'NOT_OWNER' }]);
  const facts = await loadDisputeFacts(p.contract.projectId, p.db ?? prisma);
  const stage: LifecycleStageInput | null = p.stage ? { id: p.stage.id, stepOrder: p.stage.stepOrder ?? 1, status: p.stage.status, amount: Number(p.stage.amount ?? 0), deliveries: p.stage.deliveries ?? [] } : null;
  const input: LifecycleInput = { viewer: { role: p.role, isOwner: true }, contractStatus: p.contract.status, contractPrice: p.contract.price ?? null, escrow: null, stages: stage ? [stage] : [], ...facts };
  // A missing stage is reported after the contract-level reasons (a settled / ended contract explains itself first).
  if (!stage) {
    const blocked = contractBlock(input, p.action);
    if (blocked) assertAllowed(blocked);
    throw new AppError('هذه المرحلة غير موجودة ضمن هذا العقد', 409, [{ code: 'STAGE_NOT_FOUND' }]);
  }
  assertAllowed(evaluateAction(input, p.action, stage));
}

export interface ListLifecycleRow { projectId: string; contractStatus: string | null; price: number | null; escrow: LifecycleEscrowInput | null }
export interface ListLifecycle extends LifecycleSummary { closureLabel: string | null; financial: FinancialSummary }

/**
 * Lifecycle summary + financial summary for the rows of a LIST (archive, active lists, admin list): two batched queries (settlements, active disputes) plus one audit
 * read per SETTLED project only. Every list shows the same state and the same money as the detail page because both call `computeLifecycle`.
 */
export async function listLifecycles(rows: ListLifecycleRow[], deps: { db?: any; audit?: Pick<typeof adminAudit, 'listForEntity'> } = {}): Promise<Map<string, ListLifecycle>> {
  const db = deps.db ?? prisma;
  const out = new Map<string, ListLifecycle>();
  const clean = Array.from(new Set(rows.map(r => r.projectId).filter(Boolean)));
  if (!clean.length) return out;
  const [settledRows, active] = await Promise.all([
    db.dispute.findMany({ where: { projectId: { in: clean }, ...SETTLED_DISPUTE_WHERE }, orderBy: { resolvedAt: 'desc' }, select: { id: true, projectId: true, resolution: true, resolvedAt: true } }) as Promise<Array<{ id: string; projectId: string | null; resolution: string | null; resolvedAt: Date | null }>>,
    activeDisputeCounts(clean, db)
  ]);
  const settledBy = new Map<string, { id: string; resolution: string | null; resolvedAt: Date | null }>();
  for (const r of settledRows) if (r.projectId && !settledBy.has(r.projectId)) settledBy.set(r.projectId, r);
  for (const row of rows) {
    const st = settledBy.get(row.projectId);
    const settlement: AdminSettlement = st ? { settled: true, disputeId: st.id, outcome: String(st.resolution), outcomeLabel: String(st.resolution), settledAt: st.resolvedAt } : { settled: false };
    const distribution = st ? await settlementDistributionOf(st.id, deps.audit) : null;
    const lc = computeLifecycle({ viewer: { role: 'none', isOwner: false }, contractStatus: row.contractStatus, contractPrice: row.price, escrow: row.escrow, stages: [], activeDisputes: { count: active.get(row.projectId) ?? 0, latestId: null }, settlement, settlementDistribution: distribution });
    out.set(row.projectId, { operationalStatus: lc.operationalStatus, operationalLabel: lc.operationalLabel, closureReason: lc.closureReason, closureLabel: lc.closureLabel, completedByDelivery: lc.completedByDelivery, closedBySettlement: lc.closedBySettlement, hasActiveDispute: lc.hasActiveDispute, financial: lc.financial });
  }
  return out;
}
