import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { AccreditationStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { geminiClient, GeminiImageInput } from './ai/gemini/gemini.client';
import { fetchRemoteImage } from '../utils/remote-image-fetch';

// F10 — Accreditation Sample AI Evaluation, migrated to the shared Gemini
// Vision foundation.
//
// Fallback decision: the previous implementation's failure path
// (`generateManualReviewEvaluation` — score 0, status MANUAL_REVIEW, an
// honest Arabic message saying the automated check couldn't complete) was
// ALREADY the correct, honest behavior and is preserved unchanged. What
// needed fixing was the *success* path: the old OpenAI response parser
// silently replaced a missing/malformed `aiScore` with a hardcoded `85`,
// and missing `strengths`/`recommendations` with hardcoded positive-sounding
// arrays ("التزام ممتاز بالبنية المعمارية", …) — meaning a malformed or
// partial provider response could still look like a confident real
// evaluation. That silent patching is removed: a real validator now either
// accepts the full parsed response or the call is treated as failed and
// routed through the existing, already-honest manual-review path — never a
// partially-fabricated "success".

const ALLOWED_ACCREDITATION_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_VISION_IMAGES = 4;

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

const ACCREDITATION_EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    aiScore: { type: 'number', description: '0 to 100' },
    status: { type: 'string', enum: ['AI_VERIFIED', 'REJECTED'] },
    aiQualityRating: { type: 'string', enum: ['EXCELLENT', 'ACCEPTABLE', 'POOR'] },
    feedbackAr: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } }
  },
  required: ['aiScore', 'status', 'aiQualityRating', 'feedbackAr', 'strengths', 'recommendations']
};

// Rejects anything that doesn't genuinely satisfy the application contract.
// This replaces the previous silent-patching behavior (a missing/invalid
// aiScore became a hardcoded 85; missing strengths/recommendations became
// hardcoded positive-sounding text) — a malformed response is now always
// treated as a real failure, routed through the existing honest
// manual-review path, never disguised as a passable evaluation.
function isValidAccreditationEvaluation(value: unknown): value is AccreditationEvaluationResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.aiScore !== 'number' || !Number.isFinite(v.aiScore) || v.aiScore < 0 || v.aiScore > 100) return false;
  if (v.status !== 'AI_VERIFIED' && v.status !== 'REJECTED') return false;
  if (v.aiQualityRating !== 'EXCELLENT' && v.aiQualityRating !== 'ACCEPTABLE' && v.aiQualityRating !== 'POOR') return false;
  if (typeof v.feedbackAr !== 'string' || v.feedbackAr.trim().length === 0) return false;
  if (!Array.isArray(v.strengths) || !v.strengths.every((s) => typeof s === 'string')) return false;
  if (!Array.isArray(v.recommendations) || !v.recommendations.every((s) => typeof s === 'string')) return false;
  return true;
}

export interface AccreditationEvaluationResult {
  aiScore: number;
  status: 'AI_VERIFIED' | 'REJECTED' | 'MANUAL_REVIEW';
  aiQualityRating: 'EXCELLENT' | 'ACCEPTABLE' | 'POOR';
  feedbackAr: string;
  strengths: string[];
  recommendations: string[];
}

export class AccreditationAiService {
  /**
   * Main OpenAI GPT-4o Multimodal Evaluation Engine for Accreditation Samples
   */
  async evaluateAccreditationSample(dto: SubmitAccreditationSampleDto) {
    const { userId, providerSpecialtyId, title, description, technologiesUsed, projectUrl, githubUrl, attachments } = dto;

    logger.info(`[AccreditationAiService] Starting evaluation for user ${userId}, specialty ${providerSpecialtyId}`);

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

    if (!providerSpecialty.isActive || !providerSpecialty.isPassed) {
      throw new Error('يجب اجتياز الاختبار الفني قبل رفع نموذج الاعتماد');
    }

    const hasEvidence = attachments.length > 0 || Boolean(projectUrl) || Boolean(githubUrl);
    if (!hasEvidence) {
      throw new Error('يجب إرفاق ملف إثبات واحد على الأقل أو رابط مشروع صالح');
    }

    const specialtyName = providerSpecialty.specialty.nameAr || providerSpecialty.specialty.nameEn || providerSpecialty.specialty.name || 'تخصص عام';
    const categoryName = providerSpecialty.specialty.category?.nameAr || 'عام';

    // 3. Gemini Vision Evaluation Pipeline
    let evalResult: AccreditationEvaluationResult;

    let evaluationCompleted = false;
    if (geminiClient.isConfigured()) {
      try {
        evalResult = await this.callGeminiVisionEvaluation({
          specialtyName,
          categoryName,
          title,
          description,
          technologiesUsed,
          projectUrl,
          githubUrl,
          attachments
        });
        evaluationCompleted = true;
      } catch (err: any) {
        logger.error(`[AccreditationAiService] Gemini API error, routing to manual review: ${err?.code || err?.message}`);
        evalResult = this.generateManualReviewEvaluation(specialtyName);
      }
    } else {
      logger.info(`[AccreditationAiService] GEMINI_API_KEY not configured. Routing to manual review.`);
      evalResult = this.generateManualReviewEvaluation(specialtyName);
    }

    // Determine status & quality rating based on score rules
    const finalScore = Math.round(evalResult.aiScore * 10) / 10;
    const finalStatus = evaluationCompleted ? (finalScore >= 75 ? 'AI_VERIFIED' : 'REJECTED') : 'MANUAL_REVIEW';
    const finalQuality = evaluationCompleted ? (finalScore >= 85 ? 'EXCELLENT' : (finalScore >= 75 ? 'ACCEPTABLE' : 'POOR')) : 'POOR';

    // 4. Save DB Transaction
    const accreditationSample = await prisma.$transaction(async (tx) => {
      // Create AccreditationSample
      const sample = await tx.accreditationSample.create({
        data: {
          providerProfileId: providerProfile.id,
          providerSpecialtyId: providerSpecialty.id,
          title,
          description,
          projectUrl: projectUrl || null,
          githubUrl: githubUrl || null,
          technologiesUsed: technologiesUsed || [],
          attachments: attachments || [],
          status: finalStatus,
          aiScore: finalScore,
          aiQualityRating: finalQuality,
          aiFeedbackAr: evalResult.feedbackAr,
          aiStrengths: evalResult.strengths,
          aiRecommendations: evalResult.recommendations,
          aiAuditedAt: new Date(),
        }
      });

      // If AI_VERIFIED, upgrade ProviderSpecialty credentials and status
      if (finalStatus === 'AI_VERIFIED') {
        await tx.providerSpecialty.update({
          where: { id: providerSpecialty.id },
          data: {
            status: 'APPROVED',
            isPassed: true,
            passedAt: new Date(),
            badgeGrantedAt: new Date(),
            aiScore: finalScore,
            ownershipCredibility: Math.max(providerSpecialty.ownershipCredibility || 0, finalScore),
          }
        });
      }

      return sample;
    });

    logger.info(`[AccreditationAiService] AccreditationSample created with ID ${accreditationSample.id}, score: ${finalScore}, status: ${finalStatus}`);

    return {
      sample: accreditationSample,
      evaluation: {
        aiScore: finalScore,
        status: finalStatus,
        aiQualityRating: finalQuality,
        feedbackAr: evalResult.feedbackAr,
        strengths: evalResult.strengths,
        recommendations: evalResult.recommendations,
        specialtyName,
        auditedAt: accreditationSample.aiAuditedAt
      }
    };
  }

  /**
   * Gemini Vision Multimodal Ingestion Pipeline
   */
  private async callGeminiVisionEvaluation(params: {
    specialtyName: string;
    categoryName: string;
    title: string;
    description: string;
    technologiesUsed: string[];
    projectUrl?: string;
    githubUrl?: string;
    attachments: string[];
  }): Promise<AccreditationEvaluationResult> {
    const { specialtyName, categoryName, title, description, technologiesUsed, projectUrl, githubUrl, attachments } = params;

    const systemPrompt = `أنت الخبير الفني الرئيسي لمراجعة نماذج الاعتماد (Senior Technical Lead Auditor) في مجال "${specialtyName}" (قسم: ${categoryName}).
مهمتك هي إجراء فحص تقني دقيق وشامل لنموذج العمل المرفق لتقييم عمقه الفني، صحة التنفيذ، التناسق المعماري، وجودة حل المشكلات.

قم بتحليل البيانات التالية:
- عنوان المشروع: ${title}
- وصف المشروع: ${description}
- التقنيات المستخدمة: ${technologiesUsed.join(', ')}
- رابط المشروع المباشر: ${projectUrl || 'غير متاح'}
- رابط GitHub: ${githubUrl || 'غير متاح'}
- عدد المرفقات المرفوعة: ${attachments.length}

معايير التقييم:
1. جودة البنية البرمجية والتصميم والتنفيذ التقني (0-100).
2. مصداقية النموذج وتطابقه مع التقنيات المسجلة والتخصص.
3. اكتمال الوثائق والمرفقات الفنية.

يجب أن تعيد الناتج بصيغة JSON صارمة باللغة العربية كالتالي:
{
  "aiScore": 88.0,
  "status": "AI_VERIFIED", // إذا كان aiScore >= 75% اختر AI_VERIFIED وإلا REJECTED
  "aiQualityRating": "EXCELLENT", // EXCELLENT (>=85), ACCEPTABLE (>=75), POOR (<75)
  "feedbackAr": "نص التقييم والتغذية الراجعة التفصيلية باللغة العربية...",
  "strengths": ["نقاط القوة 1", "نقاط القوة 2"],
  "recommendations": ["توصية تحسين 1", "توصية تحسين 2"]
}`;

    const userPrompt = 'الرجاء فحص نموذج العمل المرفق ومدى استحقاقه للاعتماد الفني.';

    // Best-effort image collection — an individual attachment that fails to
    // fetch is skipped with a server-side log, never fails the whole
    // evaluation (the text description still carries real signal).
    const images: GeminiImageInput[] = [];
    for (const fileUrl of attachments) {
      if (images.length >= MAX_VISION_IMAGES) break;
      if (typeof fileUrl !== 'string' || !(fileUrl.startsWith('http://') || fileUrl.startsWith('https://'))) continue;
      try {
        const fetched = await fetchRemoteImage(fileUrl, { allowedMimeTypes: ALLOWED_ACCREDITATION_IMAGE_MIME_TYPES });
        images.push(fetched);
      } catch (imageError: any) {
        logger.warn(`[AccreditationAiService] Skipping unfetchable attachment image: ${imageError?.code || imageError?.message}`);
      }
    }

    const requestOptions = {
      systemInstruction: systemPrompt,
      responseSchema: ACCREDITATION_EVALUATION_SCHEMA,
      validate: isValidAccreditationEvaluation,
      maxOutputTokens: 1200
    };

    const result = images.length > 0
      ? await geminiClient.generateStructuredWithImage<AccreditationEvaluationResult>(userPrompt, { ...requestOptions, images })
      : await geminiClient.generateStructured<AccreditationEvaluationResult>(userPrompt, requestOptions);

    return result.data;
  }

  /**
   * Dynamic fallback evaluation calculation if OpenAI key is unconfigured or encounters an error
   */
  private generateManualReviewEvaluation(specialtyName: string): AccreditationEvaluationResult {
    return {
      aiScore: 0,
      status: 'MANUAL_REVIEW',
      aiQualityRating: 'POOR',
      feedbackAr: `تعذر إكمال الفحص الآلي لتخصص ${specialtyName}. تم تحويل النموذج إلى المراجعة اليدوية دون منحه اعتماداً تلقائياً.`,
      strengths: [],
      recommendations: ['بانتظار مراجعة فريق الاعتماد للمرفقات وإثبات الملكية']
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
    const sample = await prisma.accreditationSample.findUnique({ where: { id } });
    if (!sample) throw new AppError('نموذج الاعتماد غير موجود', 404);
    if (sample.status === AccreditationStatus.AI_VERIFIED) throw new AppError('تم اعتماد هذا النموذج مسبقاً', 409);

    return prisma.$transaction(async (tx) => {
      const updated = await tx.accreditationSample.update({
        where: { id },
        data: { status: AccreditationStatus.AI_VERIFIED, aiAuditedAt: sample.aiAuditedAt || new Date() },
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
