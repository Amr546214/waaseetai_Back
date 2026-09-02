import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateRatingInput } from '../dtos/rating.dto';

export class RatingService {
  async rateRequest(requestId: string, userId: string, actor: 'client' | 'provider', input: CreateRatingInput) {
    const request = await prisma.clientRequest.findUnique({ where: { id: requestId }, include: { clientProfile: { select: { userId: true } }, proposals: { where: { status: 'ACCEPTED' }, select: { providerId: true } } } });
    if (!request) throw new AppError('الطلب غير موجود', 404);
    if (request.status !== 'COMPLETED') throw new AppError('يمكن التقييم بعد اكتمال الطلب فقط', 400);
    const providerId = request.proposals[0]?.providerId;
    if (!providerId) throw new AppError('لا يوجد مقدم خدمة مرتبط بالطلب', 400);
    const clientId = request.clientProfile.userId;
    if (actor === 'client' && clientId !== userId) throw new AppError('لا تملك صلاحية تقييم هذا الطلب', 403);
    if (actor === 'provider' && providerId !== userId) throw new AppError('لا تملك صلاحية تقييم هذا الطلب', 403);
    const existing = await prisma.review.findFirst({ where: { clientRequestId: requestId, clientId, providerId } });
    if (existing) throw new AppError('تم تقييم هذا الطلب مسبقاً', 409);
    const review = await prisma.$transaction(async tx => {
      const created = await tx.review.create({ data: { clientRequestId: requestId, clientId, providerId, rating: input.rating, comment: input.comment } });
      const aggregate = await tx.review.aggregate({ where: { providerId }, _avg: { rating: true } });
      await tx.user.update({ where: { id: providerId }, data: { ratingAverage: aggregate._avg.rating || 0 } });
      await tx.providerGamification.updateMany({ where: { providerId }, data: { avgRating: aggregate._avg.rating || 0 } });
      return created;
    });
    return review;
  }
}

export const ratingService = new RatingService();
