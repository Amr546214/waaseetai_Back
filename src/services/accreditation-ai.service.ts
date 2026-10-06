import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { AccreditationStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { aiFeatureUnavailablePayload } from './ai/ai-feature-unavailable';

// Accreditation sample submission. The AI evaluation of samples is DISABLED:
// no documented WaseetAI contract exists for sample evaluation and it is not wired to the
// internal LlmClient yet. Submitting a sample still works: it
// is stored with status MANUAL_REVIEW and NO AI fields (no score, rating,
// feedback or audit timestamp), so it waits for the existing human/admin
// approval path. A sample can never become AI_VERIFIED through submission,
// and no ProviderSpecialty credential is granted here. Previously stored AI
// results on older samples remain readable unchanged.

export const ACCREDITATION_AI_UNAVAILABLE_MESSAGE =
  'الفحص الذكي لنماذج الاعتماد متوقف مؤقتاً حتى يكتمل ربطه بخدمة WaseetAI. تم استلام نموذجك وتحويله للمراجعة اليدوية من فريق الاعتماد.';

export interface SubmitAccreditationSampleDto {
  userId: string;
  providerSpecialtyId: string;
  title: string;
  description: string;
  technologiesUsed: string[];
  projectUrl?: string;
  githubUrl?: string;
  attachments: string[];
}

export class AccreditationAiService {
  /**
   * Stores an accreditation sample for human review. No AI evaluation runs.
   */
  async submitAccreditationSample(dto: SubmitAccreditationSampleDto) {
    const { userId, providerSpecialtyId, title, description, technologiesUsed, projectUrl, githubUrl, attachments } = dto;

    logger.info(`[AccreditationAiService] Storing sample for manual review, user ${userId}, specialty ${providerSpecialtyId}`);

    // 1. Resolve Provider Profile
    const providerProfile = await prisma.providerProfile.findUnique({
      where: { userId },
    });

    if (!providerProfile) {
      throw new Error('Provider profile not found');
    }

    // 2. Resolve ProviderSpecialty record
    let providerSpecialty = await prisma.providerSpecialty.findFirst({
      where: {
        providerProfileId: providerProfile.id,
        OR: [
          { id: providerSpecialtyId },
          { specialtyId: providerSpecialtyId }
        ]
      },
      include: {
        specialty: {
          include: { category: true }
        }
      }
    });

    if (!providerSpecialty) {
      throw new Error('التخصص غير مرتبط بحساب مقدم الخدمة');
    }

    // Deterministic credential gate: `isPassed` is a real quiz-score outcome;
    // samples can only be submitted for a specialty that already passed.
    if (!providerSpecialty.isActive || !providerSpecialty.isPassed) {
      throw new Error('يجب اجتياز الاختبار الفني قبل رفع نموذج الاعتماد');
    }

    const hasEvidence = attachments.length > 0 || Boolean(projectUrl) || Boolean(githubUrl);
    if (!hasEvidence) {
      throw new Error('يجب إرفاق ملف إثبات واحد على الأقل أو رابط مشروع صالح');
    }

    const specialtyName = providerSpecialty.specialty.nameAr || providerSpecialty.specialty.nameEn || providerSpecialty.specialty.name || 'تخصص عام';

    const accreditationSample = await prisma.accreditationSample.create({
      data: {
        providerProfileId: providerProfile.id,
        providerSpecialtyId: providerSpecialty.id,
        title,
        description,
        projectUrl: projectUrl || null,
        githubUrl: githubUrl || null,
        technologiesUsed: technologiesUsed || [],
        attachments: attachments || [],
        status: AccreditationStatus.MANUAL_REVIEW
      }
    });

    logger.info(`[AccreditationAiService] AccreditationSample ${accreditationSample.id} stored for manual review (AI evaluation paused)`);

    return {
      sample: accreditationSample,
      evaluation: null,
      aiEvaluation: {
        available: false,
        specialtyName,
        ...aiFeatureUnavailablePayload(ACCREDITATION_AI_UNAVAILABLE_MESSAGE)
      }
    };
  }

  /**
   * Get all accreditation samples submitted by the provider
   */
  async getProviderAccreditationSamples(userId: string) {
    const providerProfile = await prisma.providerProfile.findUnique({
      where: { userId }
    });

    if (!providerProfile) {
      return { success: false, samples: [] };
    }

    const samples = await prisma.accreditationSample.findMany({
      where: { providerProfileId: providerProfile.id },
      include: {
        providerSpecialty: {
          include: {
            specialty: true
          }
		},
		serviceCatalogs: { select: { id: true, status: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return {
      success: true,
      count: samples.length,
      samples
    };
  }

  /**
   * Get a specific accreditation sample by ID
   */
  async getAccreditationSampleById(userId: string, sampleId: string) {
    const providerProfile = await prisma.providerProfile.findUnique({
      where: { userId }
    });

    if (!providerProfile) {
      throw new Error('Provider profile not found');
    }

    const sample = await prisma.accreditationSample.findFirst({
      where: { 
        id: sampleId,
        providerProfileId: providerProfile.id
      },
      include: {
        providerSpecialty: {
          include: {
            specialty: {
              include: { category: true }
            }
          }
		},
		serviceCatalogs: { select: { id: true, status: true } }
      }
    });

    if (!sample) {
      throw new Error('Accreditation sample not found');
    }

    return {
      success: true,
      sample
    };
  }

  // ===== Admin: Accreditation Review =====

  async listAllSamples(status?: AccreditationStatus, page = 1, limit = 10) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      prisma.accreditationSample.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          providerProfile: {
            select: {
              id: true,
              userId: true,
              user: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true, accountType: true, status: true } },
            },
          },
          providerSpecialty: {
            select: {
              id: true,
              status: true,
              isPassed: true,
              specialty: { select: { id: true, name: true, nameAr: true, nameEn: true } },
            },
          },
        },
      }),
      prisma.accreditationSample.count({ where }),
    ]);
    return {
      items,
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
    };
  }

  async getSampleByIdAdmin(id: string) {
    const sample = await prisma.accreditationSample.findUnique({
      where: { id },
      include: {
        providerProfile: {
          select: {
            id: true,
            userId: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true, accountType: true, status: true } },
          },
        },
        providerSpecialty: {
          select: {
            id: true,
            status: true,
            isPassed: true,
            aiScore: true,
            ownershipCredibility: true,
            badgeGrantedAt: true,
            specialty: { select: { id: true, name: true, nameAr: true, nameEn: true, icon: true } },
          },
        },
      },
    });
    if (!sample) throw new AppError('نموذج الاعتماد غير موجود', 404);
    return sample;
  }

  async adminApproveSample(id: string) {
    const sample = await prisma.accreditationSample.findUnique({
      where: { id },
      include: { providerSpecialty: { select: { status: true } } }
    });
    if (!sample) throw new AppError('نموذج الاعتماد غير موجود', 404);
    // The real "already done" condition is whether the linked specialty has
    // actually been granted the credential — not whether the sample itself
    // is labeled AI_VERIFIED, which only ever means "AI
    // recommends approval", never "approval already granted".
    if (sample.providerSpecialty?.status === 'APPROVED') throw new AppError('تم اعتماد هذا النموذج مسبقاً', 409);

    return prisma.$transaction(async (tx) => {
      const updated = await tx.accreditationSample.update({
        where: { id },
        // `aiAuditedAt` records WHEN AN AI AUDITED the sample. A human approval must not stamp it: it is only set here (once) when the
        // sample already carries a stored AI score, and an existing value is never overwritten. The enum value is unchanged.
        data: {
          status: AccreditationStatus.AI_VERIFIED,
          ...(sample.aiScore != null && !sample.aiAuditedAt ? { aiAuditedAt: new Date() } : {}),
        },
      });

      await tx.providerSpecialty.updateMany({
        where: { id: sample.providerSpecialtyId },
        data: {
          status: 'APPROVED',
          isPassed: true,
          badgeGrantedAt: new Date(),
          ...(sample.aiScore != null ? { aiScore: sample.aiScore, ownershipCredibility: Math.max(0, sample.aiScore) } : {}),
        },
      });

      return updated;
    });
  }

  async adminRejectSample(id: string, rejectionReason: string) {
    const sample = await prisma.accreditationSample.findUnique({ where: { id } });
    if (!sample) throw new AppError('نموذج الاعتماد غير موجود', 404);
    if (sample.status === AccreditationStatus.REJECTED) throw new AppError('تم رفض هذا النموذج مسبقاً', 409);

    const adminNote = `\n[مراجعة الإدارة] سبب الرفض: ${rejectionReason}`;
    const existingFeedback = sample.aiFeedbackAr || '';

    return prisma.$transaction(async (tx) => {
      const updated = await tx.accreditationSample.update({
        where: { id },
        data: {
          status: AccreditationStatus.REJECTED,
          aiFeedbackAr: existingFeedback + adminNote,
        },
      });

      await tx.providerSpecialty.updateMany({
        where: { id: sample.providerSpecialtyId, status: { not: 'APPROVED' } },
        data: { status: 'REJECTED' },
      });

      return updated;
    });
  }
}

export const accreditationAiService = new AccreditationAiService();
