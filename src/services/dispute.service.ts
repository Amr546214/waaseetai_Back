import { DisputeStatus, RequestStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateDisputeInput, ResolveDisputeInput } from '../dtos/dispute.dto';

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
    if (!allowedStatuses.includes(request.status)) throw new AppError(statusErrorMessage, 400);
    if (actor === 'client' && request.clientProfile.userId !== userId) throw new AppError('لا تملك صلاحية هذا الطلب', 403);
    if (actor === 'provider' && !request.proposals.some(proposal => proposal.status === 'ACCEPTED')) throw new AppError('لا تملك صلاحية هذا الطلب', 403);
    const accepted = await prisma.proposal.findFirst({ where: { clientRequestId: requestId, status: 'ACCEPTED' }, select: { providerId: true } });
    return { request, againstUserId: actor === 'client' ? accepted?.providerId : request.clientProfile.userId };
  }

  async createForRequest(requestId: string, userId: string, actor: 'client' | 'provider', input: CreateDisputeInput) {
    const { request, againstUserId } = await this.requestForActor(requestId, userId, actor);
    const existing = await prisma.dispute.findFirst({ where: { requestId, openedById: userId, status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } } });
    if (existing) throw new AppError('لديك نزاع مفتوح مسبقاً لهذا الطلب', 409);
    return prisma.dispute.create({
      data: { requestId, openedById: userId, againstUserId, reason: input.reason, description: input.description, evidence: input.evidence || [], status: DisputeStatus.OPEN },
      include: { request: { select: { id: true, title: true } } }
    });
  }

  async cancelByProvider(requestId: string, providerId: string) {
    await this.requestForActor(requestId, providerId, 'provider', [RequestStatus.IN_PROGRESS], 'لا يمكن إلغاء هذا الطلب في حالته الحالية');
    return prisma.clientRequest.update({ where: { id: requestId }, data: { status: RequestStatus.CANCELLED } });
  }

  async listForAdmin(status?: DisputeStatus, page = 1, limit = 20) {
    const safePage = Math.max(1, page); const safeLimit = Math.min(100, Math.max(1, limit));
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      prisma.dispute.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { request: { select: { id: true, title: true } }, openedBy: { select: { id: true, firstName: true, lastName: true, email: true } }, againstUser: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
      prisma.dispute.count({ where })
    ]);
    return { items, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
  }

  async getForAdmin(id: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id }, include: { request: true, project: true, openedBy: { select: { id: true, firstName: true, lastName: true, email: true } }, againstUser: { select: { id: true, firstName: true, lastName: true, email: true } }, resolvedBy: { select: { id: true, firstName: true, lastName: true } } } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    return dispute;
  }

  async resolve(id: string, adminId: string, input: ResolveDisputeInput) {
    const dispute = await prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    if (dispute.status !== DisputeStatus.OPEN && dispute.status !== DisputeStatus.UNDER_REVIEW) throw new AppError('تمت معالجة النزاع مسبقاً', 409);
    return prisma.dispute.update({ where: { id }, data: { status: input.action === 'resolve' ? DisputeStatus.RESOLVED : DisputeStatus.REJECTED, resolution: input.resolution, resolutionNote: input.resolutionNote, resolvedById: adminId, resolvedAt: new Date() } });
  }
}

export const disputeService = new DisputeService();
