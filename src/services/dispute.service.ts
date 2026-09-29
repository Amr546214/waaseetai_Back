import { ContractStatus, DisputeStatus, EscrowStatus, RequestStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateDisputeInput, ResolveDisputeInput } from '../dtos/dispute.dto';
import { geminiClient } from './ai/gemini/gemini.client';

// Advisory-only dispute summary — never a verdict. Human admin resolution
// via resolve() above remains the sole authority on status/fault/money;
// this call performs zero DB writes and cannot influence that decision.
export interface DisputeAiSummary {
  caseSummary: string;
  timelineSummary: string;
  evidenceSummary: string[];
  evidenceGaps: string[];
  suggestedQuestions: string[];
}

const MAX_TEXT_FIELD_LENGTH = 900;
const MAX_ARRAY_ITEM_LENGTH = 300;
const MAX_ARRAY_ITEMS = 8;

const DISPUTE_AI_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    caseSummary: { type: 'string', description: 'ملخص محايد لموضوع النزاع بالاعتماد فقط على البيانات المرفقة، بدون تحديد المذنب أو الفائز.' },
    timelineSummary: { type: 'string', description: 'ملخص التسلسل الزمني للطلب/المشروع والمراحل المرتبطة به حتى فتح النزاع.' },
    evidenceSummary: { type: 'array', items: { type: 'string' }, description: 'وصف موجز لكل دليل مرفق كمرجع فقط دون الادعاء بفحص محتواه.' },
    evidenceGaps: { type: 'array', items: { type: 'string' }, description: 'نقاط أو معلومات ناقصة قد يحتاجها المراجع البشري لاتخاذ قرار.' },
    suggestedQuestions: { type: 'array', items: { type: 'string' }, description: 'أسئلة مقترحة يمكن للمراجع البشري طرحها على الطرفين.' },
  },
  required: ['caseSummary', 'timelineSummary', 'evidenceSummary', 'evidenceGaps', 'suggestedQuestions'],
};

const DISPUTE_AI_SUMMARY_SYSTEM_PROMPT = `أنت مساعد يلخّص نزاعاً لمراجع بشري (إداري) في منصة وسيط AI. دورك استشاري بحت.
ممنوع تماماً: تحديد الطرف المذنب أو الفائز، إصدار حكم أو قرار نهائي، اقتراح نسبة مسؤولية أو خطأ (fault percentage)، التوصية بحل معين أو بالإفراج عن أموال أو استرداد مبلغ، أو التعبير عن أي "ثقة بالإدانة".
القرار النهائي في كل نزاع يعود حصرياً للمراجع البشري (إداري/مشرف عام) عبر مسار الموافقة اليدوي القائم؛ أنت لا تشارك في اتخاذه إطلاقاً.
روابط الأدلة المرفقة هنا هي مراجع فقط — لم يتم فتح أو فحص محتواها فعلياً، فلا تدّعِ أنك اطّلعت على محتوى أي ملف أو رابط؛ صِفها فقط كمرجع مرفق من طرف معيّن.
استخدم فقط المعلومات المذكورة صراحة أدناه. إن كانت معلومة غير متوفرة، اذكر ذلك بصراحة في evidenceGaps بدل افتراضها أو اختراعها.
أجب بالعربية الفصحى الواضحة والمختصرة.`;

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isBoundedStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return false;
  return value.every((item) => typeof item === 'string' && item.length <= MAX_ARRAY_ITEM_LENGTH);
}

const FORBIDDEN_SUMMARY_KEYS = ['winner', 'loser', 'verdict', 'faultPercentage', 'recommendedResolution', 'releaseFunds', 'refundAmount', 'confidence', 'confidenceOfGuilt'];

function isValidDisputeAiSummary(value: unknown): value is DisputeAiSummary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (FORBIDDEN_SUMMARY_KEYS.some((key) => key in v)) return false;
  if (!isNonEmptyBoundedString(v.caseSummary, MAX_TEXT_FIELD_LENGTH)) return false;
  if (!isNonEmptyBoundedString(v.timelineSummary, MAX_TEXT_FIELD_LENGTH)) return false;
  if (!isBoundedStringArray(v.evidenceSummary)) return false;
  if (!isBoundedStringArray(v.evidenceGaps)) return false;
  if (!isBoundedStringArray(v.suggestedQuestions)) return false;
  return true;
}

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
    // Phase 4 — this used to flip ONLY ClientRequest.status to CANCELLED,
    // leaving the Contract ACTIVE, the Project IN_PROGRESS and the client's
    // Escrow HELD (funds stranded, related records contradicting each other).
    // A funded, signed engagement has no safe unilateral cancel+refund path
    // yet (no CANCELLED ProjectStatus, no escrow-refund flow), so it must go
    // through a dispute / admin resolution instead of silently diverging.
    const [activeContract, heldEscrow] = await Promise.all([
      prisma.contract.findFirst({ where: { projectId: requestId, status: { in: [ContractStatus.ACTIVE, ContractStatus.PENDING_PROVIDER_SIGNATURE, ContractStatus.DISPUTED] } }, select: { id: true } }),
      prisma.escrow.findFirst({ where: { projectId: requestId, status: EscrowStatus.HELD }, select: { id: true } })
    ]);
    if (activeContract || heldEscrow) {
      throw new AppError('لا يمكن إلغاء مشروع مموَّل بعقد نشط من طرف واحد — افتح نزاعاً ليتم الفصل وإعادة المبلغ المحتجز عبر الإدارة', 409);
    }
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

  // A user is a party to a dispute if they opened it or it was opened
  // against them — same two columns admin's listForAdmin()/getForAdmin()
  // already expose, just scoped down to "my own" instead of "everyone's".
  async listForUser(userId: string, status?: DisputeStatus, page = 1, limit = 20) {
    const safePage = Math.max(1, page); const safeLimit = Math.min(100, Math.max(1, limit));
    const where = { OR: [{ openedById: userId }, { againstUserId: userId }], ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      prisma.dispute.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { request: { select: { id: true, title: true } }, openedBy: { select: { id: true, firstName: true, lastName: true } }, againstUser: { select: { id: true, firstName: true, lastName: true } } } }),
      prisma.dispute.count({ where })
    ]);
    return { items, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
  }

  async getForUser(id: string, userId: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id }, include: { request: true, project: true, openedBy: { select: { id: true, firstName: true, lastName: true } }, againstUser: { select: { id: true, firstName: true, lastName: true } }, resolvedBy: { select: { id: true, firstName: true, lastName: true } } } });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);
    if (dispute.openedById !== userId && dispute.againstUserId !== userId) throw new AppError('لا تملك صلاحية الوصول لهذا النزاع', 403);
    return dispute;
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

  /**
   * Advisory-only Gemini summary of a dispute for the human admin reviewer.
   * Read-only: zero DB writes, never touches status/resolution/escrow. The
   * admin's resolve() above remains the only path that can change anything.
   */
  async generateAiSummary(id: string): Promise<DisputeAiSummary> {
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        request: { select: { title: true, description: true } },
        project: {
          select: {
            title: true,
            description: true,
            contract: {
              select: {
                stages: {
                  orderBy: { stepOrder: 'asc' },
                  select: {
                    stepOrder: true,
                    title: true,
                    description: true,
                    status: true,
                    deliveries: {
                      orderBy: { submittedAt: 'desc' },
                      take: 1,
                      select: { note: true, status: true, submittedAt: true },
                    },
                  },
                },
              },
            },
          },
        },
        openedBy: { select: { firstName: true, lastName: true } },
        againstUser: { select: { firstName: true, lastName: true } },
      },
    });
    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const cap = (text: string | null | undefined, max = 2000) => (text ? text.slice(0, max) : 'غير متوفر');

    const promptLines: string[] = [
      `سبب النزاع: ${cap(dispute.reason, 500)}`,
      `وصف النزاع: ${cap(dispute.description)}`,
      `الطرف الذي فتح النزاع: ${dispute.openedBy ? `${dispute.openedBy.firstName} ${dispute.openedBy.lastName}` : 'غير معروف'}`,
      `الطرف الآخر: ${dispute.againstUser ? `${dispute.againstUser.firstName} ${dispute.againstUser.lastName}` : 'غير معروف'}`,
      `تاريخ فتح النزاع: ${dispute.createdAt.toISOString()}`,
    ];

    const title = dispute.project?.title || dispute.request?.title;
    const description = dispute.project?.description || dispute.request?.description;
    if (title) promptLines.push(`عنوان الطلب/المشروع: ${cap(title, 300)}`);
    if (description) promptLines.push(`وصف الطلب/المشروع: ${cap(description)}`);

    const stages = dispute.project?.contract?.stages || [];
    if (stages.length > 0) {
      promptLines.push('مراحل المشروع (بالترتيب):');
      for (const stage of stages) {
        const latestDelivery = stage.deliveries[0];
        promptLines.push(
          `- المرحلة ${stage.stepOrder}: "${cap(stage.title, 200)}" — الوصف الموعود: ${cap(stage.description, 400)} — الحالة: ${stage.status}` +
            (latestDelivery ? ` — آخر تسليم مُرسَل (${latestDelivery.status}): ${cap(latestDelivery.note, 400)}` : ' — لا يوجد تسليم مُرسَل بعد'),
        );
      }
    } else {
      promptLines.push('لا توجد بيانات مراحل مشروع مرتبطة بهذا النزاع.');
    }

    if (dispute.evidence && dispute.evidence.length > 0) {
      promptLines.push(
        `روابط أدلة مرفقة (مراجع فقط، لم يتم فتح أو فحص محتواها): ${dispute.evidence.slice(0, 10).map((url) => cap(url, 300)).join(' | ')}`,
      );
    } else {
      promptLines.push('لا توجد أدلة مرفقة على هذا النزاع.');
    }

    try {
      const result = await geminiClient.generateStructured<DisputeAiSummary>(promptLines.join('\n'), {
        systemInstruction: DISPUTE_AI_SUMMARY_SYSTEM_PROMPT,
        responseSchema: DISPUTE_AI_SUMMARY_SCHEMA,
        validate: isValidDisputeAiSummary,
        temperature: 0.3,
        maxOutputTokens: 900,
        timeoutMs: 25 * 1000,
      });
      return result.data;
    } catch (error: any) {
      console.error('[DisputeService] AI summary generation failed:', error?.code || error?.message);
      throw error;
    }
  }
}

export const disputeService = new DisputeService();
