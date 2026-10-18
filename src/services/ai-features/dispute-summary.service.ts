import { prisma } from '../../config/db';
import { AppError } from '../../utils/app-error';
import { waseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import { WaseetAiError, WaseetAiErrorCode, normalizeWaseetAiError } from '../ai/waseet-ai/waseet-ai.errors';
import type { DisputeSummaryRequest, DisputeSummaryResponse } from '../ai/waseet-ai/waseet-ai.types';

// Advisory-only dispute AI summary — never a verdict or financial decision.
// WaseetAI POST /v1/ai/disputes/summary generates neutral perspectives.
// Human mediators remain the sole authority on dispute outcomes.
export interface DisputeAiSummaryResult {
  summary: string;
  clientPerspective: string;
  providerPerspective: string;
}

const MAX_FIELD_LENGTH = 2000;
const FORBIDDEN_SUMMARY_KEYS = [
  'winner', 'loser', 'verdict', 'faultPercentage',
  'recommendation', 'recommendedResolution', 'releaseFunds',
  'refundAmount', 'confidence', 'confidenceOfGuilt'
];

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function mapToDisputeSummary(value: unknown): DisputeAiSummaryResult | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isBoundedString(v.summary, MAX_FIELD_LENGTH)) return null;
  if (!isBoundedString(v.clientPerspective, MAX_FIELD_LENGTH)) return null;
  if (!isBoundedString(v.providerPerspective, MAX_FIELD_LENGTH)) return null;
  return {
    summary: v.summary,
    clientPerspective: v.clientPerspective,
    providerPerspective: v.providerPerspective,
  };
}

const cap = (text: string | null | undefined, max = 1500) => (text ? text.slice(0, max) : '');

export class DisputeSummaryService {
  /**
   * Summarizes a dispute for administrative review by loading dispute data from the DB,
   * minimizing claims/evidence, and calling Waseet AI's dispute summary endpoint.
   */
  async generateSummary(disputeId: string): Promise<DisputeAiSummaryResult> {
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true,
        openedById: true,
        reason: true,
        description: true,
        evidence: true,
        request: { select: { id: true, clientProfile: { select: { userId: true } } } },
        project: {
          select: {
            id: true,
            contract: {
              select: {
                clientId: true,
                stages: {
                  orderBy: { stepOrder: 'asc' },
                  select: {
                    stepOrder: true,
                    title: true,
                    status: true,
                    deliveries: { orderBy: { submittedAt: 'desc' }, take: 1, select: { status: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const clientUserId = dispute.project?.contract?.clientId ?? dispute.request?.clientProfile?.userId;
    if (!clientUserId) throw new AppError('تعذر تحديد أطراف النزاع لإنشاء الملخص', 422);

    const openerIsClient = dispute.openedById === clientUserId;
    const openerClaim = [cap(dispute.reason, 500), cap(dispute.description)].filter(Boolean).join(' — ');
    const noClaim = 'لا يوجد ادعاء مسجل من هذا الطرف في النظام.';

    const evidenceList: string[] = [];
    const attachmentCount = dispute.evidence?.length ?? 0;
    if (attachmentCount > 0) {
      evidenceList.push(`${attachmentCount} مرفق(ات) مقدمة من ${openerIsClient ? 'العميل' : 'مقدم الخدمة'} (لم يُفحص محتواها)`);
    }
    for (const stage of dispute.project?.contract?.stages ?? []) {
      const delivery = stage.deliveries[0];
      evidenceList.push(`المرحلة ${stage.stepOrder}: ${cap(stage.title, 150)} — الحالة: ${stage.status}${delivery ? ` — آخر تسليم: ${delivery.status}` : ' — لا تسليم'}`);
    }

    const payload: DisputeSummaryRequest = {
      disputeId: dispute.id,
      projectId: dispute.project?.id ?? dispute.request?.id ?? dispute.id,
      clientClaim: openerIsClient ? openerClaim : noClaim,
      providerClaim: openerIsClient ? noClaim : openerClaim,
      evidenceList: evidenceList.slice(0, 20),
    };

    return this.generateFromPayload(payload);
  }

  /**
   * Calls Waseet AI microservice with the prepared dispute summary payload.
   */
  async generateFromPayload(payload: DisputeSummaryRequest): Promise<DisputeAiSummaryResult> {
    try {
      const data = await waseetAiClient.summarizeDispute(payload);
      const mapped = mapToDisputeSummary(data);

      if (!mapped || FORBIDDEN_SUMMARY_KEYS.filter((k) => k !== 'recommendation').some((k) => k in (data as object))) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI dispute summary failed validation');
      }

      return mapped;
    } catch (error: unknown) {
      const normalized = normalizeWaseetAiError(error);
      console.error('[DisputeSummaryService] AI summary generation failed:', normalized.code, normalized.status);
      throw error;
    }
  }
}

export const disputeSummaryService = new DisputeSummaryService();
