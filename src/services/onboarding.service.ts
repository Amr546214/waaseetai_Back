import { OnboardingStatus, KYCStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { RejectOnboardingInput } from '../dtos/onboarding.dto';

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
  async submitSetupDocuments(userId: string, docs: { idNumber?: string | null; frontIdUrl?: string | null; backIdUrl?: string | null }) {
    if (!docs.idNumber || !docs.frontIdUrl || !docs.backIdUrl) return null;
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
      return { ...item, clientProfileKycStatus: clientProfile?.kycStatus || null };
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

  async approveOnboarding(id: string) {
    const item = await prisma.clientOnboarding.findUnique({ where: { id } });
    if (!item) throw new AppError('سجل التحقق غير موجود', 404);
    if (item.status !== OnboardingStatus.PENDING) throw new AppError('تمت معالجة هذا الطلب مسبقاً', 409);
    const [updated] = await Promise.all([
      prisma.clientOnboarding.update({ where: { id }, data: { status: OnboardingStatus.APPROVED, reviewedAt: new Date() } }),
      prisma.clientProfile.updateMany({ where: { userId: item.userId }, data: { kycStatus: KYCStatus.VERIFIED } }),
      prisma.user.update({ where: { id: item.userId }, data: { idDocumentUrl: item.documentUrl } }),
    ]);
    return updated;
  }

  async rejectOnboarding(id: string, input: RejectOnboardingInput) {
    const item = await prisma.clientOnboarding.findUnique({ where: { id } });
    if (!item) throw new AppError('سجل التحقق غير موجود', 404);
    if (item.status !== OnboardingStatus.PENDING) throw new AppError('تمت معالجة هذا الطلب مسبقاً', 409);
    const [updated] = await Promise.all([
      prisma.clientOnboarding.update({ where: { id }, data: { status: OnboardingStatus.REJECTED, rejectionReason: input.rejectionReason, reviewedAt: new Date() } }),
      prisma.clientProfile.updateMany({ where: { userId: item.userId }, data: { kycStatus: KYCStatus.REJECTED } }),
    ]);
    return updated;
  }

  async listProviderKyc(status?: KYCStatus, page = 1, limit = 10) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const where = status ? { kycStatus: status } : {};
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
    return {
      items,
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
    };
  }

  async approveProviderKyc(userId: string) {
    const profile = await prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new AppError('ملف المزود غير موجود', 404);
    if (profile.kycStatus === KYCStatus.VERIFIED) throw new AppError('تم التحقق من هذا المزود مسبقاً', 409);
    return prisma.providerProfile.update({ where: { userId }, data: { kycStatus: KYCStatus.VERIFIED, isVerified: true, notes: null } });
  }

  async rejectProviderKyc(userId: string, input: RejectOnboardingInput) {
    const profile = await prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new AppError('ملف المزود غير موجود', 404);
    if (profile.kycStatus === KYCStatus.REJECTED) throw new AppError('تم رفض هذا المزود مسبقاً', 409);
    return prisma.providerProfile.update({ where: { userId }, data: { kycStatus: KYCStatus.REJECTED, isVerified: false, notes: `سبب الرفض: ${input.rejectionReason}` } });
  }
}

export const onboardingService = new OnboardingService();
