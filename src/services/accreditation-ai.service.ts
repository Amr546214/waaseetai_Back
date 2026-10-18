import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { AccreditationStatus, LogStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { aiFeatureUnavailablePayload } from './ai/ai-feature-unavailable';
import { AdminActor, adminAuditData } from './admin-audit';
import { providerNotifications } from './provider-notifications.service';
import { resolveProofsForSubmission, buildAdminProofList, publicLegacyAttachments } from './accreditation-proof.service';

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
  /** legacy body strings: accepted only when they equal the private reference of the caller's own COMPLETED upload for this request */
  attachments: string[];
  /** ids returned by POST /accreditation/upload-proof */
  proofIds?: string[];
  /** re-open THIS request (completion required / rejected) instead of opening a new one */
  resubmitSampleId?: string;
}

/** The internal admin note never reaches the provider (the user-facing `userNote` does). */
const withoutInternalNote = <T extends { internalNote?: unknown }>(sample: T): Omit<T, 'internalNote'> => {
  const { internalNote: _internal, ...rest } = sample;
  return rest;
};

/**
 * Decision claim: exactly ONE concurrent approve / reject of a sample wins. Only an undecided sample (decidedAt null) in a decidable state matches; the loser
 * matches zero rows and gets a 409, so a double click or two admins can never decide twice (and never duplicate the side effects below).
 * Decidable: MANUAL_REVIEW, PENDING_AI_AUDIT, NEEDS_COMPLETION, and AI_VERIFIED without a decision (old stored AI result). A REJECTED sample is not decidable.
 */
async function claimForDecision(tx: any, id: string) {
  const claimed = await tx.accreditationSample.updateMany({
    where: { id, decidedAt: null, status: { in: [AccreditationStatus.MANUAL_REVIEW, AccreditationStatus.PENDING_AI_AUDIT, AccreditationStatus.NEEDS_COMPLETION, AccreditationStatus.AI_VERIFIED] } },
    data: { decidedAt: new Date() },
  });
  if (claimed.count !== 1) throw new AppError('تمت معالجة هذا النموذج مسبقاً', 409);
}

export class AccreditationAiService {
  /**
   * Stores an accreditation sample for human review. No AI evaluation runs.
   */
  async submitAccreditationSample(dto: SubmitAccreditationSampleDto) {
    const { userId, providerSpecialtyId, title, description, technologiesUsed, projectUrl, githubUrl } = dto;

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

    // 3. Batch B T1 (§3): the proof documents are MANDATORY and must be completed uploads of THIS user for THIS request (a URL in the body is not a document).
    //    A resubmission may re-use the documents already attached to the same request.
    const existingForReopen = await this.findReopenableSample(providerSpecialty.id, dto.resubmitSampleId);
    const proofs = await resolveProofsForSubmission(prisma as any, { userId, providerSpecialtyId: providerSpecialty.id, proofIds: dto.proofIds, attachmentRefs: dto.attachments, sampleId: existingForReopen?.id ?? null });

    const specialtyName = providerSpecialty.specialty.nameAr || providerSpecialty.specialty.nameEn || providerSpecialty.specialty.name || 'تخصص عام';

    // 4. One open request per specialty: a concurrent double submit cannot create two (advisory lock + re-check inside the transaction).
    const { accreditationSample, resubmitted } = await prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'accreditation:' + providerSpecialty!.id}))`;
      const latest = await tx.accreditationSample.findFirst({ where: { providerSpecialtyId: providerSpecialty!.id }, orderBy: { createdAt: 'desc' } });
      if (latest && (latest.status === AccreditationStatus.MANUAL_REVIEW || latest.status === AccreditationStatus.PENDING_AI_AUDIT)) {
        throw new AppError('لديك طلب اعتماد قيد المراجعة لهذا التخصص؛ تابعه من «إجراءات الحساب»', 409);
      }
      const reopen = latest && (latest.status === AccreditationStatus.NEEDS_COMPLETION || latest.status === AccreditationStatus.REJECTED) ? latest : null;
      if (dto.resubmitSampleId && (!reopen || reopen.id !== dto.resubmitSampleId)) {
        throw new AppError('هذا الطلب غير قابل لإعادة الإرسال', 409);
      }
      const content = { title, description, projectUrl: projectUrl || null, githubUrl: githubUrl || null, technologiesUsed: technologiesUsed || [], attachments: proofs.urls };
      let sample: any;
      if (reopen) {
        // the SAME request goes back to the admin: its history stays, no duplicate row
        sample = await tx.accreditationSample.update({ where: { id: reopen.id }, data: { ...content, status: AccreditationStatus.MANUAL_REVIEW, revision: { increment: 1 }, completionFields: [], userNote: null, decidedAt: null } });
      } else {
        sample = await tx.accreditationSample.create({ data: { providerProfileId: providerProfile!.id, providerSpecialtyId: providerSpecialty!.id, ...content, status: AccreditationStatus.MANUAL_REVIEW } });
      }
      await tx.accreditationProofUpload.updateMany({ where: { id: { in: proofs.uploads.map(u => u.id) } }, data: { sampleId: sample.id } });
      await tx.accreditationSampleEvent.create({ data: { sampleId: sample.id, kind: reopen ? 'RESUBMITTED' : 'SUBMITTED', revision: sample.revision ?? 1, actorId: userId } });
      // the specialty waits for the admin (never touched when already APPROVED / locked out)
      await tx.providerSpecialty.updateMany({ where: { id: providerSpecialty!.id, status: { in: ['PENDING_PROOF', 'PENDING_AUDIT', 'PENDING_TEST', 'TEST_REQUIRED', 'REJECTED'] } }, data: { status: 'UNDER_AI_REVIEW' } });
      return { accreditationSample: sample, resubmitted: !!reopen };
    });

    logger.info(`[AccreditationAiService] AccreditationSample ${accreditationSample.id} stored for manual review (AI evaluation paused)`);

    return {
      sample: accreditationSample,
      resubmitted,
      evaluation: null,
      aiEvaluation: {
        available: false,
        specialtyName,
        ...aiFeatureUnavailablePayload(ACCREDITATION_AI_UNAVAILABLE_MESSAGE)
      }
    };
  }

  /** The request a resubmission re-opens: the latest sample of the specialty when the admin asked for completion or rejected it. */
  private async findReopenableSample(providerSpecialtyId: string, resubmitSampleId?: string) {
    const latest = await prisma.accreditationSample.findFirst({ where: { providerSpecialtyId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } });
    if (!latest) return null;
    if (latest.status === AccreditationStatus.NEEDS_COMPLETION || latest.status === AccreditationStatus.REJECTED) return latest;
    return null;
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

    const rawSamples = await prisma.accreditationSample.findMany({
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

    const samples = rawSamples.map(withoutInternalNote);
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
      sample: withoutInternalNote(sample)
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
        // admin only: the review history INCLUDING the internal notes, and the proof documents (opened through the KYC access-link, never as a URL)
        events: { orderBy: { createdAt: 'asc' } },
        proofUploads: { where: { status: 'COMPLETED' }, orderBy: { createdAt: 'asc' }, select: { id: true, privateRef: true, fileName: true, mimeType: true, bytes: true, createdAt: true } },
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
    // "For review" marks of the latest assessment attempt (advisory only: they never changed the score or status).
    const attempt = sample.providerSpecialty?.id
      ? await prisma.assessmentAttempt.findFirst({ where: { providerSpecialtyId: sample.providerSpecialty.id, status: { in: ['COMPLETED', 'FAILED'] } }, orderBy: { completedAt: 'desc' }, select: { id: true, score: true, status: true, completedAt: true, analyzedAssetsSnapshot: true } })
      : null;
    const review = (attempt?.analyzedAssetsSnapshot as { review?: unknown } | null)?.review ?? null;
    // Proof contract (admin detail): `proofs` lists BOTH shapes (upload rows + legacy attachments) with how to open each; the private reference never leaves the server.
    const proofs = await buildAdminProofList(sample as any);
    const { proofUploads: _uploads, ...rest } = sample as any;
    const publicUploads = ((_uploads ?? []) as any[]).map(({ privateRef: _ref, ...u }) => u);
    return { ...rest, attachments: publicLegacyAttachments(sample.attachments), proofUploads: publicUploads, proofs, assessmentReview: attempt ? { attemptId: attempt.id, status: attempt.status, score: attempt.score, completedAt: attempt.completedAt, review } : null };
  }

  async adminApproveSample(id: string, actor?: AdminActor) {
    const sample = await prisma.accreditationSample.findUnique({
      where: { id },
      include: { providerSpecialty: { select: { status: true } }, providerProfile: { select: { userId: true } } }
    });
    if (!sample) throw new AppError('نموذج الاعتماد غير موجود', 404);
    // The real "already done" condition is whether the linked specialty has
    // actually been granted the credential — not whether the sample itself
    // is labeled AI_VERIFIED, which only ever means "AI
    // recommends approval", never "approval already granted".
    if (sample.status === AccreditationStatus.AI_VERIFIED && sample.providerSpecialty?.status === 'APPROVED') throw new AppError('تم اعتماد هذا النموذج مسبقاً', 409);
    if (sample.status === AccreditationStatus.REJECTED) throw new AppError('تم رفض هذا النموذج مسبقاً', 409);
    const specialtyAlreadyApproved = sample.providerSpecialty?.status === 'APPROVED';

    const approved = await prisma.$transaction(async (tx) => {
      await claimForDecision(tx, id);
      const updated = await tx.accreditationSample.update({
        where: { id },
        // `aiAuditedAt` records WHEN AN AI AUDITED the sample. A human approval must not stamp it: it is only set here (once) when the
        // sample already carries a stored AI score, and an existing value is never overwritten. The enum value is unchanged.
        data: {
          status: AccreditationStatus.AI_VERIFIED,
          decidedAt: new Date(),
          ...(sample.aiScore != null && !sample.aiAuditedAt ? { aiAuditedAt: new Date() } : {}),
        },
      });
      await tx.accreditationSampleEvent.create({ data: { sampleId: id, kind: 'APPROVED', revision: sample.revision ?? 1, actorId: actor?.id ?? null } });

      // An EXTRA sample of an already-approved specialty: the specialty stays APPROVED exactly as it is (badge date and score are not rewritten).
      // The conditional where also keeps this idempotent when two different samples are approved at the same moment.
      if (!specialtyAlreadyApproved) {
        await tx.providerSpecialty.updateMany({
          where: { id: sample.providerSpecialtyId, status: { not: 'APPROVED' } },
          data: {
            status: 'APPROVED',
            isPassed: true,
            badgeGrantedAt: new Date(),
            ...(sample.aiScore != null ? { aiScore: sample.aiScore, ownershipCredibility: Math.max(0, sample.aiScore) } : {}),
          },
        });
      }

      const providerId = (sample as { providerProfile?: { userId?: string } }).providerProfile?.userId;
      if (actor && providerId) {
        await tx.accountAuditLog.create({ data: adminAuditData({ actor, userId: providerId, eventType: 'ACCREDITATION_APPROVED_BY_ADMIN', title: 'اعتماد نموذج الاعتماد', summary: `اعتمدت الإدارة نموذج الاعتماد «${sample.title ?? ''}»`.trim(), status: LogStatus.APPROVED, before: { sampleStatus: sample.status, specialtyStatus: sample.providerSpecialty?.status ?? null }, after: { sampleStatus: AccreditationStatus.AI_VERIFIED, specialtyStatus: 'APPROVED' }, details: { sampleId: id, providerSpecialtyId: sample.providerSpecialtyId } }) });
      }

      return updated;
    });
    const approvedProviderId = (sample as { providerProfile?: { userId?: string } }).providerProfile?.userId;
    if (approvedProviderId) await providerNotifications.accreditationDecided({ providerId: approvedProviderId, sampleId: id, sampleTitle: sample.title, decision: 'APPROVED' });
    return approved;
  }

  async adminRejectSample(id: string, rejectionReason: string, actor?: AdminActor, internalNote?: string | null) {
    const sample = await prisma.accreditationSample.findUnique({ where: { id }, include: { providerProfile: { select: { userId: true } }, providerSpecialty: { select: { status: true } } } });
    if (!sample) throw new AppError('نموذج الاعتماد غير موجود', 404);
    if (sample.status === AccreditationStatus.REJECTED) throw new AppError('تم رفض هذا النموذج مسبقاً', 409);
    // an approved sample (AI_VERIFIED whose specialty is APPROVED) is a decided sample: no second decision
    if (sample.status === AccreditationStatus.AI_VERIFIED && sample.providerSpecialty?.status === 'APPROVED') throw new AppError('تم اعتماد هذا النموذج مسبقاً', 409);

    const adminNote = `\n[مراجعة الإدارة] سبب الرفض: ${rejectionReason}`;
    const existingFeedback = sample.aiFeedbackAr || '';

    const rejected = await prisma.$transaction(async (tx) => {
      await claimForDecision(tx, id);
      const updated = await tx.accreditationSample.update({
        where: { id },
        data: {
          status: AccreditationStatus.REJECTED,
          aiFeedbackAr: existingFeedback + adminNote,
          userNote: rejectionReason,
          ...(internalNote ? { internalNote } : {}),
          decidedAt: new Date(),
        },
      });
      await tx.accreditationSampleEvent.create({ data: { sampleId: id, kind: 'REJECTED', revision: sample.revision ?? 1, userNote: rejectionReason, internalNote: internalNote || null, actorId: actor?.id ?? null } });

      await tx.providerSpecialty.updateMany({
        where: { id: sample.providerSpecialtyId, status: { not: 'APPROVED' } },
        data: { status: 'REJECTED' },
      });

      const providerId = (sample as { providerProfile?: { userId?: string } }).providerProfile?.userId;
      if (actor && providerId) {
        await tx.accountAuditLog.create({ data: adminAuditData({ actor, userId: providerId, eventType: 'ACCREDITATION_REJECTED_BY_ADMIN', title: 'رفض نموذج الاعتماد', summary: `رفضت الإدارة نموذج الاعتماد «${sample.title ?? ''}»: ${rejectionReason}`.trim(), status: LogStatus.REJECTED, severity: 'WARNING', before: { sampleStatus: sample.status }, after: { sampleStatus: AccreditationStatus.REJECTED }, details: { sampleId: id, providerSpecialtyId: sample.providerSpecialtyId, reason: rejectionReason } }) });
      }

      return updated;
    });
    const rejectedProviderId = (sample as { providerProfile?: { userId?: string } }).providerProfile?.userId;
    if (rejectedProviderId) await providerNotifications.accreditationDecided({ providerId: rejectedProviderId, sampleId: id, sampleTitle: sample.title, decision: 'REJECTED', reason: rejectionReason });
    return rejected;
  }

  /**
   * The admin asks the provider to complete / fix the request (NOT a rejection). `userNote` is shown to the provider, `internalNote` never leaves the admin API.
   * The specialty is not opened and not closed: an APPROVED specialty (another model of it) keeps working.
   */
  async adminRequestCompletion(id: string, input: { userNote: string; internalNote?: string | null; fields?: string[] }, actor?: AdminActor) {
    const userNote = String(input.userNote ?? '').trim();
    if (userNote.length < 3) throw new AppError('اكتب ملاحظة واضحة للمستخدم عن البيانات المطلوب استكمالها', 400);
    const sample = await prisma.accreditationSample.findUnique({ where: { id }, include: { providerProfile: { select: { userId: true } } } });
    if (!sample) throw new AppError('نموذج الاعتماد غير موجود', 404);
    if (sample.status !== AccreditationStatus.MANUAL_REVIEW && sample.status !== AccreditationStatus.PENDING_AI_AUDIT) {
      throw new AppError('لا يمكن طلب الاستكمال إلا لطلب قيد المراجعة', 409);
    }
    const fields = [...new Set((input.fields ?? []).filter(f => typeof f === 'string' && f.trim()).map(f => f.trim()))].slice(0, 12);
    const updated = await prisma.$transaction(async (tx) => {
      // conditional transition: a concurrent decision matches zero rows
      const moved = await tx.accreditationSample.updateMany({
        where: { id, status: { in: [AccreditationStatus.MANUAL_REVIEW, AccreditationStatus.PENDING_AI_AUDIT] } },
        data: { status: AccreditationStatus.NEEDS_COMPLETION, userNote, internalNote: input.internalNote?.trim() || sample.internalNote, completionFields: fields, decidedAt: null },
      });
      if (moved.count !== 1) throw new AppError('تمت معالجة هذا الطلب مسبقاً', 409);
      await tx.accreditationSampleEvent.create({ data: { sampleId: id, kind: 'COMPLETION_REQUESTED', revision: sample.revision, userNote, internalNote: input.internalNote?.trim() || null, actorId: actor?.id ?? null } });
      const providerId = sample.providerProfile?.userId;
      if (actor && providerId) {
        await tx.accountAuditLog.create({ data: adminAuditData({ actor, userId: providerId, eventType: 'ACCREDITATION_COMPLETION_REQUESTED', title: 'طلب استكمال بيانات الاعتماد', summary: `طلبت الإدارة استكمال بيانات نموذج الاعتماد «${sample.title ?? ''}»`.trim(), status: LogStatus.IN_REVIEW, before: { sampleStatus: sample.status }, after: { sampleStatus: AccreditationStatus.NEEDS_COMPLETION }, details: { sampleId: id, providerSpecialtyId: sample.providerSpecialtyId, fields } }) });
      }
      return tx.accreditationSample.findUnique({ where: { id } });
    });
    const providerId = sample.providerProfile?.userId;
    if (providerId) await providerNotifications.accreditationCompletionRequested({ providerId, sampleId: id, sampleTitle: sample.title, note: userNote });
    return updated;
  }
}

export const accreditationAiService = new AccreditationAiService();
