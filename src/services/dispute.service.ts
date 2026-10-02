import { ContractStatus, DisputeStatus, EscrowStatus, RequestStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateDisputeInput, ResolveDisputeInput } from '../dtos/dispute.dto';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import { WaseetAiError, WaseetAiErrorCode } from './ai/waseet-ai/waseet-ai.errors';

// Advisory-only dispute summary — never a verdict. Human admin resolution
// via resolve() above remains the sole authority on status/fault/money;
// this call performs zero DB writes and cannot influence that decision.
export interface DisputeAiSummary {
  summary: string;
  clientPerspective: string;
  providerPerspective: string;
}

const MAX_TEXT_FIELD_LENGTH = 2000;

// WaseetAI also returns a `recommendation` (a proposed settlement). It is
// deliberately never read, mapped, returned or logged: the human admin's
// resolve() is the only path that decides anything about the dispute.
const FORBIDDEN_SUMMARY_KEYS = ['winner', 'loser', 'verdict', 'faultPercentage', 'recommendation', 'recommendedResolution', 'releaseFunds', 'refundAmount', 'confidence', 'confidenceOfGuilt'];

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/** Maps a WaseetAI response to the advisory-only shape. Returns null when a
 *  required field is missing/oversized; never invents a replacement value. */
function toDisputeAiSummary(value: unknown): DisputeAiSummary | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isNonEmptyBoundedString(v.summary, MAX_TEXT_FIELD_LENGTH)) return null;
  if (!isNonEmptyBoundedString(v.clientPerspective, MAX_TEXT_FIELD_LENGTH)) return null;
  if (!isNonEmptyBoundedString(v.providerPerspective, MAX_TEXT_FIELD_LENGTH)) return null;
  return { summary: v.summary, clientPerspective: v.clientPerspective, providerPerspective: v.providerPerspective };
}

const cap = (text: string | null | undefined, max = 1500) => (text ? text.slice(0, max) : '');

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
   * Advisory-only WaseetAI summary of a dispute for the human admin reviewer.
   * Read-only: zero DB writes, never touches status/resolution/escrow. The
   * admin's resolve() above remains the only path that can change anything.
   *
   * Data minimisation: only the opener's recorded claim, an anonymous
   * evidence/stage list and opaque ids leave the system — no names, emails,
   * attachment URLs, stage descriptions or delivery notes. The upstream
   * `recommendation` field is discarded.
   */
  async generateAiSummary(id: string): Promise<DisputeAiSummary> {
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        request: { select: { id: true, clientProfile: { select: { userId: true } } } },
        project: {
          select: {
            id: true,
            contract: {
              select: {
                clientId: true,
                stages: {
                  orderBy: { stepOrder: 'asc' },
                  select: { stepOrder: true, title: true, status: true, deliveries: { orderBy: { submittedAt: 'desc' }, take: 1, select: { status: true } } },
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
    if (attachmentCount > 0) evidenceList.push(`${attachmentCount} مرفق(ات) مقدمة من ${openerIsClient ? 'العميل' : 'مقدم الخدمة'} (لم يُفحص محتواها)`);
    for (const stage of dispute.project?.contract?.stages ?? []) {
      const delivery = stage.deliveries[0];
      evidenceList.push(`المرحلة ${stage.stepOrder}: ${cap(stage.title, 150)} — الحالة: ${stage.status}${delivery ? ` — آخر تسليم: ${delivery.status}` : ' — لا تسليم'}`);
    }

    try {
      const data = await waseetAiClient.summarizeDispute({
        disputeId: dispute.id,
        projectId: dispute.project?.id ?? dispute.request?.id ?? dispute.id,
        clientClaim: openerIsClient ? openerClaim : noClaim,
        providerClaim: openerIsClient ? noClaim : openerClaim,
        evidenceList: evidenceList.slice(0, 20),
      });
      const mapped = toDisputeAiSummary(data);
      if (!mapped || FORBIDDEN_SUMMARY_KEYS.filter((k) => k !== 'recommendation').some((k) => k in (data as object))) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI dispute summary failed validation');
      }
      return mapped;
    } catch (error: any) {
      console.error('[DisputeService] AI summary generation failed:', error?.code || error?.message);
      throw error;
    }
  }
}

export const disputeService = new DisputeService();
