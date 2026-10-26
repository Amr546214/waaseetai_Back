import { AccountType, ContractStatus, DisputeStatus, EscrowStatus, LogCategory, LogStatus, Prisma, ProjectStatus, RequestStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError, fieldError, fieldErrorItem } from '../utils/app-error';
import { CreateDisputeInput, ResolveDisputeFinancialInput, ResolveDisputeInput } from '../dtos/dispute.dto';
import { isV2Escrow, splitRelease } from '../utils/escrow-commission';
import { round2 } from '../utils/money';
import { resolutionLabelAr, type FinancialOutcomeSummary } from '../utils/dispute-resolution';
import { ACTIVE_DISPUTE_STATUSES, getFreezeState, lockProjectForFreezeCheck } from './dispute-freeze.service';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import { WaseetAiError, WaseetAiErrorCode } from './ai/waseet-ai/waseet-ai.errors';
import { providerNotifications } from './provider-notifications.service';
import { clientNotifications, clientNotificationFor } from './client-notifications.service';
import { adminAudit } from './admin-audit.service';
import { notifyAdmins } from './admin-notifications.service';
import { assigneeHolds } from './admin-access.service';
import { creditWallet } from '../utils/wallet-balance';
import { requireCurrency } from '../utils/currency';

// Advisory-only dispute summary — never a verdict. Human admin resolution
// via resolve() above remains the sole authority on status/fault/money;
// this call performs zero DB writes and cannot influence that decision.
export interface DisputeAiSummary {
  summary: string;
  clientPerspective: string;
  providerPerspective: string;
}

const MAX_TEXT_FIELD_LENGTH = 2000;

/**
 * Escrow amount still held for a project, using the same definition provider-finance.service.ts applies to the provider's
 * escrow balance: (contract price, falling back to the escrow amount) − already released, never below 0, 2 decimals.
 * null when the project has no escrow; 0 once the escrow is RELEASED or REFUNDED.
 */
export function heldEscrowAmount(
  escrow: { amount: number; releasedAmount: number | null; status: string } | null | undefined,
  contractPrice: number | null | undefined
): number | null {
  if (!escrow) return null;
  if (escrow.status !== 'HELD') return 0;
  const entitlement = contractPrice || escrow.amount;
  return Math.round(Math.max(0, entitlement - (escrow.releasedAmount || 0)) * 100) / 100;
}

// WaseetAI also returns a `recommendation` (a proposed settlement). It is
// deliberately never read, mapped, returned or logged: the human admin's
// resolve() is the only path that decides anything about the dispute.
const FORBIDDEN_SUMMARY_KEYS = ['winner', 'loser', 'verdict', 'faultPercentage', 'recommendation', 'recommendedResolution', 'releaseFunds', 'refundAmount', 'confidence', 'confidenceOfGuilt'];

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/** Maps a WaseetAI response to the advisory-only shape. Returns null when a
 *  required field is missing/oversized; never invents a replacement value. */
function toDisputeAiSummary(value: unknown): DisputeAiSummary | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isNonEmptyBoundedString(v.summary, MAX_TEXT_FIELD_LENGTH)) return null;
  if (!isNonEmptyBoundedString(v.clientPerspective, MAX_TEXT_FIELD_LENGTH)) return null;
  if (!isNonEmptyBoundedString(v.providerPerspective, MAX_TEXT_FIELD_LENGTH)) return null;
  return { summary: v.summary, clientPerspective: v.clientPerspective, providerPerspective: v.providerPerspective };
}

const cap = (text: string | null | undefined, max = 1500) => (text ? text.slice(0, max) : '');

export class DisputeService {
  private async requestForActor(
    requestId: string,
    userId: string,
    actor: 'client' | 'provider',
    allowedStatuses: RequestStatus[] = [RequestStatus.COMPLETED, RequestStatus.IN_PROGRESS],
    statusErrorMessage = 'لا يمكن فتح نزاع على هذا الطلب حالياً'
  ) {
    const request = await prisma.clientRequest.findUnique({
      where: { id: requestId },
      include: { clientProfile: { select: { userId: true } }, proposals: { where: { providerId: userId }, select: { id: true, status: true, providerId: true } } }
    });
    if (!request) throw new AppError('الطلب غير موجود', 404);
    // Ownership first: someone who is not a party never learns anything about the request's state.
    if (actor === 'client' && request.clientProfile.userId !== userId) throw new AppError('لا تملك صلاحية هذا الطلب', 403);
    if (actor === 'provider' && !request.proposals.some(proposal => proposal.status === 'ACCEPTED')) throw new AppError('لا تملك صلاحية هذا الطلب', 403);
    if (!allowedStatuses.includes(request.status)) {
      // A request that is still being agreed on has no signed, funded contract to dispute.
      const notStarted = request.status === RequestStatus.OPEN || request.status === RequestStatus.PENDING_SIGNATURE;
      throw new AppError(notStarted ? 'لا يمكن فتح نزاع قبل توقيع العقد من الطرفين وتمويل الضمان' : statusErrorMessage, 400);
    }
    const accepted = await prisma.proposal.findFirst({ where: { clientRequestId: requestId, status: 'ACCEPTED' }, select: { providerId: true } });
    return { request, againstUserId: actor === 'client' ? accepted?.providerId : request.clientProfile.userId };
  }

  /**
   * Marketplace (serviceCatalog) purchases create a Project + Contract + Escrow directly, with no ClientRequest and no
   * accepted Proposal, so requestForActor() cannot see them. This resolves the same URL id as a contract-backed Project
   * instead: the actor must be the project's own client/provider, and the contract must be in a state that can be disputed.
   */
  private async projectForActor(projectId: string, userId: string, actor: 'client' | 'provider') {
    // Accept the project id OR the contract id (the client project page is keyed by the contract id for marketplace purchases).
    const project = await prisma.project.findFirst({
      where: { OR: [{ id: projectId }, { contract: { id: projectId } }] },
      select: { id: true, clientId: true, providerId: true, contract: { select: { id: true, status: true, clientId: true, providerId: true } } }
    });
    if (!project) throw new AppError('الطلب غير موجود', 404);
    const contract = project.contract;
    const ownerId = actor === 'client' ? (contract?.clientId ?? project.clientId) : (contract?.providerId ?? project.providerId);
    if (ownerId !== userId) throw new AppError('لا تملك صلاحية هذا الطلب', 403);
    if (!contract) throw new AppError('لا يمكن فتح نزاع على هذا المشروع لأنه لا يوجد عقد مرتبط به بعد', 400);
    const disputable: ContractStatus[] = [ContractStatus.ACTIVE, ContractStatus.COMPLETED, ContractStatus.DISPUTED];
    const notStarted: ContractStatus[] = [ContractStatus.PENDING_CLIENT_SIGNATURE, ContractStatus.PENDING_PAYMENT, ContractStatus.PENDING_PROVIDER_SIGNATURE];
    if (notStarted.includes(contract.status)) throw new AppError('لا يمكن فتح نزاع قبل توقيع العقد من الطرفين وتمويل الضمان', 400);
    if (!disputable.includes(contract.status)) throw new AppError('لا يمكن فتح نزاع على هذا المشروع في حالة العقد الحالية', 400);
    return { projectId: project.id, againstUserId: actor === 'client' ? (contract.providerId ?? project.providerId) : (contract.clientId ?? project.clientId) };
  }

  async createForRequest(requestId: string, userId: string, actor: 'client' | 'provider', input: CreateDisputeInput) {
    const legacyRequest = await prisma.clientRequest.findUnique({ where: { id: requestId }, select: { id: true } });
    const target = legacyRequest
      ? { requestId, projectId: (await prisma.project.findUnique({ where: { id: requestId }, select: { id: true } }))?.id, againstUserId: (await this.requestForActor(requestId, userId, actor)).againstUserId }
      : { requestId: undefined as string | undefined, ...(await this.projectForActor(requestId, userId, actor)) };
    const where = target.projectId ? { projectId: target.projectId } : { requestId };
    // Same contract-row lock the stage approval takes before it releases money: a dispute opened "at the same moment" as an approval either
    // is seen by that approval (refused) or is created after the approval fully committed. Also closes the duplicate-open race.
    const dispute = await prisma.$transaction(async tx => {
      if (target.projectId) await lockProjectForFreezeCheck(tx, target.projectId);
      const existing = await tx.dispute.findFirst({ where: { ...where, openedById: userId, status: { in: ACTIVE_DISPUTE_STATUSES } } });
      if (existing) throw new AppError('لديك نزاع مفتوح مسبقاً لهذا الطلب', 409);
      return tx.dispute.create({
        data: { requestId: target.requestId, projectId: target.projectId, openedById: userId, againstUserId: target.againstUserId, reason: input.reason, description: input.description, evidence: input.evidence || [], status: DisputeStatus.OPEN },
        include: { request: { select: { id: true, title: true } }, project: { select: { id: true, title: true } } }
      });
    });
    // The provider is the opener (confirmation) or the party the client opened it against.
    const disputedTitle = dispute.request?.title ?? dispute.project?.title ?? '';
    await providerNotifications.disputeOpened({ disputeId: dispute.id, providerId: actor === 'provider' ? userId : target.againstUserId, openedBy: actor, requestTitle: disputedTitle });
    // The client is the opener (confirmation) or the party the provider opened it against.
    const disputeClientId = actor === 'client' ? userId : target.againstUserId;
    if (disputeClientId) await clientNotifications.send(clientNotificationFor.disputeOpened({ clientId: disputeClientId, disputeId: dispute.id, openedBy: actor, requestTitle: disputedTitle }));
    void notifyAdmins('NEW_DISPUTE', { id: dispute.id, ref: disputedTitle });
    return dispute;
  }

  async cancelByProvider(requestId: string, providerId: string) {
    await this.requestForActor(requestId, providerId, 'provider', [RequestStatus.IN_PROGRESS], 'لا يمكن إلغاء هذا الطلب في حالته الحالية');
    // Phase 4 — this used to flip ONLY ClientRequest.status to CANCELLED,
    // leaving the Contract ACTIVE, the Project IN_PROGRESS and the client's
    // Escrow HELD (funds stranded, related records contradicting each other).
    // A funded, signed engagement has no safe unilateral cancel+refund path
    // yet (no CANCELLED ProjectStatus, no escrow-refund flow), so it must go
    // through a dispute / admin resolution instead of silently diverging.
    const [activeContract, heldEscrow] = await Promise.all([
      prisma.contract.findFirst({ where: { projectId: requestId, status: { in: [ContractStatus.ACTIVE, ContractStatus.PENDING_PROVIDER_SIGNATURE, ContractStatus.DISPUTED] } }, select: { id: true } }),
      prisma.escrow.findFirst({ where: { projectId: requestId, status: EscrowStatus.HELD }, select: { id: true } })
    ]);
    if (activeContract || heldEscrow) {
      throw new AppError('لا يمكن إلغاء مشروع مموَّل بعقد نشط من طرف واحد — افتح نزاعاً ليتم الفصل وإعادة المبلغ المحتجز عبر الإدارة', 409);
    }
    return prisma.clientRequest.update({ where: { id: requestId }, data: { status: RequestStatus.CANCELLED } });
  }

  async listForAdmin(status?: DisputeStatus, page = 1, limit = 20) {
    const safePage = Math.max(1, page); const safeLimit = Math.min(100, Math.max(1, limit));
    const where = status ? { status } : {};
    const [items, total, grouped] = await Promise.all([
      prisma.dispute.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { request: { select: { id: true, title: true } }, project: { select: { id: true, title: true } }, openedBy: { select: { id: true, firstName: true, lastName: true, email: true } }, againstUser: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
      prisma.dispute.count({ where }),
      prisma.dispute.groupBy({ by: ['status'], _count: { _all: true } })
    ]);
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    const assignees = await this.assigneesFor(items.map(i => i.id));
    const pages = Math.ceil(total / safeLimit);
    return { items: items.map(i => ({ ...i, assignedTo: assignees.get(i.id) ?? null })), counts, pagination: { page: safePage, limit: safeLimit, total, pages, totalPages: pages } };
  }

  /** Current assignee per dispute = the newest DISPUTE_ASSIGNED audit row (no schema column exists for it). */
  private async assigneesFor(ids: string[]) {
    const result = new Map<string, { id: string; name: string }>();
    if (!ids.length) return result;
    const rows = await prisma.accountAuditLog.findMany({
      where: { source: 'ADMIN', eventType: 'DISPUTE_ASSIGNED', OR: ids.map(id => ({ context: { path: ['entityId'], equals: id } })) },
      orderBy: { occurredAt: 'desc' },
      select: { context: true }
    });
    for (const row of rows) {
      const ctx = (row.context ?? {}) as Record<string, any>;
      if (ctx.entityId && !result.has(ctx.entityId) && ctx.assigneeId) result.set(ctx.entityId, { id: ctx.assigneeId, name: ctx.assigneeName ?? '' });
    }
    return result;
  }

  // A user is a party to a dispute if they opened it or it was opened
  // against them — same two columns admin's listForAdmin()/getForAdmin()
  // already expose, just scoped down to "my own" instead of "everyone's".
  async listForUser(userId: string, status?: DisputeStatus, page = 1, limit = 20) {
    const safePage = Math.max(1, page); const safeLimit = Math.min(100, Math.max(1, limit));
    const where = { OR: [{ openedById: userId }, { againstUserId: userId }], ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      prisma.dispute.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { request: { select: { id: true, title: true } }, project: { select: { id: true, title: true } }, openedBy: { select: { id: true, firstName: true, lastName: true } }, againstUser: { select: { id: true, firstName: true, lastName: true } } } }),
      prisma.dispute.count({ where })
    ]);
    return { items, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
  }

  async getForUser(id: string, userId: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id }, include: { request: true, project: true, openedBy: { select: { id: true, firstName: true, lastName: true } }, againstUser: { select: { id: true, firstName: true, lastName: true } }, resolvedBy: { select: { id: true, firstName: true, lastName: true } } } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    if (dispute.openedById !== userId && dispute.againstUserId !== userId) throw new AppError('لا تملك صلاحية الوصول لهذا النزاع', 403);
    // New read-only field `heldEscrowAmount`: the escrow amount still held for the dispute's project (null when there is no project/escrow).
    let held: number | null = null;
    if (dispute.projectId) {
      const escrow = await prisma.escrow.findUnique({
        where: { projectId: dispute.projectId },
        select: { amount: true, releasedAmount: true, status: true, project: { select: { contract: { select: { price: true } } } } }
      });
      held = heldEscrowAmount(escrow, escrow?.project?.contract?.price);
    }
    const projectKey = dispute.projectId ?? dispute.requestId;
    const closed = dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.REJECTED;
    const financialOutcome = closed ? await this.financialOutcomeOf(dispute.id) : null;
    return {
      ...dispute, heldEscrowAmount: held,
      resolutionLabel: resolutionLabelAr(dispute.resolution, !!financialOutcome), financialOutcome,
      projectFreeze: projectKey ? await getFreezeState(projectKey, prisma) : null
    };
  }

  async getForAdmin(id: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id }, include: { request: true, project: true, openedBy: { select: { id: true, firstName: true, lastName: true, email: true } }, againstUser: { select: { id: true, firstName: true, lastName: true, email: true } }, resolvedBy: { select: { id: true, firstName: true, lastName: true } } } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    const projectId = dispute.projectId ?? dispute.requestId;
    const [escrow, audit] = await Promise.all([
      projectId
        ? prisma.escrow.findUnique({ where: { projectId }, select: { amount: true, releasedAmount: true, status: true, fundedAt: true, project: { select: { contract: { select: { price: true, status: true } } } } } })
        : Promise.resolve(null),
      adminAudit.listForEntity('DISPUTE', id)
    ]);
    const assignment = audit.find(e => e.eventType === 'DISPUTE_ASSIGNED');
    const financialOutcome = (audit.find(e => e.eventType === 'DISPUTE_FINANCIAL_RESOLVED')?.context?.outcomeSummary as FinancialOutcomeSummary | undefined) ?? null;
    return {
      ...dispute,
      resolutionLabel: resolutionLabelAr(dispute.resolution, !!financialOutcome), financialOutcome,
      projectFreeze: projectId ? await getFreezeState(projectId, prisma) : null,
      heldEscrowAmount: heldEscrowAmount(escrow, escrow?.project?.contract?.price),
      escrow: escrow ? { status: escrow.status, amount: escrow.amount, releasedAmount: escrow.releasedAmount, fundedAt: escrow.fundedAt } : null,
      contractStatus: escrow?.project?.contract?.status ?? null,
      assignedTo: assignment ? { id: assignment.context.assigneeId, name: assignment.context.assigneeName ?? '' } : null,
      // Internal admin notes: returned by this admin-only endpoint ONLY — the parties' own detail (getForUser) never carries them.
      notes: audit.filter(e => e.eventType === 'DISPUTE_NOTE').map(e => ({ id: e.id, body: String(e.context.body ?? ''), createdAt: e.occurredAt, admin: e.admin })),
      timeline: audit.map(e => ({ id: e.id, eventType: e.eventType, title: e.title, summary: e.summary, occurredAt: e.occurredAt, admin: e.admin }))
    };
  }

  private async openDisputeForAdmin(id: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.REJECTED) throw new AppError('تمت معالجة النزاع مسبقاً ولا يمكن تعديله', 409);
    return dispute;
  }

  async assign(id: string, adminId: string, assigneeId: string) {
    const dispute = await this.openDisputeForAdmin(id);
    const assignee = await prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true, firstName: true, lastName: true, accountType: true } });
    if (!assignee || (assignee.accountType !== AccountType.ADMIN && assignee.accountType !== AccountType.SUPER_ADMIN) || !(await assigneeHolds(assigneeId, ['disputes.view']))) throw fieldError('assigneeId', 'يمكن إسناد النزاع إلى عضو فريق يملك صلاحية عرض النزاعات فقط');
    const name = [assignee.firstName, assignee.lastName].filter(Boolean).join(' ');
    await adminAudit.record({ adminId, entity: 'DISPUTE', entityId: dispute.id, eventType: 'DISPUTE_ASSIGNED', title: 'إسناد نزاع', summary: `إسناد النزاع إلى ${name || 'مشرف'}`, details: { assigneeId: assignee.id, assigneeName: name } });
    return { id: dispute.id, assignedTo: { id: assignee.id, name } };
  }

  async addNote(id: string, adminId: string, body: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id }, select: { id: true } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    const row = await adminAudit.record({ adminId, entity: 'DISPUTE', entityId: dispute.id, eventType: 'DISPUTE_NOTE', title: 'ملاحظة داخلية على نزاع', summary: 'إضافة ملاحظة داخلية على النزاع', details: { body } });
    if (!row) throw new AppError('تعذر حفظ الملاحظة، حاول مرة أخرى', 500);
    return { id: row.id, body, createdAt: row.occurredAt };
  }

  /** OPEN <-> UNDER_REVIEW only. RESOLVED / REJECTED are reached exclusively through resolve(), which carries the decision text and notifies both parties. */
  async setStatus(id: string, adminId: string, status: 'OPEN' | 'UNDER_REVIEW') {
    const dispute = await this.openDisputeForAdmin(id);
    if (dispute.status === status) throw new AppError('النزاع بهذه الحالة مسبقاً', 409);
    const updated = await prisma.dispute.update({ where: { id }, data: { status } });
    await adminAudit.record({ adminId, entity: 'DISPUTE', entityId: id, eventType: 'DISPUTE_STATUS_CHANGED', title: 'تغيير حالة نزاع', summary: `تغيير حالة النزاع من ${dispute.status} إلى ${status}`, before: { status: dispute.status }, after: { status } });
    return updated;
  }

  /**
   * Kind (1): TEXT closure / rejection. Records the decision, notifies both parties, moves NO money and changes no escrow, contract or project.
   * The status flip is a conditional update, so a double click (or two admins) closes the dispute once. Whatever the admin typed is inert text;
   * a bare financial code is refused by the DTO and routed to resolveFinancial().
   */
  async resolve(id: string, adminId: string, input: ResolveDisputeInput) {
    const dispute = await prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    if (dispute.status !== DisputeStatus.OPEN && dispute.status !== DisputeStatus.UNDER_REVIEW) throw new AppError('تمت معالجة النزاع مسبقاً', 409);
    const nextStatus = input.action === 'resolve' ? DisputeStatus.RESOLVED : DisputeStatus.REJECTED;
    const claimed = await prisma.dispute.updateMany({ where: { id, status: { in: ACTIVE_DISPUTE_STATUSES } }, data: { status: nextStatus, resolution: input.resolution, resolutionNote: input.resolutionNote, resolvedById: adminId, resolvedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError('تمت معالجة النزاع مسبقاً', 409);
    const updated = (await prisma.dispute.findUnique({ where: { id } })) ?? { ...dispute, status: nextStatus, resolution: input.resolution, resolutionNote: input.resolutionNote ?? null };
    await adminAudit.record({ adminId, entity: 'DISPUTE', entityId: id, eventType: input.action === 'resolve' ? 'DISPUTE_RESOLVED' : 'DISPUTE_REJECTED', title: input.action === 'resolve' ? 'حل نزاع' : 'رفض نزاع', summary: `قرار النزاع: ${input.resolution}`, severity: 'WARNING', before: { status: dispute.status }, after: { status: updated.status, resolution: input.resolution }, details: { resolutionNote: input.resolutionNote ?? null, financialEffect: 'NONE' } });
    await this.notifyParties(dispute, id, input.action, input.resolution, null);
    return updated;
  }

  private async notifyParties(dispute: { requestId: string | null; projectId: string | null; openedById: string; againstUserId: string | null }, id: string, action: 'resolve' | 'reject', resolution: string, financial: FinancialOutcomeSummary | null) {
    const disputeProviderId = await this.providerOf(dispute);
    await providerNotifications.disputeResolved({ disputeId: id, providerId: disputeProviderId, action, resolution, financial });
    // the client is whichever party of the dispute is not its provider
    const disputeClientId = disputeProviderId ? [dispute.openedById, dispute.againstUserId].find(u => u && u !== disputeProviderId) : undefined;
    if (disputeClientId) await clientNotifications.send(clientNotificationFor.disputeResolved({ clientId: disputeClientId, disputeId: id, action, resolution, financial }));
  }

  /**
   * Kind (2): FINANCIAL decision. The only code path that moves money for a dispute. One transaction, in this order:
   *   1. lock the contract row (the same row an approval / a new dispute locks),
   *   2. claim the dispute (OPEN|UNDER_REVIEW -> RESOLVED, conditional: a second execution matches 0 rows and fails with 409 before anything moves),
   *   3. re-read the escrow and require status HELD, expectedHeldAmount == real held, and refund + release == held (full settlement of the held balance),
   *   4. escrow -> RELEASED (release > 0, cumulative commission split with the escrow's snapshotted rate) or REFUNDED (refund only),
   *   5. client wallet credit + WalletTransaction (referenceId unique per dispute = DB-level idempotency),
   *   6. contract / project / request closed, 7. audit row (CRITICAL) written in the same transaction (a failed audit rolls the money back).
   * Money already released earlier (earned stages, or a COMPLETED project) is never touched: a settled escrow has held = 0 and is refused.
   */
  async resolveFinancial(id: string, adminId: string, input: ResolveDisputeFinancialInput) {
    // Money moves only for somebody who holds BOTH disputes.resolve and payouts.send (an account type grants neither). The route enforces it too; this is the last line of defence at the service.
    if (!(await assigneeHolds(adminId, ['disputes.resolve', 'payouts.send']))) throw new AppError('القرار المالي في النزاعات يتطلب صلاحيتي «حل النزاعات» و«إرسال الصرف» معًا', 403);
    const dispute = await prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    if (dispute.status !== DisputeStatus.OPEN && dispute.status !== DisputeStatus.UNDER_REVIEW) throw new AppError('تمت معالجة النزاع مسبقاً', 409);
    const projectId = dispute.projectId ?? dispute.requestId;
    const contractRef = projectId ? await prisma.contract.findUnique({ where: { projectId }, select: { id: true, clientId: true, providerId: true } }) : null;
    if (!projectId || !contractRef) throw new AppError('لا يوجد عقد وضمان مرتبطان بهذا النزاع لتنفيذ قرار مالي', 409);
    const refund = round2(input.refundToClient);
    const release = round2(input.releaseToProvider);

    const summary = await prisma.$transaction(async tx => {
      if (!(await lockProjectForFreezeCheck(tx, projectId))) throw new AppError('لا يوجد عقد وضمان مرتبطان بهذا النزاع لتنفيذ قرار مالي', 409);
      const current = await tx.contract.findUniqueOrThrow({ where: { id: contractRef.id }, select: { status: true } });
      if (current.status !== ContractStatus.ACTIVE) throw new AppError('العقد غير نشط: لا يوجد مبلغ محتجز لتسويته (المبالغ المصروفة سابقًا لا تُسترد بقرار نزاع)', 409);
      const claimed = await tx.dispute.updateMany({ where: { id, status: { in: ACTIVE_DISPUTE_STATUSES } }, data: { status: DisputeStatus.RESOLVED, resolution: input.outcome, resolutionNote: input.resolutionNote, resolvedById: adminId, resolvedAt: new Date() } });
      if (claimed.count !== 1) throw new AppError('تمت معالجة النزاع مسبقاً ولم يُنفَّذ أي مبلغ جديد', 409);
      const [escrow, contract] = await Promise.all([tx.escrow.findUnique({ where: { projectId } }), tx.contract.findUniqueOrThrow({ where: { id: contractRef.id }, select: { price: true, clientId: true, providerId: true } })]);
      const held = round2(heldEscrowAmount(escrow, contract.price) ?? 0);
      if (!escrow || escrow.status !== EscrowStatus.HELD || held <= 0) throw new AppError('لا يوجد مبلغ محتجز لتسويته', 409);
      if (round2(input.expectedHeldAmount) !== held) throw new AppError('تغيّر المبلغ المحتجز منذ عرضه عليك. حدّث الصفحة وراجع المبالغ ثم أعد التأكيد', 409, [{ heldAmount: held }]);
      if (round2(refund + release) !== held) { const m = `مجموع المبلغين (${round2(refund + release)}) يجب أن يساوي المبلغ المحتجز بالكامل (${held})`; throw new AppError(m, 400, [{ heldAmount: held }, fieldErrorItem('releaseToProvider', m)]); }

      const split = release > 0 && isV2Escrow(escrow) && escrow.providerCommissionRateSnapshot != null
        ? splitRelease({ grossReleasedBefore: escrow.releasedAmount, commissionTotalBefore: escrow.platformCommissionAmount, grossReleasedAfter: escrow.releasedAmount + release, ratePercent: escrow.providerCommissionRateSnapshot })
        : null;
      const escrowMoved = await tx.escrow.updateMany({
        where: { id: escrow.id, status: EscrowStatus.HELD, releasedAmount: escrow.releasedAmount },
        data: release > 0
          ? { status: EscrowStatus.RELEASED, releasedAmount: split ? split.grossReleasedAfter : round2(escrow.releasedAmount + release), ...(split ? { platformCommissionAmount: split.commissionTotalAfter, providerNetReleasedAmount: split.netReleasedAfter } : {}) }
          : { status: EscrowStatus.REFUNDED }
      });
      if (escrowMoved.count !== 1) throw new AppError('تغيّر الضمان أثناء التنفيذ، لم يُنفَّذ أي مبلغ. أعد المحاولة', 409);

      if (refund > 0) {
        // the refund goes back into the wallet of the ESCROW's own currency (no conversion exists)
        await creditWallet(tx, contract.clientId, requireCurrency(escrow.currency), refund);
        await tx.walletTransaction.create({ data: {
          userId: contract.clientId, type: 'REFUND', amount: refund, currency: requireCurrency(escrow.currency), status: 'COMPLETED', paymentMethod: 'ESCROW',
          referenceId: `DISPUTE-REFUND-${id}`, description: 'استرداد من الضمان بقرار نزاع',
          metadata: { disputeId: id, projectId, contractId: contractRef.id, outcome: input.outcome, decidedBy: adminId }
        } });
      }

      // Engagement closed: money left the escrow, so the contract cannot stay ACTIVE (a later approval would try to release again).
      const toProvider = release > 0;
      await tx.contract.update({ where: { id: contractRef.id }, data: { status: toProvider ? ContractStatus.COMPLETED : ContractStatus.CANCELLED } });
      await tx.project.update({ where: { id: projectId }, data: { status: toProvider ? ProjectStatus.COMPLETED : ProjectStatus.DISPUTED } });
      await tx.clientRequest.updateMany({ where: { proposals: { some: { projectId } } }, data: { status: toProvider ? RequestStatus.COMPLETED : RequestStatus.CANCELLED } });

      const result: FinancialOutcomeSummary = { outcome: input.outcome, refundToClient: refund, releaseToProvider: release, platformCommission: split?.commission ?? 0, providerNet: split ? split.net : release, currency: requireCurrency(escrow.currency) };
      await tx.accountAuditLog.create({ data: {
        userId: adminId, category: LogCategory.SYSTEM_AUDIT, title: 'قرار مالي في نزاع', actionText: `تنفيذ قرار مالي (${input.outcome}) على نزاع`,
        summary: `تنفيذ قرار مالي (${input.outcome}) على نزاع`, status: LogStatus.COMPLETED, eventType: 'DISPUTE_FINANCIAL_RESOLVED', source: 'ADMIN', severity: 'CRITICAL',
        beforeData: { disputeStatus: dispute.status, escrowStatus: escrow.status, heldAmount: held, escrowReleasedBefore: escrow.releasedAmount } as Prisma.InputJsonObject,
        afterData: { disputeStatus: DisputeStatus.RESOLVED, escrowStatus: release > 0 ? EscrowStatus.RELEASED : EscrowStatus.REFUNDED } as Prisma.InputJsonObject,
        context: { entity: 'DISPUTE', entityId: id, projectId, contractId: contractRef.id, escrowId: escrow.id, outcomeSummary: { ...result }, feePolicyVersion: escrow.feePolicyVersion ?? null, commissionRatePercent: escrow.providerCommissionRateSnapshot ?? null, resolutionNote: input.resolutionNote ?? null } as Prisma.InputJsonObject
      } });
      return result;
    });

    const updated = await prisma.dispute.findUnique({ where: { id } });
    await this.notifyParties(dispute, id, 'resolve', input.outcome, summary);
    return { ...(updated ?? dispute), financialOutcome: summary };
  }

  /** The executed financial outcome of a dispute (from its audit row), or null when it was closed by text only. */
  private async financialOutcomeOf(id: string): Promise<FinancialOutcomeSummary | null> {
    const rows = await adminAudit.listForEntity('DISPUTE', id, ['DISPUTE_FINANCIAL_RESOLVED']);
    const summary = rows[0]?.context?.outcomeSummary as FinancialOutcomeSummary | undefined;
    return summary ?? null;
  }

  /** The provider side of a dispute: the accepted proposal's provider on a request, else the project's provider / contract provider. */
  private async providerOf(dispute: { requestId: string | null; projectId: string | null }): Promise<string | null> {
    try {
      if (dispute.requestId) {
        const accepted = await prisma.proposal.findFirst({ where: { clientRequestId: dispute.requestId, status: 'ACCEPTED' }, select: { providerId: true } });
        if (accepted?.providerId) return accepted.providerId;
      }
      const projectId = dispute.projectId ?? dispute.requestId;
      if (!projectId) return null;
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { providerId: true, contract: { select: { providerId: true } } } });
      return project?.providerId ?? project?.contract?.providerId ?? null;
    } catch { return null; }
  }

  /**
   * Advisory-only WaseetAI summary of a dispute for the human admin reviewer.
   * Read-only: zero DB writes, never touches status/resolution/escrow. The
   * admin's resolve() above remains the only path that can change anything.
   *
   * Data minimisation: only the opener's recorded claim, an anonymous
   * evidence/stage list and opaque ids leave the system — no names, emails,
   * attachment URLs, stage descriptions or delivery notes. The upstream
   * `recommendation` field is discarded.
   */
  async generateAiSummary(id: string): Promise<DisputeAiSummary> {
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        request: { select: { id: true, clientProfile: { select: { userId: true } } } },
        project: {
          select: {
            id: true,
            contract: {
              select: {
                clientId: true,
                stages: {
                  orderBy: { stepOrder: 'asc' },
                  select: { stepOrder: true, title: true, status: true, deliveries: { orderBy: { submittedAt: 'desc' }, take: 1, select: { status: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const clientUserId = dispute.project?.contract?.clientId ?? dispute.request?.clientProfile?.userId;
    if (!clientUserId) throw new AppError('تعذر تحديد أطراف النزاع لإنشاء الملخص', 422);
    const openerIsClient = dispute.openedById === clientUserId;

    const openerClaim = [cap(dispute.reason, 500), cap(dispute.description)].filter(Boolean).join(' — ');
    const noClaim = 'لا يوجد ادعاء مسجل من هذا الطرف في النظام.';

    const evidenceList: string[] = [];
    const attachmentCount = dispute.evidence?.length ?? 0;
    if (attachmentCount > 0) evidenceList.push(`${attachmentCount} مرفق(ات) مقدمة من ${openerIsClient ? 'العميل' : 'مقدم الخدمة'} (لم يُفحص محتواها)`);
    for (const stage of dispute.project?.contract?.stages ?? []) {
      const delivery = stage.deliveries[0];
      evidenceList.push(`المرحلة ${stage.stepOrder}: ${cap(stage.title, 150)} — الحالة: ${stage.status}${delivery ? ` — آخر تسليم: ${delivery.status}` : ' — لا تسليم'}`);
    }

    try {
      const data = await waseetAiClient.summarizeDispute({
        disputeId: dispute.id,
        projectId: dispute.project?.id ?? dispute.request?.id ?? dispute.id,
        clientClaim: openerIsClient ? openerClaim : noClaim,
        providerClaim: openerIsClient ? noClaim : openerClaim,
        evidenceList: evidenceList.slice(0, 20),
      });
      const mapped = toDisputeAiSummary(data);
      if (!mapped || FORBIDDEN_SUMMARY_KEYS.filter((k) => k !== 'recommendation').some((k) => k in (data as object))) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI dispute summary failed validation');
      }
      return mapped;
    } catch (error: any) {
      console.error('[DisputeService] AI summary generation failed:', error?.code || error?.message);
      throw error;
    }
  }
}

export const disputeService = new DisputeService();
