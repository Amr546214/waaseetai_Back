import { prisma } from '../../config/db';
import { AppError } from '../../utils/app-error';
import { waseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import { WaseetAiError, WaseetAiErrorCode, normalizeWaseetAiError } from '../ai/waseet-ai/waseet-ai.errors';
import type { DisputeSummaryRequest } from '../ai/waseet-ai/waseet-ai.types';
import { parseContractMilestones, readOfferTerms } from '../../utils/contract-terms';
import { scrubFreeText } from '../llm/llm.payload';
import { redact } from '../../utils/audit-detail-sanitizer';

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

const cap = (text: string | null | undefined, max = 1500) => redact(scrubFreeText(text, max), max);
const timestamp = (date: Date | null | undefined) => date?.toISOString() ?? 'بلا تاريخ مسجل';
const partyLabel = { client: 'العميل', provider: 'مقدم الخدمة' };

export class DisputeSummaryService {
  constructor(
    private readonly db: Pick<typeof prisma, 'dispute'> = prisma,
    private readonly ai: Pick<typeof waseetAiClient, 'summarizeDispute'> = waseetAiClient
  ) {}

  /**
   * Summarizes a dispute for administrative review by loading dispute data from the DB,
   * minimizing claims/evidence, and calling Waseet AI's dispute summary endpoint.
   */
  async generateSummary(disputeId: string): Promise<DisputeAiSummaryResult> {
    const dispute = await this.db.dispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true,
        openedById: true,
        againstUserId: true,
        stageId: true,
        reason: true,
        description: true,
        evidence: true,
        attachments: { select: { ownerId: true } },
        messages: {
          where: { authorKind: 'PARTICIPANT', authorId: { not: null } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 30,
          select: { authorId: true, authorKind: true, body: true, createdAt: true },
        },
        request: { select: { id: true, clientProfile: { select: { userId: true } } } },
        project: {
          select: {
            id: true,
            contract: {
              select: {
                clientId: true,
                providerId: true,
                terms: true,
                termsVersion: true,
                signedAt: true,
                projectConversation: {
                  select: { messages: {
                    where: { type: 'TEXT', content: { not: null } },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    take: 8,
                    select: { senderId: true, content: true, createdAt: true },
                  } },
                },
                amendments: {
                  where: { status: 'APPROVED', appliedAt: { not: null } },
                  orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
                  take: 5,
                  select: { title: true, description: true, type: true, appliedAt: true, durationAfter: true },
                },
                stages: {
                  orderBy: { stepOrder: 'asc' },
                  select: {
                    id: true,
                    stepOrder: true,
                    title: true,
                    status: true,
                    deliveries: {
                      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
                      take: 1,
                      select: { status: true, submittedAt: true, reviewedAt: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const contract = dispute.project?.contract;
    const clientUserId = contract?.clientId ?? dispute.request?.clientProfile?.userId;
    if (!clientUserId) throw new AppError('تعذر تحديد أطراف النزاع لإنشاء الملخص', 422);

    const openerIsClient = dispute.openedById === clientUserId;
    const providerUserId = contract?.providerId ?? (openerIsClient ? dispute.againstUserId : dispute.openedById);
    const partyOf = (userId: string | null) => userId === clientUserId ? 'client' : userId && userId === providerUserId ? 'provider' : null;
    const openerClaim = [cap(dispute.reason, 500), cap(dispute.description)].filter(Boolean).join(' — ');
    const claimFor = (party: 'client' | 'provider') => {
      const replies = (dispute.messages ?? [])
        .filter(message => message.authorKind === 'PARTICIPANT' && partyOf(message.authorId) === party)
        .slice(0, 3).reverse()
        .map(message => `رد مسجل في ${timestamp(message.createdAt)}: ${cap(message.body, 400)}`);
      const isOpener = (party === 'client') === openerIsClient;
      return [isOpener ? openerClaim : '', ...replies].filter(Boolean).join('\n') || 'لا يوجد ادعاء مسجل من هذا الطرف ضمن الأدلة المسترجعة.';
    };

    const evidenceList: string[] = [];
    const attachmentCount = dispute.evidence?.length ?? 0;
    if (attachmentCount > 0) {
      evidenceList.push(`${attachmentCount} مرفق(ات) مقدمة من ${openerIsClient ? 'العميل' : 'مقدم الخدمة'} (لم يُفحص محتواها)`);
    }
    for (const party of ['client', 'provider'] as const) {
      const count = (dispute.attachments ?? []).filter(f => partyOf(f.ownerId) === party).length;
      if (count) evidenceList.push(`${count} مرفق(ات) إضافية مقدمة من ${partyLabel[party]} (لم يُفحص محتواها)`);
    }
    for (const amendment of contract?.amendments ?? []) {
      if (!amendment.appliedAt) continue;
      evidenceList.push(`تعديل عقد مطبّق في ${timestamp(amendment.appliedAt)} (${amendment.type}): ${cap(amendment.title, 150)} — ${cap(amendment.description, 500)}${amendment.durationAfter != null ? ` — المدة بعد التطبيق: ${amendment.durationAfter} يومًا` : ''}`);
    }
    const stages = [...(contract?.stages ?? [])].sort((a, b) => Number(b.id === dispute.stageId) - Number(a.id === dispute.stageId));
    for (const stage of stages.slice(0, 8)) {
      const delivery = stage.deliveries[0];
      evidenceList.push(`المرحلة ${stage.stepOrder}${stage.id && stage.id === dispute.stageId ? ' محل النزاع' : ''}: ${cap(stage.title, 150)} — الحالة: ${stage.status}${delivery ? ` — آخر تسليم: ${delivery.status} في ${timestamp(delivery.submittedAt)}${delivery.reviewedAt ? `، المراجعة: ${timestamp(delivery.reviewedAt)}` : ''}` : ' — لا تسليم'}`);
    }
    const discussion = (contract?.projectConversation?.messages ?? [])
      .filter(message => partyOf(message.senderId) && message.content?.trim())
      .slice(0, 4).reverse();
    for (const message of discussion) {
      const party = partyOf(message.senderId);
      if (party) evidenceList.push(`نقاش المشروع (سياق فقط، وليس بندًا تعاقديًا) — ${partyLabel[party]} في ${timestamp(message.createdAt)}: ${cap(message.content, 300)}`);
    }

    const offer = readOfferTerms(contract?.terms);
    const milestones = parseContractMilestones(contract?.terms);
    const writtenTerms = typeof contract?.terms === 'string' && !milestones.length && !offer ? cap(contract.terms, 1200) : '';
    const contractTerms = contract && [
      `نسخة الشروط المحفوظة: ${contract.termsVersion} — اكتمال التوقيع: ${timestamp(contract.signedAt)}`,
      writtenTerms,
      offer?.summary && `ملخص العرض المثبت: ${cap(offer.summary, 1000)}`,
      offer?.deliverables && `التسليمات المثبتة: ${cap(offer.deliverables, 1500)}`,
      ...milestones.slice(0, 12).map(stage => `البند ${stage.order}: ${cap(stage.title, 120)} — ${cap(stage.description, 300)}`),
    ].filter(Boolean).join('\n');

    const payload: DisputeSummaryRequest = {
      disputeId: dispute.id,
      projectId: dispute.project?.id ?? dispute.request?.id ?? dispute.id,
      clientClaim: claimFor('client'),
      providerClaim: claimFor('provider'),
      ...(contractTerms ? { contractTerms } : {}),
      evidenceList: evidenceList.slice(0, 20),
    };

    return this.generateFromPayload(payload);
  }

  /**
   * Calls Waseet AI microservice with the prepared dispute summary payload.
   */
  async generateFromPayload(payload: DisputeSummaryRequest): Promise<DisputeAiSummaryResult> {
    try {
      const data = await this.ai.summarizeDispute(payload);
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
