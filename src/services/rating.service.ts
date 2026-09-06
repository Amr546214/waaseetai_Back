import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateRatingInput } from '../dtos/rating.dto';

export class RatingService {
  async rateRequest(requestId: string, userId: string, actor: 'client' | 'provider', input: CreateRatingInput) {
    let request = await prisma.clientRequest.findUnique({ where: { id: requestId }, include: { clientProfile: { select: { userId: true } }, proposals: { where: { status: 'ACCEPTED' }, select: { providerId: true } } } });

    let providerId: string | undefined;
    let clientId: string | undefined;
    let clientRequestId: string | null = null;
    let projectId: string | null = null;

    if (request) {
      if (request.status !== 'COMPLETED') throw new AppError('يمكن التقييم بعد اكتمال الطلب فقط', 400);
      providerId = request.proposals[0]?.providerId;
      clientId = request.clientProfile.userId;
      clientRequestId = requestId;
    } else {
      const contract = await prisma.contract.findUnique({
        where: { id: requestId },
        include: { project: { select: { id: true, status: true } } }
      });
      if (contract) {
        if (contract.status !== 'COMPLETED') throw new AppError('يمكن التقييم بعد اكتمال الطلب فقط', 400);
        providerId = contract.providerId;
        clientId = contract.clientId;
        projectId = contract.projectId;
        clientRequestId = null;
      } else {
        const project = await prisma.project.findUnique({
          where: { id: requestId },
          include: { contract: true }
        });
        if (!project) throw new AppError('الطلب غير موجود', 404);
        if (project.status !== 'COMPLETED') throw new AppError('يمكن التقييم بعد اكتمال الطلب فقط', 400);
        providerId = project.providerId || undefined;
        clientId = project.clientId;
        projectId = project.id;
        if (!providerId && project.contract) providerId = project.contract.providerId;
      }
    }

    if (!providerId) throw new AppError('لا يوجد مقدم خدمة مرتبط بالطلب', 400);
    if (!clientId) throw new AppError('لا يوجد عميل مرتبط بالطلب', 400);
    if (actor === 'client' && clientId !== userId) throw new AppError('لا تملك صلاحية تقييم هذا الطلب', 403);
    if (actor === 'provider' && providerId !== userId) throw new AppError('لا تملك صلاحية تقييم هذا الطلب', 403);

    const existingWhere: any = { clientId, providerId };
    if (clientRequestId) existingWhere.clientRequestId = clientRequestId;
    else if (projectId) existingWhere.projectId = projectId;
    const existing = await prisma.review.findFirst({ where: existingWhere });
    if (existing) throw new AppError('تم تقييم هذا الطلب مسبقاً', 409);

    const review = await prisma.$transaction(async tx => {
      const created = await tx.review.create({
        data: {
          ...(clientRequestId ? { clientRequestId } : {}),
          ...(projectId ? { projectId } : {}),
          clientId,
          providerId,
          rating: input.rating,
          comment: input.comment
        }
      });
      const aggregate = await tx.review.aggregate({ where: { providerId }, _avg: { rating: true } });
      await tx.user.update({ where: { id: providerId }, data: { ratingAverage: aggregate._avg.rating || 0 } });
      await tx.providerGamification.updateMany({ where: { providerId }, data: { avgRating: aggregate._avg.rating || 0 } });
      return created;
    });
    return review;
  }
}

export const ratingService = new RatingService();
