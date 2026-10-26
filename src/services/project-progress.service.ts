import { isV2Escrow, splitRelease } from '../utils/escrow-commission';
import { AmendmentStatus, ContractStatus, EscrowStatus, LogCategory, LogStatus, ProjectStageStatus, ProjectStatus, RequestStatus, StageDeliveryStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { contractDeliveryState, editState, escrowFacts, stageDeliveryState } from '../utils/delivery-state';
import { AppError } from '../utils/app-error';
import { notificationService } from './notification.service';
import { clientNotifications, clientNotificationFor } from './client-notifications.service';
import { emailService } from './email.service';
import { deriveProviderProgression } from '../utils/progression-calculators';
import { projectHealthService, type ProjectHealthResult } from './ai-features/project-health.service';
import { deliveryReviewService, type DeliveryReviewResult } from './ai-features/delivery-review.service';
import { createCommissionsForStageReleaseEvent } from './affiliate-commission.service';
import { marketerNotifications, type MarketerCommissionNotice } from './marketer-notifications.service';
import { DELIVERY_MAX_FILE_BYTES, DELIVERY_MAX_UPLOADED_FILES, deliveryFolder, validateDeliveryArtifacts } from '../utils/delivery-artifacts';
import { uploadMulterFile } from '../utils/cloudinary-storage';
import { ACTIVE_DISPUTE_STATUSES, PROJECT_FROZEN_MESSAGE, assertProjectNotFrozen, freezeStateOf, getActiveDisputeForProject, countActiveDisputes, lockProjectForFreezeCheck } from './dispute-freeze.service';
import { deliveryCompletedProject, adminSettlementFor, adminSettledView, stageDisplayStatus, SETTLED_LABEL_AR, SETTLED_STAGE_LABEL_AR } from './settlement-state.service';
import { adminAudit } from './admin-audit.service';
import { ensureProjectRoom } from './project-conversation.service';
import { computeLifecycle, evaluateAction, assertStageActionAllowed, settlementDistributionOf } from './project-lifecycle.service';

const PROJECT_COMPLETION_POINTS = 50;

const stageLabels: Record<string, [string, string]> = {
  PENDING: ['pending', 'لم تبدأ بعد'], IN_PROGRESS: ['in_progress', 'قيد التنفيذ'],
  SUBMITTED: ['submitted', 'بانتظار مراجعة العميل'], REVISION_REQUESTED: ['revision', 'مطلوب تعديل'],
  APPROVED: ['completed', 'مكتملة ومعتمدة']
};
const deliveryLabels: Record<string, [string, string]> = {
  SUBMITTED: ['pending', 'قيد مراجعة العميل'], REVISION_REQUESTED: ['notes', 'مطلوب تعديل'], APPROVED: ['approved', 'معتمد']
};
const contractStatusLabel: Record<string, string> = {
  PENDING_CLIENT_SIGNATURE: 'بانتظار توقيع العميل', PENDING_PROVIDER_SIGNATURE: 'بانتظار توقيعك على العقد', PENDING_PAYMENT: 'بانتظار إيداع الضمان',
  ACTIVE: 'مشروع نشط', COMPLETED: 'مكتمل', CANCELLED: 'ملغى', DISPUTED: 'قيد نزاع'
};
// The same contract state worded for the CLIENT (the map above is worded for the provider): says whose signature / money is still missing.
const clientContractStatusLabel = (status: string, funded: boolean): string => status === 'PENDING_PROVIDER_SIGNATURE'
  ? (funded ? 'بانتظار توقيع مقدم الخدمة' : 'بانتظار التمويل وتوقيع الأطراف')
  : status === 'PENDING_CLIENT_SIGNATURE' || status === 'PENDING_PAYMENT' ? 'بانتظار توقيعك وإيداع الضمان'
  : contractStatusLabel[status] || 'غير نشط';
const nameFromUrl = (url: string) => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'ملف مرفق'); }
  catch { return url.split('/').pop() || 'ملف مرفق'; }
};

// multer hands over the original file name decoded as latin1, which garbles Arabic names: re-decode as UTF-8 when that is lossless.
const decodeUploadedName = (name: string) => {
  const fixed = Buffer.from(name || '', 'latin1').toString('utf8');
  return fixed.includes('\uFFFD') ? name : fixed;
};

// Normalize a single file entry from StageDelivery.files (String[]).
// Entries can be: (a) JSON-stringified objects {name,url,type,size}, or (b) plain URL strings (legacy).
// Always returns { name, url, type?, size? }.
const normalizeFileEntry = (entry: string): { name: string; url: string; type?: string; size?: number } => {
  if (typeof entry !== 'string') return { name: 'ملف مرفق', url: '' };
  const trimmed = entry.trim();
  // Try parsing as JSON object first
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return {
        name: obj.name || obj.fileName || (obj.url ? nameFromUrl(obj.url) : 'ملف مرفق'),
        url: obj.url || obj.fileUrl || obj.file_url || '',
        type: obj.type || obj.mimeType || undefined,
        size: typeof obj.size === 'number' ? obj.size : undefined
      };
    } catch { /* fall through to URL handling */ }
  }
  // Legacy: plain URL string
  return { name: nameFromUrl(trimmed), url: trimmed };
};

// Batch 5 — advisory-only delivery AI review. This never approves/rejects a
// delivery, releases/holds payment, or changes any status — the existing
// reviewDelivery()/submitDelivery() methods above remain the sole authority
// on all of that. Zero DB writes; generated on demand, never persisted.
export interface DeliveryAiReview {
  summary: string;
  alignedPoints: string[];
  potentialGaps: string[];
  questionsForReviewer: string[];
  reviewedInputs: {
    deliveryText: boolean;
    stageRequirements: boolean;
    // Always false in this v1 — file content is never fetched/inspected,
    // only filename/type/size metadata. Set exclusively by application
    // code below.
    attachmentContent: boolean;
  };
}


// Batch 8 — advisory-only project health analysis (currently DISABLED, see
// getProjectHealthAnalysis below). Replaces the
// permanent aiInsights placeholder (confidence:0/riskLevel:'غير محسوبة'/
// bullets:[]) that getProjectProgress() has always returned. This single
// capability covers Contract Monitoring, Project Health, Predictive Delay
// Risk, and Predictive Dispute Risk — one real feature, not four. Read-only:
// zero DB writes. Nothing here can release/hold funds, approve/reject a
// delivery, resolve a dispute, or change any status — those remain the sole
// authority of reviewDelivery()/dispute resolution/contract management,
// exactly as with getDeliveryAiReview() above.
export interface ProjectHealthAnalysis {
  confidence: number | null;
  riskLevel: string;
  riskLevelKey: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  healthRating: string;
  bullets: string[];
  // Real, deterministic: positive = ahead of the
  // planned schedule, negative = behind. null only in the "not enough data
  // yet" short-circuit below.
  earlyDays: number | null;
  // Never applicable to project health (there is no real "match percentage"
  // concept here) — always null. Preserved only so the existing frontend
  // aiInsights contract (and its "—" fallback rendering) needs no change.
  matchPercentage: null;
}

/** True when the stage list is a valid split of the contract: unique positive step orders, amounts add up to the price and percentages to 100 (tolerance 0.01). */
export function stagesMatchContract(list: Array<{ stepOrder?: number | null; amount?: unknown; percentage?: unknown }>, price: number): boolean {
  if (!list.length || !(price > 0)) return false;
  const orders = list.map((x, i) => Number(x.stepOrder || i + 1));
  if (new Set(orders).size !== orders.length || orders.some(o => !Number.isInteger(o) || o < 1)) return false;
  const amount = list.reduce((sum, x) => sum + Number(x.amount ?? NaN), 0);
  const pct = list.reduce((sum, x) => sum + Number(x.percentage ?? NaN), 0);
  return Number.isFinite(amount) && Number.isFinite(pct) && Math.abs(amount - price) <= 0.01 && Math.abs(pct - 100) <= 0.01;
}

export class ProjectProgressService {
  /** Single source of the contract's stage rows: creates them from the accepted offer's milestones (or one final stage) when none exist yet. Shared by the progress endpoint and the provider lists. */
  /**
   * Creates the stage rows of a contract that has none yet. Safe to call from several requests at once: the rows are written by ONE atomic createMany and
   * (contractId, stepOrder) is unique, so a concurrent caller that lost the race gets P2002 (swallowed) and nothing is duplicated; a contract that already has ANY
   * stage is never touched. The stages must add up to the contract: amounts == contract.price and percentages == 100 (tolerance 0.01); the frozen contract terms
   * are preferred over the offer's milestones, and when neither adds up the contract falls back to ONE stage worth the whole price (never an inconsistent split).
   */
  async ensureStages(contractId: string) {
    const found = await prisma.projectStage.findMany({ where: { contractId }, orderBy: { stepOrder: 'asc' } });
    if (found.length) return;
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { project: true } });
    if (!contract) throw new AppError('العقد غير موجود', 404);
    const proposal = contract.offerId
      ? await prisma.projectProposal.findUnique({ where: { id: contract.offerId }, include: { milestones: { orderBy: { stepOrder: 'asc' } } } })
      : await prisma.projectProposal.findFirst({ where: { projectId: contract.projectId, providerId: contract.providerId }, include: { milestones: { orderBy: { stepOrder: 'asc' } } } });
    const frozen = Array.isArray((contract.terms as any)?.milestones) ? ((contract.terms as any).milestones as any[]) : [];
    const candidates = [frozen, proposal?.milestones ?? []].filter(list => list.length > 0);
    const source = candidates.find(list => stagesMatchContract(list, contract.price)) ?? null;
    if (candidates.length && !source) console.warn(`[ensureStages] contract ${contractId}: milestones do not add up to the price (${contract.price}); using one stage for the whole price`);
    const items = source ?? [{
      stepOrder: 1, title: 'تسليم المشروع النهائي', description: contract.project.description,
      days: contract.durationDays, percentage: 100, amount: contract.price
    }];
    try {
      await prisma.projectStage.createMany({ data: items.map((item: any, index: number) => ({
        contractId, stepOrder: item.stepOrder || index + 1, title: item.title, description: item.description,
        days: item.days, percentage: item.percentage, amount: item.amount,
        status: index === 0 && contract.status === ContractStatus.ACTIVE ? ProjectStageStatus.IN_PROGRESS : ProjectStageStatus.PENDING,
        startedAt: index === 0 && contract.status === ContractStatus.ACTIVE ? (contract.signedAt || new Date()) : null
      })) });
    } catch (error: any) { if (error?.code !== 'P2002') throw error; }
  }

  async getProjectProgress(userId: string, key: string) {
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ projectId: key }, { id: key }], AND: [{ OR: [{ providerId: userId }, { clientId: userId }] }] },
      include: {
        project: { include: { escrow: true, conversations: { include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, firstName: true, lastName: true } } } } } }, assignedEmployee: { select: { id: true, name: true, jobTitle: true } } } },
        client: { select: { id: true, firstName: true, lastName: true } },
        provider: { select: { id: true, firstName: true, lastName: true } }
      }
    });
    if (!contract) {
      // No contract yet (e.g. PENDING_SIGNATURE before contract creation).
      // Fall back to a Project lookup so the client can still open the workspace
      // and see the pre-contract state. Ownership is still enforced via clientId.
      const project = await prisma.project.findFirst({
        where: { id: key, clientId: userId },
        include: {
          escrow: true,
          proposals: { where: { status: { in: ['ACCEPTED', 'PENDING_SIGNATURE'] } }, include: { provider: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 1 },
          assignedEmployee: { select: { id: true, name: true, jobTitle: true } }
        }
      });
      if (!project) throw new AppError('المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);
      const acceptedProp = project.proposals?.[0] || null;
      const providerUser = acceptedProp?.provider || null;
      const providerName = providerUser ? `${providerUser.firstName || ''} ${providerUser.lastName || ''}`.trim() : 'مقدم الخدمة';
      return {
        id: null, projectId: project.id, role: 'client', conversationId: null,
        title: project.title, clientName: providerName, clientInitial: providerName.charAt(0) || 'م',
        contractRef: `CT-${project.id.slice(0, 6).toUpperCase()}`,
        price: acceptedProp ? Number(acceptedProp.price || 0) : 0, durationDays: project.deliveryDays || 0,
        daysLeft: project.deliveryDays || 0, progress: 0,
        // Money counts as held only while the escrow row is really HELD.
        escrowTotal: project.escrow?.amount || 0, escrowHeld: project.escrow?.status === 'HELD' ? project.escrow.amount : 0, escrowReleased: 0,
        status: 'PENDING_SIGNATURE', statusLabel: project.escrow?.status === 'HELD' ? 'بانتظار توقيع مقدم الخدمة' : 'بانتظار توقيعك وإيداع الضمان',
        contractStatus: null, escrowStatus: project.escrow?.status || null, escrowFunded: project.escrow?.status === 'HELD', disputeStatus: null,
        canUploadDelivery: false, canSubmitDelivery: false, uploadBlockedReason: 'لا يوجد عقد بعد، ولا يمكن التسليم قبل توقيعه',
        awaitingClientReview: false, revisionRequested: false, revisionResubmitted: false,
        employee: project.assignedEmployee ? { id: project.assignedEmployee.id, name: project.assignedEmployee.name, jobTitle: project.assignedEmployee.jobTitle } : null,
        stages: [], deliveries: [], edits: [], messages: [], files: [],
        aiInsights: { confidence: null, earlyDays: null, matchPercentage: null, riskLevel: 'غير محسوبة', riskLevelKey: 'unknown', healthRating: 'بانتظار بيانات كافية', bullets: [] }
      };
    }
    await this.ensureStages(contract.id);
    // Stage reviews are always written by the client. When the provider calls this endpoint,
    // userId is the provider's id, so filtering by clientId: userId would return empty.
    // Resolve the actual reviewer id (the contract's client) so both sides see the rating.
    const reviewerId = contract.providerId === userId ? contract.clientId : userId;
    const persisted = await prisma.projectStage.findMany({ where: { contractId: contract.id }, orderBy: { stepOrder: 'asc' }, include: { deliveries: { orderBy: { submittedAt: 'asc' } }, stageReviews: { where: { clientId: reviewerId } } } });
    const role = contract.providerId === userId ? 'provider' : 'client';
    const other = role === 'provider' ? contract.client : contract.provider;
    const otherName = `${other.firstName || (role === 'provider' ? 'العميل' : 'مقدم الخدمة')} ${other.lastName || ''}`.trim();
    // The project's own message room (bound to this contract and its two parties): idempotent get-or-create, never a new conversation per visit. An old shared room
    // of the same project and parties keeps being used as is until the approved backfill (see project-conversation.service).
    const room = await ensureProjectRoom(prisma, contract, contract.project.conversations);
    const loaded = contract.project.conversations.find(c => c.id === room.id);
    const conversation = loaded ?? { id: room.id, messages: await prisma.message.findMany({ where: { conversationId: room.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { sender: { select: { id: true, firstName: true, lastName: true } } } }) };
    const unreadMessages = (conversation.messages || []).filter(m => m.senderId !== userId && m.status !== 'READ').length;
    const released = contract.project.escrow?.releasedAmount || 0;
    const [openDispute, activeDisputeCount] = await Promise.all([getActiveDisputeForProject(contract.projectId, prisma), countActiveDisputes(contract.projectId, prisma)]);
    const disputeFreeze = freezeStateOf(activeDisputeCount, openDispute);
    // Derived end state: closed by an admin financial dispute decision (nothing stored, progress still counts only approved stages).
    const settlement = await adminSettlementFor({ projectId: contract.projectId });
    const state = contractDeliveryState(contract.status, persisted, contract.project.escrow, openDispute?.status || null);
    const escrow = escrowFacts(contract.project.escrow);
    // THE lifecycle (single source of truth, see project-lifecycle.service): state, closure, money and per-action eligibility with specific reasons.
    const lifecycleInput = { viewer: { role: role as 'client' | 'provider', isOwner: true }, contractStatus: contract.status, contractPrice: contract.price, escrow: contract.project.escrow, stages: persisted, activeDisputes: { count: activeDisputeCount, latestId: openDispute?.id ?? null, latestStatus: openDispute?.status ?? null }, settlement, settlementDistribution: settlement.settled ? await settlementDistributionOf(settlement.disputeId, adminAudit) : null };
    const lifecycle = computeLifecycle(lifecycleInput);
    const lifecycleStage = new Map(lifecycle.stages.map(s => [s.stageId, s]));
    // Contract-level approval gate (any role's view): is approving a delivered stage possible right now, and if not, why.
    const approveProbe = evaluateAction({ ...lifecycleInput, viewer: { role: 'client', isOwner: true } }, 'approve', { id: 'probe', stepOrder: 1, status: 'SUBMITTED', amount: 0, deliveries: [{ status: 'SUBMITTED' }] });
    // Only the provider uploads; the client side of this shared endpoint never gets an upload permission.
    const mayUpload = role === 'provider';
    const stages = persisted.map(stage => {
      const [status, statusText0] = stageLabels[stage.status];
      const ss = stageDeliveryState(contract.status, stage);
      const statusText = settlement.settled && lifecycleStage.get(stage.id)?.closedBySettlement ? SETTLED_STAGE_LABEL_AR : ss.revisionResubmitted ? 'أُعيد التسليم، بانتظار مراجعة العميل' : statusText0;
      const stageReview = (stage as any).stageReviews?.[0] || null;
      return {
        id: stage.id, stageNumber: stage.stepOrder, title: stage.title, description: stage.description,
        amount: stage.amount, percentage: stage.percentage, days: stage.days,
        isDone: stage.status === ProjectStageStatus.APPROVED,
        isWait: !settlement.settled && (stage.status === ProjectStageStatus.IN_PROGRESS || stage.status === ProjectStageStatus.SUBMITTED || stage.status === ProjectStageStatus.REVISION_REQUESTED),
        status, statusText, completedDate: stage.approvedAt, roundsCount: stage.deliveries.length,
        ...stageDisplayStatus(stage.status, settlement.settled),
        ...ss, canUploadDelivery: lifecycleStage.get(stage.id)!.eligibility.upload.allowed, canSubmitDelivery: lifecycleStage.get(stage.id)!.eligibility.submit.allowed,
        uploadBlockedReason: lifecycleStage.get(stage.id)!.eligibility.upload.reason,
        lifecycle: lifecycleStage.get(stage.id),
        // The stage amount is "held" only while a funded escrow still holds it: never for a stage a settlement closed (its value is historical).
        amountHeld: lifecycleStage.get(stage.id)!.amountState === 'HELD',
        hasClientRating: !!stageReview,
        clientRating: stageReview?.rating || null,
        clientRatingComment: stageReview?.comment || null,
        threads: stage.deliveries.map((delivery, index) => ({
          id: delivery.id, author: role === 'provider' ? 'أنت' : `${contract.provider.firstName || 'مقدم الخدمة'} ${contract.provider.lastName || ''}`.trim(),
          authorInitial: contract.provider.firstName?.charAt(0) || 'م', isMe: role === 'provider', tag: `التسليم ${index + 1}`,
          isRedo: index > 0, date: delivery.submittedAt, note: delivery.note,
          files: delivery.files.map(url => normalizeFileEntry(url)), reviewNote: delivery.reviewNote, deliveryStatus: delivery.status
        }))
      };
    });
    const deliveries = persisted.flatMap(stage => stage.deliveries.map((delivery, index) => {
      const [status, statusText] = deliveryLabels[delivery.status];
      return { id: delivery.id, stageId: stage.id, stageTitle: stage.title, stageNumber: stage.stepOrder,
        title: stage.title, status, statusText, submittedAt: delivery.submittedAt, roundText: `التسليم ${index + 1}`,
        summary: delivery.note, reviewNote: delivery.reviewNote, files: delivery.files.map(url => normalizeFileEntry(url)) };
    }));
    const messages = [...(conversation?.messages || [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)).map(message => ({
      id: message.id, type: message.type, isEvent: message.type === 'SYSTEM', eventKey: (message as any).eventKey ?? null, senderName: message.senderId === userId ? 'أنت' : `${message.sender.firstName || otherName} ${message.sender.lastName || ''}`.trim(),
      senderInitial: (message.sender.firstName || otherName).charAt(0), senderRole: message.senderId === contract.providerId ? 'provider' : 'client',
      isMe: message.senderId === userId, time: message.createdAt, content: message.content || message.fileName || 'مرفق', fileUrl: message.fileUrl, fileName: message.fileName
    }));
    const progress = Math.min(100, Math.round(persisted.filter(s => s.status === ProjectStageStatus.APPROVED).reduce((sum, s) => sum + s.percentage, 0)));
    const elapsed = Math.max(0, Math.floor((Date.now() - (contract.signedAt || contract.createdAt).getTime()) / 86400000));
    // Provider → Client final rating status (for provider-side read-only display).
    // A final project rating by the provider has stageId = null and is written by the provider.
    let providerClientRating: { hasRated: boolean; rating: number | null; comment: string | null; ratedAt: string | null } = {
      hasRated: false, rating: null, comment: null, ratedAt: null
    };
    if (role === 'provider') {
      const existingReview = await prisma.review.findFirst({
        where: { providerId: userId, projectId: contract.projectId, stageId: null, clientId: contract.clientId, reviewerRole: 'PROVIDER' },
        select: { rating: true, comment: true, createdAt: true }
      });
      if (existingReview) {
        providerClientRating = {
          hasRated: true,
          rating: existingReview.rating,
          comment: existingReview.comment || null,
          ratedAt: existingReview.createdAt ? existingReview.createdAt.toISOString() : null
        };
      }
    }

    return {
      id: contract.id, projectId: contract.projectId, role, conversationId: conversation?.id || null, messageContext: room.kind === 'PROJECT' ? 'PROJECT' : 'GENERAL', legacyShared: room.legacyShared, unreadMessages,
      title: contract.project.title, clientName: otherName, clientInitial: otherName.charAt(0) || 'ع', contractRef: `CT-${contract.id.slice(0, 6).toUpperCase()}`,
      price: contract.price, durationDays: contract.durationDays, daysLeft: Math.max(0, contract.durationDays - elapsed), progress,
      // escrowReleased = money released through STAGE APPROVALS only; for a settled project the settlement's own release is in financial.settlement (never mixed).
      escrowTotal: contract.project.escrow?.amount || contract.price, escrowHeld: lifecycle.financial.heldNow, escrowReleased: lifecycle.financial.releasedByStageApprovals,
      ...state, canUploadDelivery: lifecycle.eligibility.upload.allowed, canSubmitDelivery: lifecycle.eligibility.submit.allowed,
      uploadBlockedReason: lifecycle.eligibility.upload.reason,
      lifecycle, financial: lifecycle.financial, operationalStatus: lifecycle.operationalStatus, closureReason: lifecycle.closureReason, completedByDelivery: lifecycle.completedByDelivery, closedBySettlement: lifecycle.closedBySettlement, hasActiveDispute: lifecycle.hasActiveDispute, eligibility: lifecycle.eligibility,
      // Dispute freeze (read model shared by both apps): approvals and releases are refused by the backend while `frozen`; the screens show `reason`.
      disputeFreeze, activeDisputeCount: disputeFreeze.activeDisputeCount, activeDisputeId: disputeFreeze.disputeId, canApproveStage: approveProbe.allowed, approvalBlockedReason: approveProbe.reason,
      status: contract.status, statusLabel: settlement.settled ? SETTLED_LABEL_AR : (role === 'client' ? clientContractStatusLabel(contract.status, escrow.escrowFunded) : (contractStatusLabel[contract.status] || 'غير نشط')),
      adminSettled: adminSettledView(settlement),
      employee: contract.project.assignedEmployee ? { id: contract.project.assignedEmployee.id, name: contract.project.assignedEmployee.name, jobTitle: contract.project.assignedEmployee.jobTitle } : null,
      stages, deliveries,
      edits: persisted.flatMap(stage => stage.deliveries.map((delivery, index) => ({ stage, delivery, index }))
        .filter(({ delivery }) => delivery.status === StageDeliveryStatus.REVISION_REQUESTED)
        .map(({ stage, delivery, index }) => {
          const ss = stageDeliveryState(contract.status, stage);
          return { id: delivery.id, stageId: stage.id, stageTitle: stage.title, title: `ملاحظات على ${stage.title}`, clientNotes: delivery.reviewNote || '',
            ...editState(stage.status, index, stage.deliveries.length), canUploadDelivery: mayUpload && ss.canUploadDelivery, uploadBlockedReason: ss.uploadBlockedReason, createdAt: delivery.submittedAt };
        })),
      messages,
      files: persisted.filter(s => s.deliveries.some(d => d.files.length)).map(s => ({ groupTitle: s.title, isDone: s.status === ProjectStageStatus.APPROVED, files: s.deliveries.flatMap(d => d.files.map(url => normalizeFileEntry(url))) })),
      providerClientRating: { ...providerClientRating, canRate: contract.status === ContractStatus.COMPLETED && !providerClientRating.hasRated && !settlement.settled },
      aiInsights: { confidence: null, earlyDays: null, matchPercentage: null, riskLevel: 'غير محسوبة', riskLevelKey: 'unknown', healthRating: 'بانتظار بيانات كافية', bullets: [] }
    };
  }

  // Stages awaiting THIS client's review decision, across all of their active
  // contracts. "Reviewable" is defined identically to reviewDelivery()'s own
  // guard below (stage.status === SUBMITTED AND the latest delivery for that
  // stage is itself still SUBMITTED) so this list can never show an item that
  // the real approve/revision endpoint would then reject as stale.
  async getPendingReviewDeliveries(clientId: string) {
    const stages = await prisma.projectStage.findMany({
      where: {
        status: ProjectStageStatus.SUBMITTED,
        contract: { clientId, status: ContractStatus.ACTIVE }
      },
      orderBy: [{ contract: { updatedAt: 'desc' } }, { stepOrder: 'asc' }],
      include: {
        contract: {
          select: {
            id: true,
            projectId: true,
            project: { select: { title: true } },
            provider: { select: { firstName: true, lastName: true } }
          }
        },
        deliveries: { orderBy: { submittedAt: 'desc' }, take: 1 }
      }
    });

    // Projects of these stages that are frozen by an open dispute (approval is refused by the backend; the list says so instead of offering it).
    const projectIds = [...new Set(stages.map(stage => stage.contract.projectId))];
    const frozenRows = projectIds.length
      ? await prisma.dispute.findMany({ where: { status: { in: ACTIVE_DISPUTE_STATUSES }, OR: [{ projectId: { in: projectIds } }, { requestId: { in: projectIds } }] }, select: { projectId: true, requestId: true } })
      : [];
    const frozenProjects = new Set(frozenRows.map(r => r.projectId ?? r.requestId));

    return stages
      .filter(stage => stage.deliveries[0]?.status === StageDeliveryStatus.SUBMITTED)
      .map(stage => {
        const delivery = stage.deliveries[0];
        const provider = stage.contract.provider;
        return {
          projectId: stage.contract.projectId,
          projectTitle: stage.contract.project.title,
          stageId: stage.id,
          stageNumber: stage.stepOrder,
          stageTitle: stage.title,
          amount: stage.amount,
          submittedAt: delivery.submittedAt,
          providerName: `${provider.firstName || 'مقدم الخدمة'} ${provider.lastName || ''}`.trim(),
          filesCount: delivery.files.length,
          contractRef: `CT-${stage.contract.id.slice(0, 6).toUpperCase()}`,
          frozen: frozenProjects.has(stage.contract.projectId),
          approvalBlockedReason: frozenProjects.has(stage.contract.projectId) ? PROJECT_FROZEN_MESSAGE : null
        };
      });
  }

  // Shared by the upload endpoint and the delivery itself. Ownership is the only 403; everything else comes from the ONE lifecycle evaluation
  // (settled / ended contract / stage not open ... each with its own Arabic reason and a 409 / 423).
  private async assertDeliverable(providerId: string, key: string, stageId: string, action: 'upload' | 'submit' = 'upload') {
    const contract = await prisma.contract.findFirst({ where: { OR: [{ id: key }, { projectId: key }], providerId } });
    // The stage rows are created lazily, but never for a contract that cannot deliver anyway.
    if (contract && contract.status === ContractStatus.ACTIVE) await this.ensureStages(contract.id);
    const stage = contract ? await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contract.id } }) : null;
    await assertStageActionAllowed({ role: 'provider', userId: providerId, action, contract, stage, db: prisma });
    return { contract: contract!, stage: stage! };
  }

  // Real upload of delivery files (the delivery used to record picked file NAMES only). Authorisation and stage state are checked BEFORE anything
  // is stored; every file goes to this provider's folder for this stage, which is exactly what validateDeliveryArtifacts() later requires.
  async uploadDeliveryFiles(providerId: string, key: string, stageId: string, files: Express.Multer.File[]) {
    if (!files?.length) throw new AppError('اختر ملفاً واحداً على الأقل للرفع', 400);
    if (files.length > DELIVERY_MAX_UPLOADED_FILES) throw new AppError(`الحد الأقصى ${DELIVERY_MAX_UPLOADED_FILES} ملفات`, 400);
    const { stage } = await this.assertDeliverable(providerId, key, stageId, 'upload');
    const stored = await Promise.all(files.map(file => uploadMulterFile({ ...file, originalname: decodeUploadedName(file.originalname) } as Express.Multer.File, deliveryFolder(providerId, stage.id), DELIVERY_MAX_FILE_BYTES)));
    return stored.map(f => ({ name: f.fileName, url: f.url, type: f.mimeType, size: f.bytes }));
  }

  async submitDelivery(providerId: string, key: string, stageId: string, note: string, files: any[]) {
    if (!note?.trim() || note.trim().length < 10) throw new AppError('أضف وصفاً واضحاً للتسليم (10 أحرف على الأقل)', 400);
    // At least one REAL artifact (an uploaded file of this stage, or an https link). File names alone are refused.
    const safeFiles = validateDeliveryArtifacts(providerId, stageId, files);
    const { contract, stage } = await this.assertDeliverable(providerId, key, stageId, 'submit');
    let clientNotificationId: string | null = null;
    const created = await prisma.$transaction(async tx => {
      // Phase 4 — conditional, row-locked transition taken BEFORE the delivery
      // row is written: a double-click / concurrent second submit (or a stage
      // that left IN_PROGRESS/REVISION_REQUESTED meanwhile) matches zero rows
      // and creates no duplicate StageDelivery. Also re-checks the contract is
      // still ACTIVE inside the same transaction.
      const submitted = await tx.projectStage.updateMany({
        where: {
          id: stageId,
          contractId: contract.id,
          status: { in: [ProjectStageStatus.IN_PROGRESS, ProjectStageStatus.REVISION_REQUESTED] },
          contract: { status: ContractStatus.ACTIVE }
        },
        data: { status: ProjectStageStatus.SUBMITTED }
      });
      if (submitted.count !== 1) throw new AppError('هذه المرحلة غير متاحة للتسليم حالياً', 409);
      const delivery = await tx.stageDelivery.create({ data: { stageId, providerId, note: note.trim(), files: safeFiles } });
      console.log('[submitDelivery] created delivery id:', delivery.id, 'files:', JSON.stringify(delivery.files));
      await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.AWAITING_DELIVERY } });
      clientNotificationId = (await tx.notification.create({ data: clientNotificationFor.stageDelivered({ clientId: contract.clientId, projectId: contract.projectId, stageId, stageTitle: stage.title, deliveryId: delivery.id }) })).id;
      return delivery;
    });
    // The client is told through their saved channels (in-app push / e-mail) once the delivery is committed.
    await clientNotifications.deliverStored([clientNotificationId]);
    return created;
  }

  async reviewDelivery(clientId: string, key: string, stageId: string, decision: string, note?: string) {
    if (!['approve', 'revision'].includes(decision)) throw new AppError('قرار المراجعة غير صالح', 400);
    if (decision === 'revision' && (!note?.trim() || note.trim().length < 10)) throw new AppError('اكتب ملاحظات التعديل بوضوح', 400);
    const contractRow = await prisma.contract.findFirst({
      where: { OR: [{ id: key }, { projectId: key }], clientId },
      include: {
        project: { select: { title: true } },
        provider: { select: { firstName: true, lastName: true, email: true } }
      }
    });
    const stageRow = contractRow ? await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contractRow.id }, include: { deliveries: { orderBy: { submittedAt: 'desc' }, take: 1 } } }) : null;
    // ONE lifecycle evaluation: not the owner = 403; settled / ended contract / stage not delivered / already decided = 409 with the specific reason; open dispute (approve) = 423.
    await assertStageActionAllowed({ role: 'client', userId: clientId, action: decision === 'approve' ? 'approve' : 'requestRevision', contract: contractRow, stage: stageRow, db: prisma });
    const contract = contractRow!;
    const stage = stageRow!;
    const delivery = stage.deliveries[0];
    const result = await prisma.$transaction(async tx => {
      let isProjectCompleted = false;
      const commissionNotices: MarketerCommissionNotice[] = [];
      // Same lock as an amendment being applied (contract row FIRST, then stages / escrow): a stage approval and an amendment on the same contract never interleave,
      // and the price used by the final release is the committed one, not the value read before the transaction.
      const contractLock = await tx.contract.updateMany({ where: { id: contract.id, status: ContractStatus.ACTIVE }, data: { updatedAt: new Date() } });
      if (contractLock.count !== 1) throw new AppError('تغيّرت حالة العقد أثناء المراجعة ولم يعد نشطًا. حدّث الصفحة', 409);
      const livePrice = (await tx.contract.findUnique({ where: { id: contract.id }, select: { price: true } }))?.price ?? contract.price;
      if (decision === 'approve') {
        // Dispute freeze, authoritative: take the contract row lock (the same one createForRequest takes when a dispute is opened), THEN read the
        // disputes. A dispute opened concurrently either commits first (this approval is refused) or waits for this transaction (the approval and
        // its release are complete before the dispute exists). No money can be released past an open dispute.
        if (!(await lockProjectForFreezeCheck(tx, contract.projectId))) throw new AppError('تغيّرت حالة العقد أثناء المراجعة ولم يعد نشطًا. حدّث الصفحة', 409);
        await assertProjectNotFrozen(contract.projectId, tx);
      }
      if (decision === 'revision') {
        // Guarded the same way the approve path below is: an unconditional
        // update-by-id here would let a request that raced past the
        // outside-transaction pre-read above silently revert a stage a
        // concurrent 'approve' had already moved to APPROVED (and already
        // released escrow for) back to REVISION_REQUESTED. The WHERE clause
        // is re-evaluated against the latest committed row once Postgres
        // grants this UPDATE its lock, so the loser of any race correctly
        // sees the already-transitioned status and matches zero rows.
        const revisionTransition = await tx.projectStage.updateMany({
          where: { id: stage.id, status: ProjectStageStatus.SUBMITTED },
          data: { status: ProjectStageStatus.REVISION_REQUESTED }
        });
        if (revisionTransition.count !== 1) throw new AppError('لا يوجد تسليم جديد بانتظار المراجعة لهذه المرحلة', 409);
        await tx.stageDelivery.update({ where: { id: delivery.id }, data: { status: StageDeliveryStatus.REVISION_REQUESTED, reviewNote: note!.trim(), reviewedAt: new Date() } });
        await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.IN_PROGRESS } });
      } else {
        // The DB-enforced gate for the whole approve path, and the fix for
        // the double-release race: only the request that actually flips
        // SUBMITTED -> APPROVED here is allowed to touch the delivery record
        // or release escrow. Two concurrent approvals for the same stage
        // both start from the same outside-transaction pre-read, but only
        // one of their UPDATEs can win the row lock; the other's WHERE
        // clause is re-checked against the now-APPROVED row once unblocked
        // and matches zero rows, so it stops here with no side effects at
        // all — never touching StageDelivery or Escrow.
        const stageTransition = await tx.projectStage.updateMany({
          where: { id: stage.id, status: ProjectStageStatus.SUBMITTED },
          data: { status: ProjectStageStatus.APPROVED, approvedAt: new Date() }
        });
        if (stageTransition.count !== 1) throw new AppError('لا يوجد تسليم جديد بانتظار المراجعة لهذه المرحلة', 409);
        await tx.stageDelivery.update({ where: { id: delivery.id }, data: { status: StageDeliveryStatus.APPROVED, reviewNote: note?.trim() || null, reviewedAt: new Date() } });
        const next = await tx.projectStage.findFirst({ where: { contractId: contract.id, stepOrder: { gt: stage.stepOrder } }, orderBy: { stepOrder: 'asc' } });
        if (next) {
          await tx.projectStage.update({ where: { id: next.id }, data: { status: ProjectStageStatus.IN_PROGRESS, startedAt: new Date() } });
          await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.IN_PROGRESS } });
          // Fee policy v2: a v2 escrow releases the stage net of the provider's snapshotted commission; a legacy escrow releases gross exactly as before.
          const intermediateEscrow = await tx.escrow.findUnique({ where: { projectId: contract.projectId } });
          const intermediateSplit = isV2Escrow(intermediateEscrow) && intermediateEscrow!.providerCommissionRateSnapshot != null
            ? splitRelease({ grossReleasedBefore: intermediateEscrow!.releasedAmount, commissionTotalBefore: intermediateEscrow!.platformCommissionAmount, grossReleasedAfter: intermediateEscrow!.releasedAmount + stage.amount, ratePercent: intermediateEscrow!.providerCommissionRateSnapshot })
            : null;
          if (intermediateSplit) {
            await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: { releasedAmount: intermediateSplit.grossReleasedAfter, platformCommissionAmount: intermediateSplit.commissionTotalAfter, providerNetReleasedAmount: intermediateSplit.netReleasedAfter } });
          } else {
            await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: { releasedAmount: { increment: stage.amount } } });
          }
          // Durable audit trail for the fund release itself — the stage/
          // delivery status transitions above record WHAT happened, this
          // records the financial event specifically, in the same shape
          // paypal-finance.service.ts's creditWalletForCapture() already
          // uses for deposit-side release events. Written against the
          // provider (the party whose computed balance just moved), with
          // the approving client and full project/contract/stage context
          // in metaData for correlation. Same transaction as the escrow
          // mutation above, so both commit or roll back together.
          await tx.accountAuditLog.create({
            data: {
              userId: contract.providerId,
              category: LogCategory.SYSTEM_AUDIT,
              title: 'إفراج دفعة مرحلة',
              actionText: `اعتماد العميل لمرحلة "${stage.title}" وإفراج ${stage.amount} دولار من ضمان المشروع`,
              status: LogStatus.COMPLETED,
              statusText: 'مكتمل بنجاح',
              summary: `اعتمد العميل تسليم المرحلة "${stage.title}" في المشروع «${contract.project.title}»، وتم إفراج ${stage.amount} دولار من الضمان لصالح مقدم الخدمة.`,
              source: 'USER',
              eventType: 'STAGE_FUND_RELEASED',
              severity: 'INFO',
              metaData: {
                projectId: contract.projectId,
                contractId: contract.id,
                stageId: stage.id,
                stageTitle: stage.title,
                releasedAmount: stage.amount,
                ...(intermediateSplit ? { grossAmount: intermediateSplit.gross, platformCommission: intermediateSplit.commission, providerNet: intermediateSplit.net, commissionRatePercent: intermediateEscrow!.providerCommissionRateSnapshot, commissionLevel: intermediateEscrow!.providerCommissionLevelSnapshot, feePolicyVersion: 2 } : {}),
                currency: 'USD',
                isFinalStage: false,
                approvedByClientId: contract.clientId
              }
            }
          });
          // P-LG-012 affiliate commission hook — additive, same transaction
          // as the escrow release above (a commission is created atomically
          // with the fund release it's based on, never separately). A
          // complete no-op unless AFFILIATE_COMMISSION_ENGINE_ENABLED is
          // explicitly set to 'true' — see affiliate-commission-engine.util.ts
          // for the currency-gate reasoning behind why that stays off by
          // default. Uses stage.amount (not contract.price) as the
          // commissionable base — the same figure this same audit log's own
          // metaData.releasedAmount above already uses for "the amount
          // released at this specific step".
          commissionNotices.push(...(await createCommissionsForStageReleaseEvent(tx, {
            contract: { id: contract.id, projectId: contract.projectId, clientId: contract.clientId, providerId: contract.providerId },
            stageId: stage.id,
            releasedAmount: stage.amount
          }) ?? []));
        } else {
          isProjectCompleted = true;
          const completed = await tx.contract.updateMany({
            where: { id: contract.id, status: { not: ContractStatus.COMPLETED } },
            data: { status: ContractStatus.COMPLETED }
          });
          if (completed.count !== 1) throw new AppError('تم اعتماد المشروع النهائي مسبقاً', 409);
          await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.COMPLETED, providerId: contract.providerId } });
          const finalEscrow = await tx.escrow.findUnique({ where: { projectId: contract.projectId } });
          const finalSplit = isV2Escrow(finalEscrow) && finalEscrow!.providerCommissionRateSnapshot != null
            ? splitRelease({ grossReleasedBefore: finalEscrow!.releasedAmount, commissionTotalBefore: finalEscrow!.platformCommissionAmount, grossReleasedAfter: livePrice, ratePercent: finalEscrow!.providerCommissionRateSnapshot })
            : null;
          await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: finalSplit
            ? { status: EscrowStatus.RELEASED, releasedAmount: finalSplit.grossReleasedAfter, platformCommissionAmount: finalSplit.commissionTotalAfter, providerNetReleasedAmount: finalSplit.netReleasedAfter }
            : { status: EscrowStatus.RELEASED, releasedAmount: livePrice } });
          // Same durable audit-trail entry as the intermediate-stage branch
          // above, for the final stage's release — still the same
          // transaction as the contract-completion/escrow mutations.
          await tx.accountAuditLog.create({
            data: {
              userId: contract.providerId,
              category: LogCategory.SYSTEM_AUDIT,
              title: 'إفراج دفعة مرحلة',
              actionText: `اعتماد العميل للمرحلة النهائية "${stage.title}" وإفراج ${stage.amount} دولار من ضمان المشروع`,
              status: LogStatus.COMPLETED,
              statusText: 'مكتمل بنجاح',
              summary: `اعتمد العميل التسليم النهائي «${stage.title}» لمشروع «${contract.project.title}»، وتم إفراج ${stage.amount} دولار من الضمان لصالح مقدم الخدمة، وأُغلق العقد.`,
              source: 'USER',
              eventType: 'STAGE_FUND_RELEASED',
              severity: 'INFO',
              metaData: {
                projectId: contract.projectId,
                contractId: contract.id,
                stageId: stage.id,
                stageTitle: stage.title,
                releasedAmount: stage.amount,
                ...(finalSplit ? { grossAmount: finalSplit.gross, platformCommission: finalSplit.commission, providerNet: finalSplit.net, commissionRatePercent: finalEscrow!.providerCommissionRateSnapshot, commissionLevel: finalEscrow!.providerCommissionLevelSnapshot, feePolicyVersion: 2 } : {}),
                currency: 'USD',
                isFinalStage: true,
                approvedByClientId: contract.clientId
              }
            }
          });
          // P-LG-012 affiliate commission hook — same additive, same-
          // transaction pattern as the intermediate-stage branch above. Uses
          // stage.amount (the final stage's own slice of contract.price,
          // matching this branch's own audit-log metaData.releasedAmount
          // just above) rather than contract.price directly — contract.price
          // is the cumulative total already reflected via the escrow update's
          // `releasedAmount: contract.price` (a direct set, not an
          // increment), not the incremental amount released at this specific
          // final step.
          commissionNotices.push(...(await createCommissionsForStageReleaseEvent(tx, {
            contract: { id: contract.id, projectId: contract.projectId, clientId: contract.clientId, providerId: contract.providerId },
            stageId: stage.id,
            releasedAmount: stage.amount
          }) ?? []));
          await tx.clientRequest.updateMany({
            where: { proposals: { some: { projectId: contract.projectId } } },
            data: { status: RequestStatus.COMPLETED }
          });

          await tx.pointTransaction.create({
            data: {
              providerId: contract.providerId,
              amount: PROJECT_COMPLETION_POINTS,
              reason: 'PROJECT_COMPLETED',
              description: `إكمال مشروع بنجاح: ${contract.project.title} (${contract.id})`
            }
          });
          // Phase 3D.3A: avgRating is sourced the same way getLevelDetails()
          // already does — a live Review aggregate (CLIENT -> PROVIDER
          // reviews only) — not the ProviderGamification cache, which would
          // be a stale read of the very row this same block is about to
          // write. All three reads run inside this same transaction, so they
          // see this transaction's own already-committed PointTransaction.
          const [pointsAggregate, completedProjects, ratingAggregate] = await Promise.all([
            tx.pointTransaction.aggregate({ where: { providerId: contract.providerId }, _sum: { amount: true } }),
            tx.project.count({ where: deliveryCompletedProject({ providerId: contract.providerId }) }),
            tx.review.aggregate({ where: { providerId: contract.providerId, reviewerRole: 'CLIENT' }, _avg: { rating: true } })
          ]);
          const totalPoints = pointsAggregate._sum.amount || 0;
          const avgRating = Number(ratingAggregate._avg.rating || 0);
          const progression = deriveProviderProgression({ points: totalPoints, completedProjects, avgRating });
          await Promise.all([
            tx.user.update({ where: { id: contract.providerId }, data: { currentPoints: totalPoints } }),
            tx.providerGamification.upsert({
              where: { providerId: contract.providerId },
              update: {
                points: totalPoints,
                completedProjects,
                avgRating,
                currentLevelIndex: progression.currentLevelIndex,
                currentCommission: progression.currentCommission
              },
              create: {
                providerId: contract.providerId,
                points: totalPoints,
                completedProjects,
                avgRating,
                currentLevelIndex: progression.currentLevelIndex,
                currentCommission: progression.currentCommission
              }
            }),
            tx.gamificationRule.upsert({
              where: { code: 'GAIN_PROJECT_COMPLETE' },
              update: { points: PROJECT_COMPLETION_POINTS, label: 'إكمال مشروع بنجاح' },
              create: { code: 'GAIN_PROJECT_COMPLETE', type: 'GAIN', label: 'إكمال مشروع بنجاح', points: PROJECT_COMPLETION_POINTS }
            })
          ]);
        }
      }
      const notification = await tx.notification.create({
        data: {
          userId: contract.providerId,
          title: isProjectCompleted ? `🎉 اكتمل المشروع وربحت +${PROJECT_COMPLETION_POINTS} نقطة` : decision === 'approve' ? 'تم اعتماد التسليم' : 'مطلوب تعديل على التسليم',
          message: isProjectCompleted ? `وافق العميل على التسليم النهائي لمشروع «${contract.project.title}». تمت إضافة ${PROJECT_COMPLETION_POINTS} نقطة إلى رصيدك.` : decision === 'approve' ? `اعتمد العميل مرحلة: ${stage.title}` : note!.trim(),
          type: isProjectCompleted ? 'PROJECT_COMPLETION_REWARD' : 'STAGE_REVIEW',
          category: 'PROJECTS',
          // The real route is projects/active/progress/:id (there is no
          // projects/:id/progress route in the provider router).
          actionUrl: `/provider-overview/projects/active/progress/${contract.projectId}`,
          actionText: isProjectCompleted ? 'عرض المشروع والنقاط' : 'عرض المشروع',
          metadata: { projectId: contract.projectId, contractId: contract.id, stageId, decision, ...(isProjectCompleted ? { pointsAwarded: PROJECT_COMPLETION_POINTS } : {}) }
        }
      });
      // The client's own confirmation of the approval (the provider's notification above is about the same decision).
      const clientNotification = decision === 'approve'
        ? await tx.notification.create({ data: isProjectCompleted
          ? clientNotificationFor.projectCompleted({ clientId, projectId: contract.projectId, projectTitle: contract.project.title })
          : clientNotificationFor.stageApproved({ clientId, projectId: contract.projectId, stageId, stageTitle: stage.title, amount: stage.amount }) })
        : null;
      return {
        decision,
        stageId,
        notificationId: notification.id,
        clientNotificationId: clientNotification?.id ?? null,
        isProjectCompleted,
        commissionNotices,
        providerEmail: isProjectCompleted ? contract.provider.email : null,
        providerName: `${contract.provider.firstName || 'مقدم الخدمة'} ${contract.provider.lastName || ''}`.trim(),
        projectTitle: contract.project.title
      };
    });

    await clientNotifications.deliverStored([result.clientNotificationId]);
    await marketerNotifications.commissionsApproved(result.commissionNotices);
    await notificationService.emitStored(result.notificationId).catch(error => {
      console.error('[ProjectProgress] Failed to emit project review notification:', error);
    });
    if (result.isProjectCompleted && result.providerEmail) {
      await emailService.sendProjectCompletionRewardEmail({
        email: result.providerEmail,
        userId: contract.providerId,
        providerName: result.providerName,
        projectTitle: result.projectTitle,
        pointsAwarded: PROJECT_COMPLETION_POINTS,
        projectUrl: `/provider-overview/projects/active/progress/${contract.projectId}`
      });
    }
    return { decision: result.decision, stageId: result.stageId, pointsAwarded: result.isProjectCompleted ? PROJECT_COMPLETION_POINTS : 0 };
  }

  /**
   * Advisory review of a stage delivery through the internal LlmClient (see ai-features/delivery-review.service.ts). It never reads
   * file contents (names + extensions only), never approves/rejects and never writes: the manual approve / request-revision
   * workflow stays the sole authority. A real model answer grounded in the fields sent, or an explicit 503.
   */
  async getDeliveryAiReview(userId: string, key: string, stageId: string): Promise<DeliveryReviewResult> {
    return deliveryReviewService.review(userId, key, stageId);
  }

  /**
   * Advisory project health analysis through the internal LlmClient (see ai-features/project-health.service.ts): a real model
   * answer grounded in the stage/schedule/revision/dispute fields sent, or an explicit 503. Read-only, no DB write.
   */
  async getProjectHealthAnalysis(userId: string, key: string): Promise<ProjectHealthResult> {
    return projectHealthService.analyze(userId, key);
  }
}

export const projectProgressService = new ProjectProgressService();
