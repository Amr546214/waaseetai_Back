import { AmendmentStatus, ContractStatus, EscrowStatus, LogCategory, LogStatus, ProjectStageStatus, ProjectStatus, RequestStatus, StageDeliveryStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { notificationService } from './notification.service';
import { emailService } from './email.service';
import { deriveProviderProgression } from '../utils/progression-calculators';
import { projectHealthService, type ProjectHealthResult } from './ai-features/project-health.service';
import { deliveryReviewService, type DeliveryReviewResult } from './ai-features/delivery-review.service';
import { createCommissionsForStageReleaseEvent } from './affiliate-commission.service';

const PROJECT_COMPLETION_POINTS = 50;

const stageLabels: Record<string, [string, string]> = {
  PENDING: ['pending', 'لم تبدأ بعد'], IN_PROGRESS: ['in_progress', 'قيد التنفيذ'],
  SUBMITTED: ['submitted', 'بانتظار مراجعة العميل'], REVISION_REQUESTED: ['revision', 'مطلوب تعديل'],
  APPROVED: ['completed', 'مكتملة ومعتمدة']
};
const deliveryLabels: Record<string, [string, string]> = {
  SUBMITTED: ['pending', 'قيد مراجعة العميل'], REVISION_REQUESTED: ['notes', 'مطلوب تعديل'], APPROVED: ['approved', 'معتمد']
};
const nameFromUrl = (url: string) => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'ملف مرفق'); }
  catch { return url.split('/').pop() || 'ملف مرفق'; }
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

export class ProjectProgressService {
  private async ensureStages(contractId: string) {
    const found = await prisma.projectStage.findMany({ where: { contractId }, orderBy: { stepOrder: 'asc' } });
    if (found.length) return;
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { project: true } });
    if (!contract) throw new AppError('العقد غير موجود', 404);
    const proposal = contract.offerId
      ? await prisma.projectProposal.findUnique({ where: { id: contract.offerId }, include: { milestones: { orderBy: { stepOrder: 'asc' } } } })
      : await prisma.projectProposal.findFirst({ where: { projectId: contract.projectId, providerId: contract.providerId }, include: { milestones: { orderBy: { stepOrder: 'asc' } } } });
    const source = proposal?.milestones.length ? proposal.milestones : [{
      stepOrder: 1, title: 'تسليم المشروع النهائي', description: contract.project.description,
      days: contract.durationDays, percentage: 100, amount: contract.price
    }];
    try {
      await prisma.projectStage.createMany({ data: source.map((item, index) => ({
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
          proposals: { where: { status: 'ACCEPTED' }, include: { provider: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 1 },
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
        escrowTotal: project.escrow?.amount || 0, escrowHeld: project.escrow?.amount || 0, escrowReleased: 0,
        status: 'PENDING_SIGNATURE', statusLabel: 'بانتظار توقيع العقد',
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
    let conversation = contract.project.conversations.find(c => c.providerId === contract.providerId && c.clientId === contract.clientId);
    if (!conversation) {
      conversation = await prisma.conversation.upsert({
        where: { projectId_providerId: { projectId: contract.projectId, providerId: contract.providerId } },
        update: {},
        create: { projectId: contract.projectId, providerId: contract.providerId, clientId: contract.clientId, offerId: contract.offerId || null },
        include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, firstName: true, lastName: true } } } } }
      });
    }
    const released = contract.project.escrow?.releasedAmount || 0;
    const stages = persisted.map(stage => {
      const [status, statusText] = stageLabels[stage.status];
      const stageReview = (stage as any).stageReviews?.[0] || null;
      return {
        id: stage.id, stageNumber: stage.stepOrder, title: stage.title, description: stage.description,
        amount: stage.amount, percentage: stage.percentage, days: stage.days,
        isDone: stage.status === ProjectStageStatus.APPROVED,
        isWait: stage.status === ProjectStageStatus.IN_PROGRESS || stage.status === ProjectStageStatus.SUBMITTED || stage.status === ProjectStageStatus.REVISION_REQUESTED,
        status, statusText, completedDate: stage.approvedAt, roundsCount: stage.deliveries.length,
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
    const messages = (conversation?.messages || []).map(message => ({
      id: message.id, senderName: message.senderId === userId ? 'أنت' : `${message.sender.firstName || otherName} ${message.sender.lastName || ''}`.trim(),
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
      id: contract.id, projectId: contract.projectId, role, conversationId: conversation?.id || null,
      title: contract.project.title, clientName: otherName, clientInitial: otherName.charAt(0) || 'ع', contractRef: `CT-${contract.id.slice(0, 6).toUpperCase()}`,
      price: contract.price, durationDays: contract.durationDays, daysLeft: Math.max(0, contract.durationDays - elapsed), progress,
      escrowTotal: contract.project.escrow?.amount || contract.price, escrowHeld: Math.max(0, (contract.project.escrow?.amount || contract.price) - released), escrowReleased: released,
      status: contract.status, statusLabel: contract.status === ContractStatus.COMPLETED ? 'مكتمل' : contract.status === ContractStatus.ACTIVE ? 'مشروع نشط' : 'بانتظار بدء المشروع',
      employee: contract.project.assignedEmployee ? { id: contract.project.assignedEmployee.id, name: contract.project.assignedEmployee.name, jobTitle: contract.project.assignedEmployee.jobTitle } : null,
      stages, deliveries,
      edits: deliveries.filter(d => d.status === 'notes').map(d => ({ id: d.id, stageId: d.stageId, stageTitle: d.stageTitle, title: `ملاحظات على ${d.stageTitle}`, clientNotes: d.reviewNote || '', status: 'waiting', statusText: 'بانتظار إعادة التسليم', createdAt: d.submittedAt })),
      messages,
      files: persisted.filter(s => s.deliveries.some(d => d.files.length)).map(s => ({ groupTitle: s.title, isDone: s.status === ProjectStageStatus.APPROVED, files: s.deliveries.flatMap(d => d.files.map(url => normalizeFileEntry(url))) })),
      providerClientRating,
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
          contractRef: `CT-${stage.contract.id.slice(0, 6).toUpperCase()}`
        };
      });
  }

  async submitDelivery(providerId: string, key: string, stageId: string, note: string, files: any[]) {
    if (!note?.trim() || note.trim().length < 10) throw new AppError('أضف وصفاً واضحاً للتسليم (10 أحرف على الأقل)', 400);
    const contract = await prisma.contract.findFirst({ where: { OR: [{ id: key }, { projectId: key }], providerId } });
    if (!contract || contract.status !== ContractStatus.ACTIVE) throw new AppError('العقد غير نشط أو لا تملك صلاحية التسليم', 403);
    await this.ensureStages(contract.id);
    const stage = await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contract.id } });
    if (!stage || (stage.status !== ProjectStageStatus.IN_PROGRESS && stage.status !== ProjectStageStatus.REVISION_REQUESTED)) throw new AppError('هذه المرحلة غير متاحة للتسليم حالياً', 409);
    // Accept both file objects ({name,url,type,size}) and plain URL strings.
    // Serialize each entry to a JSON string for storage in String[] column.
    const safeFiles: string[] = Array.isArray(files)
      ? files
          .filter(v => v != null)
          .map(v => {
            if (typeof v === 'string') return v.trim() ? v.trim() : null;
            if (typeof v === 'object') {
              const url = v.url || v.fileUrl || v.file_url || '';
              if (!url) return null;
              return JSON.stringify({ name: v.name || v.fileName || nameFromUrl(url), url, type: v.type || v.mimeType || '', size: typeof v.size === 'number' ? v.size : 0 });
            }
            return null;
          })
          .filter((v): v is string => v !== null)
          .slice(0, 10)
      : [];
    console.log('[submitDelivery] safeFiles count:', safeFiles.length, 'sample:', safeFiles.slice(0, 2));
    return prisma.$transaction(async tx => {
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
      await tx.notification.create({ data: { userId: contract.clientId, title: 'تسليم جديد بانتظار مراجعتك', message: `تم تسليم مرحلة: ${stage.title}`, type: 'STAGE_DELIVERY', category: 'PROJECTS', actionUrl: `/client-overview/projects/${contract.projectId}`, metadata: { projectId: contract.projectId, stageId, deliveryId: delivery.id } } });
      return delivery;
    });
  }

  async reviewDelivery(clientId: string, key: string, stageId: string, decision: string, note?: string) {
    if (!['approve', 'revision'].includes(decision)) throw new AppError('قرار المراجعة غير صالح', 400);
    if (decision === 'revision' && (!note?.trim() || note.trim().length < 10)) throw new AppError('اكتب ملاحظات التعديل بوضوح', 400);
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ id: key }, { projectId: key }], clientId },
      include: {
        project: { select: { title: true } },
        provider: { select: { firstName: true, lastName: true, email: true } }
      }
    });
    if (!contract || contract.status !== ContractStatus.ACTIVE) throw new AppError('العقد غير نشط أو لا تملك صلاحية المراجعة', 403);
    const stage = await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contract.id }, include: { deliveries: { orderBy: { submittedAt: 'desc' }, take: 1 } } });
    const delivery = stage?.deliveries[0];
    if (!stage || stage.status !== ProjectStageStatus.SUBMITTED || !delivery || delivery.status !== StageDeliveryStatus.SUBMITTED) throw new AppError('لا يوجد تسليم جديد بانتظار المراجعة لهذه المرحلة', 409);
    const result = await prisma.$transaction(async tx => {
      let isProjectCompleted = false;
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
          await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: { releasedAmount: { increment: stage.amount } } });
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
          await createCommissionsForStageReleaseEvent(tx, {
            contract: { id: contract.id, projectId: contract.projectId, clientId: contract.clientId, providerId: contract.providerId },
            stageId: stage.id,
            releasedAmount: stage.amount
          });
        } else {
          isProjectCompleted = true;
          const completed = await tx.contract.updateMany({
            where: { id: contract.id, status: { not: ContractStatus.COMPLETED } },
            data: { status: ContractStatus.COMPLETED }
          });
          if (completed.count !== 1) throw new AppError('تم اعتماد المشروع النهائي مسبقاً', 409);
          await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.COMPLETED, providerId: contract.providerId } });
          await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: { status: EscrowStatus.RELEASED, releasedAmount: contract.price } });
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
          await createCommissionsForStageReleaseEvent(tx, {
            contract: { id: contract.id, projectId: contract.projectId, clientId: contract.clientId, providerId: contract.providerId },
            stageId: stage.id,
            releasedAmount: stage.amount
          });
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
            tx.project.count({ where: { providerId: contract.providerId, status: ProjectStatus.COMPLETED } }),
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
      return {
        decision,
        stageId,
        notificationId: notification.id,
        isProjectCompleted,
        providerEmail: isProjectCompleted ? contract.provider.email : null,
        providerName: `${contract.provider.firstName || 'مقدم الخدمة'} ${contract.provider.lastName || ''}`.trim(),
        projectTitle: contract.project.title
      };
    });

    await notificationService.emitStored(result.notificationId).catch(error => {
      console.error('[ProjectProgress] Failed to emit project review notification:', error);
    });
    if (result.isProjectCompleted && result.providerEmail) {
      await emailService.sendProjectCompletionRewardEmail({
        email: result.providerEmail,
        providerName: result.providerName,
        projectTitle: result.projectTitle,
        pointsAwarded: PROJECT_COMPLETION_POINTS,
        projectUrl: `/provider-overview/projects/${contract.projectId}/progress`
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
