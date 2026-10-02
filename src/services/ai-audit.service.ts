import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { AppError } from '../utils/app-error';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError, WaseetAiErrorCode } from './ai/waseet-ai/waseet-ai.errors';

// Business-model (ServiceCatalog) AI audit — served exclusively by WaseetAI
// (waseetAiClient.auditBusinessModel). The verdict is ADVISORY ONLY: it is
// stored in the ai* fields and NEVER changes status / approvedAt /
// auditRejectionReason, never approves/rejects/publishes a model, and sends
// no notification, e-mail or socket event. A failed or invalid call writes
// nothing (no zero-score default).
//
// The service needs the real category: without it valid listings are wrongly
// rejected, so a model without a specialty is SKIPPED (no call, no write).
// Currency is not sent (not verified). aiClarityScore / aiFeasibilityScore are
// not provided by the service and are left untouched (NULL).

export const AI_AUDIT_UNAVAILABLE_MESSAGE =
  'تعذر إكمال التدقيق الذكي لنموذج العمل حالياً. لم يتم تغيير النموذج ويبقى ضمن مسار المراجعة الإدارية.';

export type AiAuditOutcome =
  | { outcome: 'audited'; serviceId: string; score: number; isApproved: boolean }
  | { outcome: 'skipped'; serviceId: string; reason: 'NO_CATEGORY' };

const unavailable = (code: string): AppError =>
  Object.assign(new AppError(AI_AUDIT_UNAVAILABLE_MESSAGE, 503), { code });

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export class AiAuditService {
  /** Kept for existing callers: fire-and-forget, never throws. */
  async triggerAuditAndPublish(serviceId: string, _providerId: string): Promise<void> {
    return this.auditProjectModel(serviceId);
  }

  /** Non-blocking creation hook: starts the advisory audit in the background
   *  and returns immediately. Never throws, never blocks creation. */
  async auditProjectModel(serviceId: string, _providerIdInput?: string): Promise<void> {
    void this.executeAuditSync(serviceId).catch((error) => {
      logger.warn(`[AiAuditService] background audit skipped for ${serviceId}: ${(error as { code?: string })?.code || 'error'}`);
    });
  }

  async executeAuditSync(serviceId: string, _providerIdInput?: string): Promise<AiAuditOutcome> {
    const service = await prisma.serviceCatalog.findUnique({
      where: { id: serviceId },
      include: { specialty: true, stages: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!service) throw new AppError('نموذج العمل غير موجود', 404);

    const specialtyName = service.specialty?.nameAr?.trim();
    if (!specialtyName) {
      logger.info(`[AiAuditService] model ${serviceId} has no category; AI audit skipped.`);
      return { outcome: 'skipped', serviceId, reason: 'NO_CATEGORY' };
    }
    const subSpecialty = service.subSpecialty?.trim();
    const category = subSpecialty ? `${specialtyName} - ${subSpecialty}` : specialtyName;

    const stageLines = (service.stages ?? []).map(
      (s) => `${s.stepOrder}. ${s.title} (${s.deliveryDays} يوم، ${s.percentage}%)`,
    );
    const description = [
      service.description ?? '',
      '',
      '--- تفاصيل النموذج ---',
      `إجمالي المدة: ${service.totalDays} يوم`,
      ...(stageLines.length ? ['المراحل:', ...stageLines] : []),
    ].join('\n');

    let verdict;
    try {
      verdict = await waseetAiClient.auditBusinessModel({
        title: service.title,
        description,
        category,
        pricing: { amount: Number(service.totalAmount) },
      });
    } catch (error) {
      const e = normalizeWaseetAiError(error);
      logger.warn(`[AiAuditService] WaseetAI audit failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
      throw unavailable(e.code);
    }

    const score = verdict?.score;
    if (
      !verdict || typeof verdict.isApproved !== 'boolean' || typeof score !== 'number' || !Number.isFinite(score) ||
      score < 0 || score > 100 || typeof verdict.summary !== 'string' ||
      !isStringArray(verdict.strengths) || !isStringArray(verdict.issues) || !isStringArray(verdict.recommendations)
    ) {
      logger.warn(`[AiAuditService] WaseetAI audit returned an invalid response for ${serviceId}`);
      throw unavailable(WaseetAiErrorCode.INVALID_RESPONSE);
    }

    const { isApproved, summary, strengths, issues, recommendations } = verdict;
    // ADVISORY fields only — status / approvedAt / auditRejectionReason are never written.
    await prisma.serviceCatalog.update({
      where: { id: serviceId },
      data: {
        aiScore: Math.round(score),
        aiReviewSummary: summary,
        aiReviewDetails: { source: 'WASEET_AI', strengths, issues, recommendations } as any,
        aiAuditReport: { source: 'WASEET_AI', isApproved, score, summary, strengths, issues, recommendations } as any,
        aiAuditScore: score,
        aiAuditFeedback: { summary, recommendations } as any,
      },
    });
    return { outcome: 'audited', serviceId, score, isApproved };
  }
}

export const aiAuditService = new AiAuditService();
