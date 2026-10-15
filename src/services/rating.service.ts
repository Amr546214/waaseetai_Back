import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateRatingInput, CLIENT_RATING_TAGS, PROVIDER_RATING_TAGS } from '../dtos/rating.dto';
import { deriveProviderProgression } from '../utils/progression-calculators';
import { providerNotifications } from './provider-notifications.service';
import { clientNotificationFor, clientNotifications } from './client-notifications.service';
import type { Prisma } from '@prisma/client';
import { adminSettlementFor, deliveryCompletedProject, SETTLED_NO_RATING_AR, SETTLED_LABEL_AR } from './settlement-state.service';
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
 * INTERNAL aggregate (NOT the public one). Counts EVERY client -> provider review, published or not: it feeds User.ratingAverage / ProviderGamification.avgRating, one of the
 * three LEVEL_MATRIX gates, so a provider's level never depends on whether the reviewer chose to publish. The PUBLIC average/count/percentage (public profile, service pages,
 * cards) are computed separately from `isPublic = true` reviews only (see review-visibility.ts).
 *
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
    tx.project.count({ where: deliveryCompletedProject({ providerId }) })
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
          tags: tagsFor(reviewerRole, input.tags),
          isPublic: input.publish ?? true
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
   * Builds the RatingStatus payload shared by the project and the stage status endpoints. `blocked` is the reason the target itself cannot be rated right now
   * (not completed / stage not approved); a saved review always wins, then an admin settlement, then `blocked`. The saved review is returned even for a project
   * that was later settled (history stays readable) while `canRate` is false.
   */
  private async buildStatus(args: {
    saved: any | null; scope: 'PROJECT' | 'STAGE'; actor: 'client' | 'provider'; projectId: string | null; requestId: string | null; stageId?: string | null;
    blocked: { reason: 'NOT_COMPLETED' | 'STAGE_NOT_APPROVED'; message: string } | null;
  }) {
    const { saved, scope, actor, projectId, requestId, stageId = null, blocked } = args;
    const settlement = await adminSettlementFor({ projectId, requestId }, prisma as any);
    // The REAL distribution the admin executed (refund to the client, gross release to the provider, platform commission, provider net) — from the settlement's own
    // audit row, so the page never claims "completed / the whole amount released" for a project that was closed by a settlement.
    let distribution: FinancialOutcomeSummary | null = null;
    if (settlement.settled) {
      try { distribution = ((await adminAudit.listForEntity('DISPUTE', settlement.disputeId, ['DISPUTE_FINANCIAL_RESOLVED']))[0]?.context?.outcomeSummary as FinancialOutcomeSummary | undefined) ?? null; } catch { distribution = null; }
    }
    const what = scope === 'STAGE' ? 'هذه المرحلة' : 'هذا المشروع';
    let canRate = false; let reason: 'ALREADY_RATED' | 'ADMIN_SETTLED' | 'NOT_COMPLETED' | 'STAGE_NOT_APPROVED' | null = null; let message = '';
    if (saved) { reason = 'ALREADY_RATED'; message = `قيّمتَ ${what} مسبقًا`; }
    else if (settlement.settled) { reason = 'ADMIN_SETTLED'; message = SETTLED_NO_RATING_AR; }
    else if (blocked) { reason = blocked.reason; message = blocked.message; }
    else canRate = true;
    return {
      scope, projectId, requestId, stageId, actor, canRate, reason, message,
      adminSettled: settlement.settled ? { disputeId: settlement.disputeId, outcome: settlement.outcome, label: SETTLED_LABEL_AR, distribution } : null,
      review: saved ? { id: saved.id, rating: saved.rating, comment: saved.comment ?? null, tags: saved.tags ?? [], isPublic: saved.isPublic !== false, createdAt: saved.createdAt } : null
    };
  }

  /**
   * What the rating page needs BEFORE it shows anything: may this user rate, and what did this user already rate. Ownership is checked first (a stranger gets 403 and
   * learns nothing). The saved review is the user's own project-level review of the OTHER side (never a stage review, never the account-level rating).
   */
  async getStatus(requestId: string, userId: string, actor: 'client' | 'provider') {
    const target = await this.resolveTarget(requestId);
    const { providerId, clientId, clientRequestId, projectId } = target;
    if (!providerId || !clientId) throw new AppError('الطلب غير مكتمل البيانات', 400);
    if ((actor === 'client' && clientId !== userId) || (actor === 'provider' && providerId !== userId)) throw new AppError('لا تملك صلاحية هذا الطلب', 403);
    const reviewerRole = actor === 'provider' ? 'PROVIDER' : 'CLIENT';
    const where: any = { clientId, providerId, stageId: null, reviewerRole };
    if (clientRequestId) where.clientRequestId = clientRequestId; else if (projectId) where.projectId = projectId;
    const saved = await prisma.review.findFirst({ where, orderBy: { createdAt: 'desc' } });
    return this.buildStatus({
      saved, scope: 'PROJECT', actor, projectId, requestId: clientRequestId,
      blocked: target.completed ? null : { reason: 'NOT_COMPLETED', message: 'يمكن التقييم بعد اكتمال المشروع' }
    });
  }

  /** The client's contract for a project key (project id or contract id), with the ownership check shared by the stage status and the stage rating. */
  private async clientContractFor(projectKey: string, userId: string) {
    const contract = await prisma.contract.findFirst({ where: { OR: [{ projectId: projectKey }, { id: projectKey }] }, include: { project: { select: { id: true } } } });
    if (!contract) throw new AppError('المشروع غير موجود', 404);
    if (contract.clientId !== userId) throw new AppError('لا تملك صلاحية الوصول إلى هذا المشروع', 403);
    return contract;
  }

  /**
   * The same RatingStatus shape for ONE stage: ownership (stranger -> 403, a stage of another contract -> 404), only APPROVED stages are rateable, a settled project
   * allows no new stage rating, and an existing stage review is returned read-only. Stage reviews are the client's only (the provider rates the project, not stages).
   */
  async getStageStatus(projectKey: string, stageId: string, userId: string) {
    const contract = await this.clientContractFor(projectKey, userId);
    const stage = await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contract.id } });
    if (!stage) throw new AppError('المرحلة غير موجودة', 404);
    const saved = await prisma.review.findFirst({ where: { stageId: stage.id, clientId: contract.clientId, providerId: contract.providerId, reviewerRole: 'CLIENT' }, orderBy: { createdAt: 'desc' } });
    return this.buildStatus({
      saved, scope: 'STAGE', actor: 'client', projectId: contract.projectId, requestId: null, stageId: stage.id,
      blocked: stage.status === 'APPROVED' ? null : { reason: 'STAGE_NOT_APPROVED', message: 'يمكن تقييم المرحلة بعد اعتمادها فقط' }
    });
  }

  /**
   * Client rates a specific stage/delivery after approving it (a different review from rateRequest, which rates the whole project). Stores a Review with stageId set.
   *
   * DECISION (documented): stage reviews ARE client -> provider reviews, so they feed the provider's rating (internal average and, when published, the public average/count),
   * exactly like project reviews. The public list labels each review as a project or a stage review (`kind`), so the count the page shows is the number of rows the list
   * can show. A stage review is never an account-level rating of the client.
   */
  async rateStage(projectKey: string, stageId: string, userId: string, input: CreateRatingInput) {
    const contract = await this.clientContractFor(projectKey, userId);
    const stage = await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contract.id } });
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
        data: { stageId: stage.id, clientId, providerId, projectId, ...(serviceId ? { serviceId } : {}), reviewerRole: 'CLIENT', rating: input.rating, comment: input.comment, tags: tagsFor('CLIENT', input.tags), isPublic: input.publish ?? true }
      });
      await refreshProviderAggregates(tx, providerId);
      return created;
    });
    await providerNotifications.ratingReceived({ providerId, rating: input.rating, reviewId: review.id, projectId, stage: true });
    return review;
  }
}

export const ratingService = new RatingService();
