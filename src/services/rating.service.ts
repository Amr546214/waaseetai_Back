import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateRatingInput, CLIENT_RATING_TAGS, PROVIDER_RATING_TAGS } from '../dtos/rating.dto';
import { deriveProviderProgression } from '../utils/progression-calculators';
import { providerNotifications } from './provider-notifications.service';
import { clientNotificationFor, clientNotifications } from './client-notifications.service';
import type { Prisma } from '@prisma/client';
import { adminSettlementFor, SETTLED_NO_RATING_AR, SETTLED_LABEL_AR } from './settlement-state.service';
import { adminAudit } from './admin-audit.service';
import type { FinancialOutcomeSummary } from '../utils/dispute-resolution';

export const ADMIN_SETTLED_MESSAGE = SETTLED_NO_RATING_AR;

/** A project whose escrow an admin settled through a FINANCIAL dispute decision did not complete through delivery approval: no rating (and no points) for it. */
async function assertNotAdminSettled(db: { dispute: { findFirst: (args: any) => Promise<any> } }, projectId: string | null, requestId: string | null) {
  if ((await adminSettlementFor({ projectId, requestId }, db as any)).settled) throw new AppError(ADMIN_SETTLED_MESSAGE, 409);
}

/** The tags a side may attach: only its own list, no duplicates, in the order chosen. Anything else is a 400. */
function tagsFor(reviewerRole: 'CLIENT' | 'PROVIDER', tags: string[] | undefined): string[] {
  const allowed: readonly string[] = reviewerRole === 'CLIENT' ? CLIENT_RATING_TAGS : PROVIDER_RATING_TAGS;
  const clean = [...new Set((tags ?? []).map(t => t.trim()).filter(Boolean))];
  if (clean.some(t => !allowed.includes(t))) throw new AppError('وسم تقييم غير مسموح لهذا الطرف', 400);
  return clean;
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

export type RatingTarget = {
  providerId?: string; clientId?: string; clientRequestId: string | null; projectId: string | null; serviceId: string | null; completed: boolean;
};

export class RatingService {
  /**
   * Resolves what a rating key points to: a client request id, a contract id or a project id (the same lookup order the rating always used), plus whether it
   * COMPLETED. Reads only; ownership and eligibility are decided by the callers.
   */
  async resolveTarget(requestId: string): Promise<RatingTarget> {
    const request = await prisma.clientRequest.findUnique({ where: { id: requestId }, include: { clientProfile: { select: { userId: true } }, proposals: { where: { status: 'ACCEPTED' }, select: { providerId: true } } } });
    if (request) {
      return { providerId: request.proposals[0]?.providerId, clientId: request.clientProfile.userId, clientRequestId: requestId, projectId: null, serviceId: null, completed: request.status === 'COMPLETED' };
    }
    const contract = await prisma.contract.findUnique({ where: { id: requestId }, include: { project: { select: { id: true, status: true } } } });
    if (contract) {
      const serviceId = (await prisma.project.findUnique({ where: { id: contract.projectId }, select: { serviceCatalogId: true } }))?.serviceCatalogId ?? null;
      return { providerId: contract.providerId, clientId: contract.clientId, clientRequestId: null, projectId: contract.projectId, serviceId, completed: contract.status === 'COMPLETED' };
    }
    const project = await prisma.project.findUnique({ where: { id: requestId }, include: { contract: true } });
    if (!project) throw new AppError('الطلب غير موجود', 404);
    return { providerId: project.providerId || project.contract?.providerId || undefined, clientId: project.clientId, clientRequestId: null, projectId: project.id, serviceId: project.serviceCatalogId ?? null, completed: project.status === 'COMPLETED' };
  }

  async rateRequest(requestId: string, userId: string, actor: 'client' | 'provider', input: CreateRatingInput) {
    const target = await this.resolveTarget(requestId);
    if (!target.completed) throw new AppError('يمكن التقييم بعد اكتمال الطلب فقط', 400);
    const { providerId, clientId, clientRequestId, projectId, serviceId } = target;

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
          comment: input.comment,
          tags: tagsFor(reviewerRole, input.tags)
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
   * What the rating page needs BEFORE it shows anything: may this user rate, and what did this user already rate. Ownership is checked first (a stranger gets 403 and
   * learns nothing). The saved review is the user's own project-level review of the OTHER side; it is returned even for a project that was later settled by a dispute
   * (the history stays visible), while `canRate` is false whenever a review exists, the project did not complete by delivery, or an admin settled it.
   */
  async getStatus(requestId: string, userId: string, actor: 'client' | 'provider') {
    const target = await this.resolveTarget(requestId);
    const { providerId, clientId, clientRequestId, projectId } = target;
    if (!providerId || !clientId) throw new AppError('الطلب غير مكتمل البيانات', 400);
    if ((actor === 'client' && clientId !== userId) || (actor === 'provider' && providerId !== userId)) throw new AppError('لا تملك صلاحية هذا الطلب', 403);
    const reviewerRole = actor === 'provider' ? 'PROVIDER' : 'CLIENT';
    const where: any = { clientId, providerId, stageId: null, reviewerRole };
    if (clientRequestId) where.clientRequestId = clientRequestId; else if (projectId) where.projectId = projectId;
    const [saved, settlement] = await Promise.all([
      prisma.review.findFirst({ where, orderBy: { createdAt: 'desc' } }),
      adminSettlementFor({ projectId, requestId: clientRequestId }, prisma as any)
    ]);
    // The REAL distribution the admin executed (refund to the client, gross release to the provider, platform commission, provider net) — from the settlement's own
    // audit row, so the page never claims "completed / the whole amount released" for a project that was closed by a settlement.
    let distribution: FinancialOutcomeSummary | null = null;
    if (settlement.settled) {
      try { distribution = ((await adminAudit.listForEntity('DISPUTE', settlement.disputeId, ['DISPUTE_FINANCIAL_RESOLVED']))[0]?.context?.outcomeSummary as FinancialOutcomeSummary | undefined) ?? null; } catch { distribution = null; }
    }
    let canRate = false; let reason: 'ALREADY_RATED' | 'ADMIN_SETTLED' | 'NOT_COMPLETED' | null = null; let message = '';
    if (saved) { reason = 'ALREADY_RATED'; message = 'قيّمتَ هذا المشروع مسبقًا'; }
    else if (settlement.settled) { reason = 'ADMIN_SETTLED'; message = SETTLED_NO_RATING_AR; }
    else if (!target.completed) { reason = 'NOT_COMPLETED'; message = 'يمكن التقييم بعد اكتمال المشروع'; }
    else canRate = true;
    return {
      projectId, requestId: clientRequestId, actor, canRate, reason, message,
      adminSettled: settlement.settled ? { disputeId: settlement.disputeId, outcome: settlement.outcome, label: SETTLED_LABEL_AR, distribution } : null,
      review: saved ? { id: saved.id, rating: saved.rating, comment: saved.comment ?? null, tags: saved.tags ?? [], createdAt: saved.createdAt } : null
    };
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
        data: { stageId: stage.id, clientId, providerId, projectId, ...(serviceId ? { serviceId } : {}), reviewerRole: 'CLIENT', rating: input.rating, comment: input.comment, tags: tagsFor('CLIENT', input.tags) }
      });
      await refreshProviderAggregates(tx, providerId);
      return created;
    });
    await providerNotifications.ratingReceived({ providerId, rating: input.rating, reviewId: review.id, projectId, stage: true });
    return review;
  }
}

export const ratingService = new RatingService();
