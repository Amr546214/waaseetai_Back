import { OnboardingStatus, KYCStatus, LogCategory, LogStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { notifyAdmins } from './admin-notifications.service';
import { AppError } from '../utils/app-error';
import { RejectOnboardingInput } from '../dtos/onboarding.dto';
import { AdminActor, adminAuditData } from './admin-audit';
import { providerNotifications } from './provider-notifications.service';
import { clientNotifications, clientNotificationFor } from './client-notifications.service';

type ListedUser = { id: string; firstName?: string | null; lastName?: string | null; email?: string | null; phoneNumber?: string | null; accountType?: string | null } | null | undefined;

/** The admin lists show who owns a request: the flat fields the admin pages read (userName / userEmail / userPhone / accountType), next to the nested user. */
export function flatOwnerFields(user: ListedUser) {
  return {
    userName: user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || null : null,
    userEmail: user?.email ?? null,
    userPhone: user?.phoneNumber ?? null,
    accountType: user?.accountType ?? null,
  };
}

/** How many KYC documents the provider has on file (ID front/back, selfie, supporting document, certificates). */
export function providerDocumentsCount(p: { frontIdUrl?: string | null; backIdUrl?: string | null; selfieUrl?: string | null; supportingDocsUrl?: string | null; certUrls?: string[] | null }) {
  return [p.frontIdUrl, p.backIdUrl, p.selfieUrl, p.supportingDocsUrl].filter(Boolean).length + (Array.isArray(p.certUrls) ? p.certUrls.filter(Boolean).length : 0);
}

/** The id of a provider's NEW identity document that waits in the change-request queue (DOCUMENTS + idDocumentUrl, PENDING_HUMAN_REVIEW), or null. */
const hasIdentityDocument = (metadata: unknown): boolean => {
  const changes = ((metadata ?? {}) as { changes?: Record<string, unknown> }).changes ?? {};
  return typeof changes.idDocumentUrl === 'string' && changes.idDocumentUrl.length > 0;
};
export const pendingIdentityRequests = async (providerIds: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  if (!providerIds.length) return out;
  const rows = await prisma.profileModificationRequest.findMany({
    where: { providerId: { in: providerIds }, category: 'DOCUMENTS', status: 'PENDING_HUMAN_REVIEW' as any },
    orderBy: { createdAt: 'desc' }, select: { id: true, providerId: true, metadata: true }
  });
  for (const r of rows) if (hasIdentityDocument(r.metadata) && !out.has(r.providerId)) out.set(r.providerId, r.id);
  return out;
};
const IDENTITY_REQUEST_WAITING = 'يوجد مستند هوية جديد بانتظار المراجعة في طلبات تعديل الملف. راجِعه من هناك، ولا تُتخذ هنا خطوة على المستند السابق.';

export class OnboardingService {
  async saveUpload(userId: string, input: { documentType: string; documentUrl: string; documentName: string }) {
    const record = await prisma.clientOnboarding.upsert({ where: { userId }, create: { userId, documentType: input.documentType, documentUrl: input.documentUrl, documentName: input.documentName, status: OnboardingStatus.PENDING }, update: { documentType: input.documentType, documentUrl: input.documentUrl, documentName: input.documentName, status: OnboardingStatus.PENDING, rejectionReason: null, reviewedAt: null } });
    // User.idDocumentUrl is NOT written here: it feeds the profile completion, which assumes an approved document. It is set when the
    // reviewer approves this record (approveOnboarding), so an unreviewed upload never counts as a verified document.
    return record;
  }

  /**
   * Called when the client setup wizard is submitted (AUD-FND-000044). When the identity documents are complete (idNumber + front + back)
   * a ClientOnboarding row exists in PENDING so the submission shows up in the admin review list:
   *  - no row            → created PENDING
   *  - PENDING           → documents refreshed, no duplicate
   *  - REJECTED          → back to PENDING (re-submission), rejection reason cleared
   *  - APPROVED          → left untouched (an approved client is never pushed back to review)
   * The profile's kycStatus moves UNVERIFIED/REJECTED → PENDING only together with the review row; VERIFIED is never downgraded.
   * Incomplete documents create nothing and leave kycStatus alone.
   */
  async submitSetupDocuments(userId: string, docs: { idNumber?: string | null; frontIdUrl?: string | null; backIdUrl?: string | null }, options: { identityChanged?: boolean } = {}) {
    if (!docs.idNumber || !docs.frontIdUrl || !docs.backIdUrl) return null;
    // A save that submits the SAME identity as before never re-opens a review: a REJECTED / UNVERIFIED profile stays as it is until the
    // client really changes the identity or its documents (default true keeps every other caller unchanged).
    if (options.identityChanged === false) return prisma.clientOnboarding.findUnique({ where: { userId } });
    const fields = { documentType: 'NATIONAL_ID', documentUrl: docs.frontIdUrl, documentName: 'الهوية الوطنية / الإقامة' };
    const existing = await prisma.clientOnboarding.findUnique({ where: { userId } });
    let record = existing;
    if (!existing) {
      record = await prisma.clientOnboarding.create({ data: { userId, ...fields, status: OnboardingStatus.PENDING } });
    } else if (existing.status === OnboardingStatus.REJECTED) {
      record = await prisma.clientOnboarding.update({ where: { userId }, data: { ...fields, status: OnboardingStatus.PENDING, rejectionReason: null, reviewedAt: null } });
    } else if (existing.status === OnboardingStatus.PENDING) {
      record = await prisma.clientOnboarding.update({ where: { userId }, data: fields });
    }
    if (!existing || existing.status !== OnboardingStatus.APPROVED) {
      await prisma.clientProfile.updateMany({ where: { userId, kycStatus: { in: [KYCStatus.UNVERIFIED, KYCStatus.REJECTED] } }, data: { kycStatus: KYCStatus.PENDING } });
      void notifyAdmins('KYC_SUBMITTED', { ref: 'عميل' });
    }
    return record;
  }

  async getStatus(userId: string) {
    const record = await prisma.clientOnboarding.findUnique({ where: { userId } });
    return record || { userId, status: OnboardingStatus.PENDING, documentUrl: null, documentName: null, documentType: null, rejectionReason: null, reviewedAt: null };
  }

  async listOnboarding(status?: OnboardingStatus, page = 1, limit = 10) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      prisma.clientOnboarding.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true, accountType: true, status: true } },
        },
      }),
      prisma.clientOnboarding.count({ where }),
    ]);
    const enrichedItems = await Promise.all(items.map(async (item) => {
      const clientProfile = await prisma.clientProfile.findUnique({
        where: { userId: item.userId },
        select: { kycStatus: true },
      });
      return { ...item, ...flatOwnerFields(item.user), clientProfileKycStatus: clientProfile?.kycStatus || null };
    }));
    return {
      items: enrichedItems,
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
    };
  }

  async getOnboarding(id: string) {
    const item = await prisma.clientOnboarding.findUnique({
      where: { id },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true, accountType: true, status: true } } },
    });
    if (!item) throw new AppError('سجل التحقق غير موجود', 404);
    const clientProfile = await prisma.clientProfile.findUnique({
      where: { userId: item.userId },
      select: { kycStatus: true, idNumber: true, frontIdUrl: true, backIdUrl: true, isNafathVerified: true },
    });
    return { ...item, clientProfile };
  }

  async approveOnboarding(id: string, actor?: AdminActor) {
    const item = await prisma.clientOnboarding.findUnique({ where: { id } });
    if (!item) throw new AppError('سجل التحقق غير موجود', 404);
    if (item.status !== OnboardingStatus.PENDING) throw new AppError('تمت معالجة هذا الطلب مسبقاً', 409);
    const updated = await prisma.$transaction(async (tx) => {
      // conditional transition: a concurrent decision matches zero rows
      const moved = await tx.clientOnboarding.updateMany({ where: { id, status: OnboardingStatus.PENDING }, data: { status: OnboardingStatus.APPROVED, reviewedAt: new Date() } });
      if (moved.count !== 1) throw new AppError('تمت معالجة هذا الطلب مسبقاً', 409);
      await tx.clientProfile.updateMany({ where: { userId: item.userId }, data: { kycStatus: KYCStatus.VERIFIED } });
      await tx.user.update({ where: { id: item.userId }, data: { idDocumentUrl: item.documentUrl } });
      if (actor) await tx.accountAuditLog.create({ data: adminAuditData({ actor, userId: item.userId, eventType: 'KYC_APPROVED_BY_ADMIN', title: 'اعتماد توثيق الهوية', summary: 'اعتمدت الإدارة مستندات هوية العميل', status: LogStatus.APPROVED, before: { status: item.status }, after: { status: OnboardingStatus.APPROVED }, details: { onboardingId: id, party: 'CLIENT' } }) });
      return tx.clientOnboarding.findUnique({ where: { id } });
    });
    await clientNotifications.send(clientNotificationFor.kycDecided({ clientId: item.userId, decision: 'APPROVED' }));
    return updated;
  }

  async rejectOnboarding(id: string, input: RejectOnboardingInput, actor?: AdminActor) {
    const item = await prisma.clientOnboarding.findUnique({ where: { id } });
    if (!item) throw new AppError('سجل التحقق غير موجود', 404);
    if (item.status !== OnboardingStatus.PENDING) throw new AppError('تمت معالجة هذا الطلب مسبقاً', 409);
    const updated = await prisma.$transaction(async (tx) => {
      const moved = await tx.clientOnboarding.updateMany({ where: { id, status: OnboardingStatus.PENDING }, data: { status: OnboardingStatus.REJECTED, rejectionReason: input.rejectionReason, reviewedAt: new Date() } });
      if (moved.count !== 1) throw new AppError('تمت معالجة هذا الطلب مسبقاً', 409);
      await tx.clientProfile.updateMany({ where: { userId: item.userId }, data: { kycStatus: KYCStatus.REJECTED } });
      if (actor) await tx.accountAuditLog.create({ data: adminAuditData({ actor, userId: item.userId, eventType: 'KYC_REJECTED_BY_ADMIN', title: 'رفض توثيق الهوية', summary: `رفضت الإدارة مستندات هوية العميل: ${input.rejectionReason}`, status: LogStatus.REJECTED, severity: 'WARNING', before: { status: item.status }, after: { status: OnboardingStatus.REJECTED }, details: { onboardingId: id, party: 'CLIENT', reason: input.rejectionReason } }) });
      return tx.clientOnboarding.findUnique({ where: { id } });
    });
    await clientNotifications.send(clientNotificationFor.kycDecided({ clientId: item.userId, decision: 'REJECTED', reason: input.rejectionReason }));
    return updated;
  }

  async listProviderKyc(status?: KYCStatus, page = 1, limit = 10, search?: string) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const term = (search ?? '').trim().slice(0, 100);
    // Search by the owner's name, e-mail, phone or userId, over ALL providers (not just the loaded page).
    const where: any = {
      ...(status ? { kycStatus: status } : {}),
      ...(term ? { OR: [
        { userId: { equals: term } },
        { user: { email: { contains: term, mode: 'insensitive' } } },
        { user: { firstName: { contains: term, mode: 'insensitive' } } },
        { user: { lastName: { contains: term, mode: 'insensitive' } } },
        { user: { phoneNumber: { contains: term } } },
      ] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.providerProfile.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true, accountType: true, status: true } },
        },
      }),
      prisma.providerProfile.count({ where }),
    ]);
    const waiting = await pendingIdentityRequests(items.map((item) => item.userId));
    return {
      items: items.map((item) => ({ ...item, userId: item.userId, ...flatOwnerFields(item.user), documentsCount: providerDocumentsCount(item as any), pendingIdentityRequestId: waiting.get(item.userId) ?? null })),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
    };
  }

  async approveProviderKyc(userId: string, actor?: AdminActor) {
    const profile = await prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new AppError('ملف المزود غير موجود', 404);
    if (profile.kycStatus === KYCStatus.VERIFIED) throw new AppError('تم التحقق من هذا المزود مسبقاً', 409);
    if ((await pendingIdentityRequests([userId])).has(userId)) throw new AppError(IDENTITY_REQUEST_WAITING, 409);
    // nothing to verify: an approval needs at least one identity document on file
    if (providerDocumentsCount(profile as any) === 0) throw new AppError('لا توجد مستندات هوية لدى المزود لاعتمادها', 400);
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.providerProfile.update({ where: { userId }, data: { kycStatus: KYCStatus.VERIFIED, isVerified: true, notes: null } });
      if (actor) await tx.accountAuditLog.create({ data: adminAuditData({ actor, userId, category: LogCategory.SYSTEM_AUDIT, eventType: 'KYC_APPROVED_BY_ADMIN', title: 'اعتماد توثيق الهوية', summary: 'اعتمدت الإدارة مستندات هوية مقدم الخدمة', status: LogStatus.APPROVED, before: { kycStatus: profile.kycStatus }, after: { kycStatus: KYCStatus.VERIFIED }, details: { party: 'PROVIDER' } }) });
      return row;
    });
    await providerNotifications.kycDecided({ providerId: userId, decision: 'APPROVED' });
    return updated;
  }

  async rejectProviderKyc(userId: string, input: RejectOnboardingInput, actor?: AdminActor) {
    const profile = await prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new AppError('ملف المزود غير موجود', 404);
    if (profile.kycStatus === KYCStatus.REJECTED) throw new AppError('تم رفض هذا المزود مسبقاً', 409);
    if ((await pendingIdentityRequests([userId])).has(userId)) throw new AppError(IDENTITY_REQUEST_WAITING, 409);
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.providerProfile.update({ where: { userId }, data: { kycStatus: KYCStatus.REJECTED, isVerified: false, notes: `سبب الرفض: ${input.rejectionReason}` } });
      if (actor) await tx.accountAuditLog.create({ data: adminAuditData({ actor, userId, eventType: 'KYC_REJECTED_BY_ADMIN', title: 'رفض توثيق الهوية', summary: `رفضت الإدارة مستندات هوية مقدم الخدمة: ${input.rejectionReason}`, status: LogStatus.REJECTED, severity: 'WARNING', before: { kycStatus: profile.kycStatus }, after: { kycStatus: KYCStatus.REJECTED }, details: { party: 'PROVIDER', reason: input.rejectionReason } }) });
      return row;
    });
    await providerNotifications.kycDecided({ providerId: userId, decision: 'REJECTED', reason: input.rejectionReason });
    return updated;
  }
}

export const onboardingService = new OnboardingService();
