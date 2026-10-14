import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateRatingInput } from '../dtos/rating.dto';
import { deriveProviderProgression } from '../utils/progression-calculators';
import { providerNotifications } from './provider-notifications.service';
import { clientNotificationFor, clientNotifications } from './client-notifications.service';
import type { Prisma } from '@prisma/client';
import { FINANCIAL_OUTCOMES } from '../utils/dispute-resolution';

export const ADMIN_SETTLED_MESSAGE = 'لا يمكن تقييم مشروع سُوّي إداريًا عبر نزاع. التقييم متاح للمشاريع التي اكتملت باعتماد التسليم.';

/** A project whose escrow an admin settled through a FINANCIAL dispute decision did not complete through delivery approval: no rating (and no points) for it. */
async function assertNotAdminSettled(db: { dispute: { findFirst: (args: any) => Promise<{ id: string } | null> } }, projectId: string | null, requestId: string | null) {
  const keys: Array<Record<string, string>> = [];
  if (projectId) keys.push({ projectId });
  if (requestId) keys.push({ requestId });
  if (!keys.length) return;
  const settled = await db.dispute.findFirst({ where: { OR: keys, status: 'RESOLVED', resolution: { in: FINANCIAL_OUTCOMES as string[] } }, select: { id: true } });
  if (settled) throw new AppError(ADMIN_SETTLED_MESSAGE, 409);
}

/** Serializes the check-then-create of one review (same reviewer, same project/request/stage) so a double click or two parallel requests can never both pass the duplicate check. */
async function lockReviewKey(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * Re-derives the provider's rating average and level from the stored reviews, inside the caller's transaction. Phase 3D.3A: avgRating is one of the three
 * LEVEL_MATRIX qualification gates (see progression-calculators.ts), so a rating change alone can move a provider's level even though no points were awarded here;
 * points/completedProjects are re-read from their own sources so this write never regresses them. Used by both the project rating and the stage rating, so the
 * average always includes exactly the reviews the counts include.
 */
async function refreshProviderAggregates(tx: Prisma.TransactionClient, providerId: string) {
  const aggregate = await tx.review.aggregate({ where: { providerId, reviewerRole: 'CLIENT' }, _avg: { rating: true } });
  const avgRating = Number(aggregate._avg.rating || 0);
  await tx.user.update({ where: { id: providerId }, data: { ratingAverage: avgRating } });
  const [pointsAggregate, completedProjects] = await Promise.all([
    tx.pointTransaction.aggregate({ where: { providerId }, _sum: { amount: true } }),
    tx.project.count({ where: { providerId, status: 'COMPLETED' } })
  ]);
  const totalPoints = pointsAggregate._sum.amount || 0;
  const progression = deriveProviderProgression({ points: totalPoints, completedProjects, avgRating });
  await tx.providerGamification.updateMany({
    where: { providerId },
    data: { points: totalPoints, completedProjects, avgRating, currentLevelIndex: progression.currentLevelIndex, currentCommission: progression.currentCommission }
  });
}

export class RatingService {
  async rateRequest(requestId: string, userId: string, actor: 'client' | 'provider', input: CreateRatingInput) {
    let request = await prisma.clientRequest.findUnique({ where: { id: requestId }, include: { clientProfile: { select: { userId: true } }, proposals: { where: { status: 'ACCEPTED' }, select: { providerId: true } } } });

    let providerId: string | undefined;
    let clientId: string | undefined;
    let clientRequestId: string | null = null;
    let projectId: string | null = null;
    let serviceId: string | null = null;

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
        serviceId = (await prisma.project.findUnique({ where: { id: contract.projectId }, select: { serviceCatalogId: true } }))?.serviceCatalogId ?? null;
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
        serviceId = project.serviceCatalogId ?? null;
        if (!providerId && project.contract) providerId = project.contract.providerId;
      }
    }

    if (!providerId) throw new AppError('لا يوجد مقدم خدمة مرتبط بالطلب', 400);
    if (!clientId) throw new AppError('لا يوجد عميل مرتبط بالطلب', 400);
    if (actor === 'client' && clientId !== userId) throw new AppError('لا تملك صلاحية تقييم هذا الطلب', 403);
    if (actor === 'provider' && providerId !== userId) throw new AppError('لا تملك صلاحية تقييم هذا الطلب', 403);

    await assertNotAdminSettled(prisma as any, projectId, clientRequestId);

    // Duplicate check: only block if the SAME actor already rated in the SAME direction.
    // CLIENT → PROVIDER reviews must NOT block PROVIDER → CLIENT reviews (and vice versa).
    const reviewerRole = actor === 'provider' ? 'PROVIDER' : 'CLIENT';
    const existingWhere: any = { clientId, providerId, stageId: null, reviewerRole };
    if (clientRequestId) existingWhere.clientRequestId = clientRequestId;
    else if (projectId) existingWhere.projectId = projectId;
    const review = await prisma.$transaction(async tx => {
      await lockReviewKey(tx, `review:${reviewerRole}:${clientRequestId ?? projectId}:${clientId}:${providerId}`);
      const existing = await tx.review.findFirst({ where: existingWhere });
      if (existing) throw new AppError('تم تقييم هذا الطلب مسبقاً', 409);
      const created = await tx.review.create({
        data: {
          ...(clientRequestId ? { clientRequestId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(serviceId ? { serviceId } : {}),
          clientId,
          providerId,
          reviewerRole,
          rating: input.rating,
          comment: input.comment
        }
      });
      // Only client -> provider reviews feed the provider's average, count and level gate (a provider's rating of the client does not).
      if (reviewerRole === 'CLIENT') await refreshProviderAggregates(tx, providerId);
      return created;
    });
    if (reviewerRole === 'CLIENT') await providerNotifications.ratingReceived({ providerId, rating: input.rating, reviewId: review.id, projectId });
    // The client is told when the provider rates them (inbox always; channels per their preferences).
    else await clientNotifications.send(clientNotificationFor.ratingReceived({ clientId, rating: input.rating, reviewId: review.id, projectId }));
    return review;
  }

  /**
   * Client rates a specific stage/delivery after approving it.
   * Different from rateRequest (which rates the whole project/provider).
   * Stores a Review with stageId set, scoped to the stage.
   */
  async rateStage(projectKey: string, stageId: string, userId: string, input: CreateRatingInput) {
    // Find the contract by projectId or contractId
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ projectId: projectKey }, { id: projectKey }], clientId: userId },
      include: { project: { select: { id: true } } },
    });
    if (!contract) throw new AppError('المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);

    // Find the stage and ensure it belongs to this contract
    const stage = await prisma.projectStage.findFirst({
      where: { id: stageId, contractId: contract.id },
    });
    if (!stage) throw new AppError('المرحلة غير موجودة', 404);
    if (stage.status !== 'APPROVED') throw new AppError('يمكن تقييم المرحلة بعد اعتمادها فقط', 400);
    await assertNotAdminSettled(prisma as any, contract.projectId, null);

    const providerId = contract.providerId;
    const clientId = contract.clientId;
    const projectId = contract.projectId;

    const review = await prisma.$transaction(async tx => {
      await lockReviewKey(tx, `review:STAGE:${stage.id}:${clientId}`);
      const existing = await tx.review.findFirst({ where: { stageId: stage.id, clientId, providerId, reviewerRole: 'CLIENT' } });
      if (existing) throw new AppError('تم تقييم هذه المرحلة مسبقاً', 409);
      const serviceId = (await tx.project.findUnique({ where: { id: projectId }, select: { serviceCatalogId: true } }))?.serviceCatalogId ?? null;
      const created = await tx.review.create({
        data: { stageId: stage.id, clientId, providerId, projectId, ...(serviceId ? { serviceId } : {}), reviewerRole: 'CLIENT', rating: input.rating, comment: input.comment }
      });
      await refreshProviderAggregates(tx, providerId);
      return created;
    });
    await providerNotifications.ratingReceived({ providerId, rating: input.rating, reviewId: review.id, projectId, stage: true });
    return review;
  }
}

export const ratingService = new RatingService();
