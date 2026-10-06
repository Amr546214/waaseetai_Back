import { LogCategory, LogStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

// BE-3(b): the only way a ProviderSpecialty leaves UNDER_AI_REVIEW without a quiz/accreditation sample is an explicit admin
// decision. It writes the status (and, for APPROVED, the same isPassed/badgeGrantedAt a human accreditation approval writes) and
// NEVER touches any AI-owned field (aiScore, latestScore, quizScore, feasibility/clarity, ownershipCredibility).

export class SpecialtyAdminReviewService {
  async decide(adminId: string, providerSpecialtyId: string, input: { decision: 'APPROVED' | 'REJECTED'; reason: string }) {
    const specialty = await prisma.providerSpecialty.findUnique({
      where: { id: providerSpecialtyId },
      select: { id: true, status: true, providerProfile: { select: { userId: true } }, specialty: { select: { nameAr: true } } },
    });
    if (!specialty) throw new AppError('التخصص غير موجود', 404);
    if (specialty.status !== SpecialtyVerificationStatus.UNDER_AI_REVIEW) {
      throw new AppError('لا يمكن اتخاذ قرار إلا على تخصص قيد المراجعة', 409);
    }

    const approved = input.decision === 'APPROVED';
    const decidedAt = new Date();
    return prisma.$transaction(async (tx) => {
      // conditional transition: a concurrent decision matches zero rows
      const moved = await tx.providerSpecialty.updateMany({
        where: { id: providerSpecialtyId, status: SpecialtyVerificationStatus.UNDER_AI_REVIEW },
        data: approved
          ? { status: SpecialtyVerificationStatus.APPROVED, isPassed: true, badgeGrantedAt: decidedAt }
          : { status: SpecialtyVerificationStatus.REJECTED },
      });
      if (moved.count !== 1) throw new AppError('تمت معالجة هذا التخصص مسبقاً', 409);

      const userId = specialty.providerProfile?.userId;
      if (userId) {
        await tx.accountAuditLog.create({
          data: {
            userId,
            category: LogCategory.SYSTEM_AUDIT,
            title: approved ? 'اعتماد تخصص من الإدارة' : 'رفض تخصص من الإدارة',
            actionText: `${approved ? 'اعتمدت' : 'رفضت'} الإدارة تخصص ${specialty.specialty?.nameAr ?? ''} بعد مراجعة يدوية`.trim(),
            status: approved ? LogStatus.APPROVED : LogStatus.REJECTED,
            source: 'ADMIN',
            eventType: 'SPECIALTY_ADMIN_DECISION',
            severity: 'INFO',
            summary: input.reason,
            metaData: { providerSpecialtyId, decision: input.decision, reason: input.reason, adminId, previousStatus: 'UNDER_AI_REVIEW' },
            beforeData: { status: 'UNDER_AI_REVIEW' },
            afterData: { status: input.decision },
          },
        });
      }
      return { providerSpecialtyId, status: input.decision, decidedAt };
    });
  }
}

export const specialtyAdminReviewService = new SpecialtyAdminReviewService();
