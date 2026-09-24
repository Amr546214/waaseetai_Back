import { AmendmentRequesterRole, AmendmentStatus, AmendmentType, ContractStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

const AMENDMENT_TYPES: AmendmentType[] = ['SCOPE', 'BUDGET', 'DURATION', 'MIXED'];
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 5000;

// Rejects NaN/Infinity/non-numbers outright rather than silently coercing
// them to "not supplied" — a client that sent a bad number must see a 400,
// never have it quietly become null and pass validation under a different
// reading of the request.
const parseOptionalFiniteNumber = (value: unknown, label: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AppError(`قيمة ${label} غير صالحة`, 400);
  return value;
};

const parseOptionalFiniteInteger = (value: unknown, label: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) throw new AppError(`قيمة ${label} غير صالحة`, 400);
  return value;
};

const toPublicAmendment = (row: any, conversationId: string | null) => ({
  id: row.id,
  projectId: row.projectId,
  projectTitle: row.project.title,
  contractId: row.contractId,
  contractRef: `CT-${row.contractId.slice(0, 6).toUpperCase()}`,
  providerId: row.providerId,
  providerName: `${row.provider.firstName || 'مقدم الخدمة'} ${row.provider.lastName || ''}`.trim(),
  requestedByRole: row.requestedByRole,
  type: row.type,
  title: row.title,
  description: row.description,
  budgetDelta: row.budgetDelta,
  durationDeltaDays: row.durationDeltaDays,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  respondedAt: row.respondedAt,
  conversationId
});

export class ProjectAmendmentService {
  // Resolves the single real conversation for a given project+provider pair,
  // reusing the same unique relationship the rest of the app already relies
  // on (Conversation.@@unique([projectId, providerId])) — never guesses or
  // falls back to an unrelated conversation.
  private async resolveConversationIds(pairs: { projectId: string; providerId: string }[]) {
    const uniquePairs = Array.from(new Map(pairs.map(p => [`${p.projectId}:${p.providerId}`, p])).values());
    if (!uniquePairs.length) return new Map<string, string>();
    const conversations = await prisma.conversation.findMany({
      where: { OR: uniquePairs.map(p => ({ projectId: p.projectId, providerId: p.providerId })) },
      select: { id: true, projectId: true, providerId: true }
    });
    return new Map(conversations.map(c => [`${c.projectId}:${c.providerId}`, c.id]));
  }

  // Real amendments belonging to the authenticated client only — ownership is
  // enforced at the Prisma WHERE clause itself, not by post-filtering.
  async listAmendments(clientId: string) {
    const rows = await prisma.projectAmendment.findMany({
      where: { clientId },
      orderBy: { updatedAt: 'desc' },
      include: {
        project: { select: { title: true } },
        provider: { select: { firstName: true, lastName: true } }
      }
    });
    const convMap = await this.resolveConversationIds(rows.map(r => ({ projectId: r.projectId, providerId: r.providerId })));
    return rows.map(row => toPublicAmendment(row, convMap.get(`${row.projectId}:${row.providerId}`) || null));
  }

  async createAmendment(
    clientId: string,
    projectId: string,
    input: { title?: string; description?: string; type?: string; budgetDelta?: number; durationDeltaDays?: number }
  ) {
    const title = input.title?.trim();
    if (!title) throw new AppError('أضف عنوانًا لطلب التعديل', 400);
    if (title.length > TITLE_MAX_LENGTH) throw new AppError(`العنوان طويل جدًا (الحد الأقصى ${TITLE_MAX_LENGTH} حرفًا)`, 400);

    const type = input.type as AmendmentType;
    if (!AMENDMENT_TYPES.includes(type)) throw new AppError('نوع التعديل غير صالح', 400);

    const description = input.description?.trim() || null;
    if (description && description.length > DESCRIPTION_MAX_LENGTH) throw new AppError(`الوصف طويل جدًا (الحد الأقصى ${DESCRIPTION_MAX_LENGTH} حرفًا)`, 400);

    // NaN/Infinity/wrong-typed values are rejected outright (400), not
    // silently coerced to "not supplied" — see parseOptionalFinite* above.
    let budgetDelta = parseOptionalFiniteNumber(input.budgetDelta, 'الميزانية');
    if (budgetDelta === 0) budgetDelta = null; // a zero delta means "no real budget change", same as omitting it
    let durationDeltaDays = parseOptionalFiniteInteger(input.durationDeltaDays, 'المدة');
    if (durationDeltaDays === 0) durationDeltaDays = null; // same for duration

    const hasScope = !!(description && description.length > 0);
    const hasBudget = budgetDelta !== null;
    const hasDuration = durationDeltaDays !== null;

    // The declared type must genuinely match what was supplied — a client
    // can never claim type=BUDGET while only a duration change (or nothing
    // meaningful at all) was actually provided.
    if (type === AmendmentType.SCOPE && !hasScope) {
      throw new AppError('تعديل النطاق يتطلب وصفًا يوضح التغيير المطلوب', 400);
    }
    if (type === AmendmentType.BUDGET && !hasBudget) {
      throw new AppError('تعديل الميزانية يتطلب قيمة تغيير فعلية غير صفرية', 400);
    }
    if (type === AmendmentType.DURATION && !hasDuration) {
      throw new AppError('تعديل المدة يتطلب عدد أيام تغيير فعلي غير صفري', 400);
    }
    if (type === AmendmentType.MIXED) {
      const dimensionCount = [hasScope, hasBudget, hasDuration].filter(Boolean).length;
      if (dimensionCount < 2) throw new AppError('التعديل المتعدد يتطلب بُعدين على الأقل من التغيير: نطاق أو ميزانية أو مدة', 400);
    }

    const contract = await prisma.contract.findFirst({
      where: { projectId, clientId, status: ContractStatus.ACTIVE }
    });
    if (!contract) throw new AppError('المشروع غير موجود أو العقد غير نشط أو لا تملك صلاحية إنشاء تعديل عليه', 403);

    const created = await prisma.projectAmendment.create({
      data: {
        projectId,
        contractId: contract.id,
        clientId: contract.clientId,
        providerId: contract.providerId,
        requestedById: clientId,
        requestedByRole: AmendmentRequesterRole.CLIENT,
        type,
        title,
        description,
        budgetDelta,
        durationDeltaDays,
        status: AmendmentStatus.PENDING_OTHER_PARTY
      },
      include: {
        project: { select: { title: true } },
        provider: { select: { firstName: true, lastName: true } }
      }
    });

    const convMap = await this.resolveConversationIds([{ projectId: created.projectId, providerId: created.providerId }]);
    return toPublicAmendment(created, convMap.get(`${created.projectId}:${created.providerId}`) || null);
  }

  // Only the owning client may respond here, and only to an amendment the
  // PROVIDER raised (a client never approves/rejects their own request) that
  // is still genuinely pending. This phase records the decision only — it
  // never mutates Contract.price, Escrow, or ProjectStage amounts.
  //
  // The write is a single atomic conditional updateMany() whose WHERE clause
  // repeats every guard (ownership, requester role, still-pending status).
  // Two simultaneous respond() calls can both read the row as pending, but
  // only one can ever match this WHERE at UPDATE time — Postgres's row lock
  // means the second call's updateMany simply matches zero rows once the
  // first has committed. First successful decision wins; a later racing
  // request can never overwrite it.
  async respondToAmendment(clientId: string, amendmentId: string, decision: 'approve' | 'reject') {
    if (decision !== 'approve' && decision !== 'reject') throw new AppError('قرار غير صالح', 400);

    const result = await prisma.projectAmendment.updateMany({
      where: {
        id: amendmentId,
        clientId,
        requestedByRole: AmendmentRequesterRole.PROVIDER,
        status: AmendmentStatus.PENDING_OTHER_PARTY
      },
      data: {
        status: decision === 'approve' ? AmendmentStatus.APPROVED : AmendmentStatus.REJECTED,
        respondedAt: new Date()
      }
    });

    if (result.count !== 1) {
      // The conditional write didn't happen — diagnose why for an accurate
      // error, without this read ever granting a write of its own.
      const existing = await prisma.projectAmendment.findFirst({ where: { id: amendmentId, clientId } });
      if (!existing) throw new AppError('طلب التعديل غير موجود أو لا تملك صلاحية الوصول إليه', 403);
      if (existing.requestedByRole !== AmendmentRequesterRole.PROVIDER) throw new AppError('لا يمكنك الرد على طلب تعديل رفعته أنت', 403);
      // Either already terminal before this call, or lost the race to a
      // concurrent respond() that committed first.
      throw new AppError('تم الرد على طلب التعديل هذا مسبقًا', 409);
    }

    const updated = await prisma.projectAmendment.findFirst({
      where: { id: amendmentId },
      include: {
        project: { select: { title: true } },
        provider: { select: { firstName: true, lastName: true } }
      }
    });

    const convMap = await this.resolveConversationIds([{ projectId: updated!.projectId, providerId: updated!.providerId }]);
    return toPublicAmendment(updated, convMap.get(`${updated!.projectId}:${updated!.providerId}`) || null);
  }
}

export const projectAmendmentService = new ProjectAmendmentService();
