import { ContractStatus, EscrowStatus, ProjectStageStatus, ProjectStatus, RequestStatus, StageDeliveryStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { notificationService } from './notification.service';
import { emailService } from './email.service';

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
        project: { include: { escrow: true, conversations: { include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, firstName: true, lastName: true } } } } } } } },
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
          proposals: { where: { status: 'ACCEPTED' }, include: { provider: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 1 }
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
        stages: [], deliveries: [], edits: [], messages: [], files: [],
        aiInsights: { confidence: 0, earlyDays: 0, matchPercentage: null, riskLevel: 'غير محسوبة', riskLevelKey: 'unknown', healthRating: 'بانتظار بيانات كافية', bullets: [] }
      };
    }
    await this.ensureStages(contract.id);
    const persisted = await prisma.projectStage.findMany({ where: { contractId: contract.id }, orderBy: { stepOrder: 'asc' }, include: { deliveries: { orderBy: { submittedAt: 'asc' } } } });
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
      return {
        id: stage.id, stageNumber: stage.stepOrder, title: stage.title, description: stage.description,
        amount: stage.amount, percentage: stage.percentage, days: stage.days,
        isDone: stage.status === ProjectStageStatus.APPROVED,
        isWait: stage.status === ProjectStageStatus.IN_PROGRESS || stage.status === ProjectStageStatus.SUBMITTED || stage.status === ProjectStageStatus.REVISION_REQUESTED,
        status, statusText, completedDate: stage.approvedAt, roundsCount: stage.deliveries.length,
        threads: stage.deliveries.map((delivery, index) => ({
          id: delivery.id, author: role === 'provider' ? 'أنت' : `${contract.provider.firstName || 'مقدم الخدمة'} ${contract.provider.lastName || ''}`.trim(),
          authorInitial: contract.provider.firstName?.charAt(0) || 'م', isMe: role === 'provider', tag: `التسليم ${index + 1}`,
          isRedo: index > 0, date: delivery.submittedAt, note: delivery.note,
          files: delivery.files.map(url => ({ name: nameFromUrl(url), url })), reviewNote: delivery.reviewNote, deliveryStatus: delivery.status
        }))
      };
    });
    const deliveries = persisted.flatMap(stage => stage.deliveries.map((delivery, index) => {
      const [status, statusText] = deliveryLabels[delivery.status];
      return { id: delivery.id, stageId: stage.id, stageTitle: stage.title, stageNumber: stage.stepOrder,
        title: stage.title, status, statusText, submittedAt: delivery.submittedAt, roundText: `التسليم ${index + 1}`,
        summary: delivery.note, reviewNote: delivery.reviewNote, files: delivery.files.map(url => ({ name: nameFromUrl(url), url })) };
    }));
    const messages = (conversation?.messages || []).map(message => ({
      id: message.id, senderName: message.senderId === userId ? 'أنت' : `${message.sender.firstName || otherName} ${message.sender.lastName || ''}`.trim(),
      senderInitial: (message.sender.firstName || otherName).charAt(0), senderRole: message.senderId === contract.providerId ? 'provider' : 'client',
      isMe: message.senderId === userId, time: message.createdAt, content: message.content || message.fileName || 'مرفق', fileUrl: message.fileUrl, fileName: message.fileName
    }));
    const progress = Math.min(100, Math.round(persisted.filter(s => s.status === ProjectStageStatus.APPROVED).reduce((sum, s) => sum + s.percentage, 0)));
    const elapsed = Math.max(0, Math.floor((Date.now() - (contract.signedAt || contract.createdAt).getTime()) / 86400000));
    return {
      id: contract.id, projectId: contract.projectId, role, conversationId: conversation?.id || null,
      title: contract.project.title, clientName: otherName, clientInitial: otherName.charAt(0) || 'ع', contractRef: `CT-${contract.id.slice(0, 6).toUpperCase()}`,
      price: contract.price, durationDays: contract.durationDays, daysLeft: Math.max(0, contract.durationDays - elapsed), progress,
      escrowTotal: contract.project.escrow?.amount || contract.price, escrowHeld: Math.max(0, (contract.project.escrow?.amount || contract.price) - released), escrowReleased: released,
      status: contract.status, statusLabel: contract.status === ContractStatus.COMPLETED ? 'مكتمل' : contract.status === ContractStatus.ACTIVE ? 'مشروع نشط' : 'بانتظار بدء المشروع',
      stages, deliveries,
      edits: deliveries.filter(d => d.status === 'notes').map(d => ({ id: d.id, stageId: d.stageId, stageTitle: d.stageTitle, title: `ملاحظات على ${d.stageTitle}`, clientNotes: d.reviewNote || '', status: 'waiting', statusText: 'بانتظار إعادة التسليم', createdAt: d.submittedAt })),
      messages,
      files: persisted.filter(s => s.deliveries.some(d => d.files.length)).map(s => ({ groupTitle: s.title, isDone: s.status === ProjectStageStatus.APPROVED, files: s.deliveries.flatMap(d => d.files.map(url => ({ name: nameFromUrl(url), size: '', url }))) })),
      aiInsights: { confidence: 0, earlyDays: 0, matchPercentage: null, riskLevel: 'غير محسوبة', riskLevelKey: 'unknown', healthRating: 'بانتظار بيانات كافية', bullets: [] }
    };
  }

  async submitDelivery(providerId: string, key: string, stageId: string, note: string, files: string[]) {
    if (!note?.trim() || note.trim().length < 10) throw new AppError('أضف وصفاً واضحاً للتسليم (10 أحرف على الأقل)', 400);
    const contract = await prisma.contract.findFirst({ where: { OR: [{ id: key }, { projectId: key }], providerId } });
    if (!contract || contract.status !== ContractStatus.ACTIVE) throw new AppError('العقد غير نشط أو لا تملك صلاحية التسليم', 403);
    await this.ensureStages(contract.id);
    const stage = await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contract.id } });
    if (!stage || (stage.status !== ProjectStageStatus.IN_PROGRESS && stage.status !== ProjectStageStatus.REVISION_REQUESTED)) throw new AppError('هذه المرحلة غير متاحة للتسليم حالياً', 409);
    const safeFiles = Array.isArray(files) ? files.filter(v => typeof v === 'string' && v.trim()).slice(0, 10) : [];
    return prisma.$transaction(async tx => {
      const delivery = await tx.stageDelivery.create({ data: { stageId, providerId, note: note.trim(), files: safeFiles } });
      await tx.projectStage.update({ where: { id: stageId }, data: { status: ProjectStageStatus.SUBMITTED } });
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
        await tx.stageDelivery.update({ where: { id: delivery.id }, data: { status: StageDeliveryStatus.REVISION_REQUESTED, reviewNote: note!.trim(), reviewedAt: new Date() } });
        await tx.projectStage.update({ where: { id: stage.id }, data: { status: ProjectStageStatus.REVISION_REQUESTED } });
        await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.IN_PROGRESS } });
      } else {
        await tx.stageDelivery.update({ where: { id: delivery.id }, data: { status: StageDeliveryStatus.APPROVED, reviewNote: note?.trim() || null, reviewedAt: new Date() } });
        await tx.projectStage.update({ where: { id: stage.id }, data: { status: ProjectStageStatus.APPROVED, approvedAt: new Date() } });
        const next = await tx.projectStage.findFirst({ where: { contractId: contract.id, stepOrder: { gt: stage.stepOrder } }, orderBy: { stepOrder: 'asc' } });
        if (next) {
          await tx.projectStage.update({ where: { id: next.id }, data: { status: ProjectStageStatus.IN_PROGRESS, startedAt: new Date() } });
          await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.IN_PROGRESS } });
          await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: { releasedAmount: { increment: stage.amount } } });
        } else {
          isProjectCompleted = true;
          const completed = await tx.contract.updateMany({
            where: { id: contract.id, status: { not: ContractStatus.COMPLETED } },
            data: { status: ContractStatus.COMPLETED }
          });
          if (completed.count !== 1) throw new AppError('تم اعتماد المشروع النهائي مسبقاً', 409);
          await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.COMPLETED, providerId: contract.providerId } });
          await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: { status: EscrowStatus.RELEASED, releasedAmount: contract.price } });
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
          const [pointsAggregate, completedProjects] = await Promise.all([
            tx.pointTransaction.aggregate({ where: { providerId: contract.providerId }, _sum: { amount: true } }),
            tx.project.count({ where: { providerId: contract.providerId, status: ProjectStatus.COMPLETED } })
          ]);
          const totalPoints = pointsAggregate._sum.amount || 0;
          await Promise.all([
            tx.user.update({ where: { id: contract.providerId }, data: { currentPoints: totalPoints } }),
            tx.providerGamification.upsert({
              where: { providerId: contract.providerId },
              update: { points: totalPoints, completedProjects },
              create: { providerId: contract.providerId, points: totalPoints, completedProjects }
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
          actionUrl: `/provider-overview/projects/${contract.projectId}/progress`,
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
}

export const projectProgressService = new ProjectProgressService();
