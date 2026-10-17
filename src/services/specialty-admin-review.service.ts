import { LogCategory, LogStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { tierForVerifiedSpecialties } from './ai-assessment.service';
import { providerNotifications } from './provider-notifications.service';

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
    const result = await prisma.$transaction(async (tx) => {
      // conditional transition: a concurrent decision matches zero rows
      const moved = await tx.providerSpecialty.updateMany({
        where: { id: providerSpecialtyId, status: SpecialtyVerificationStatus.UNDER_AI_REVIEW },
        data: approved
          ? { status: SpecialtyVerificationStatus.APPROVED, isPassed: true, badgeGrantedAt: decidedAt }
          : { status: SpecialtyVerificationStatus.REJECTED },
      });
      if (moved.count !== 1) throw new AppError('تمت معالجة هذا التخصص مسبقاً', 409);

      // the samples still waiting for the admin follow the decision (same outcome as the sample approve / reject endpoints) so the provider's access state never contradicts it
      const waiting = await tx.accreditationSample.findMany({ where: { providerSpecialtyId, status: { in: ['MANUAL_REVIEW', 'PENDING_AI_AUDIT'] } }, select: { id: true, aiFeedbackAr: true } });
      for (const sample of waiting) {
        await tx.accreditationSample.update({ where: { id: sample.id }, data: approved ? { status: 'AI_VERIFIED' } : { status: 'REJECTED', aiFeedbackAr: `${sample.aiFeedbackAr || ''}\n[مراجعة الإدارة] سبب الرفض: ${input.reason}` } });
      }

      const userId = specialty.providerProfile?.userId;
      if (approved && userId) {
        // the provider tier follows the number of APPROVED specialties (an assessment pass alone no longer changes it)
        const profileId = (await tx.providerSpecialty.findUnique({ where: { id: providerSpecialtyId }, select: { providerProfileId: true } }))?.providerProfileId;
        if (profileId) {
          const approvedCount = await tx.providerSpecialty.count({ where: { providerProfileId: profileId, status: SpecialtyVerificationStatus.APPROVED } });
          await tx.user.update({ where: { id: userId }, data: { tierLevel: tierForVerifiedSpecialties(approvedCount) } }).catch(() => {});
        }
      }
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
    const providerId = specialty.providerProfile?.userId;
    if (providerId) await providerNotifications.specialtyDecided({ providerId, specialtyName: specialty.specialty?.nameAr, decision: input.decision, reason: input.reason });
    return result;
  }
}

const STATUS_FILTERS: Record<string, SpecialtyVerificationStatus[]> = {
	pending: [SpecialtyVerificationStatus.UNDER_AI_REVIEW],
	approved: [SpecialtyVerificationStatus.APPROVED],
	rejected: [SpecialtyVerificationStatus.REJECTED],
	all: [SpecialtyVerificationStatus.UNDER_AI_REVIEW, SpecialtyVerificationStatus.APPROVED, SpecialtyVerificationStatus.REJECTED]
};

const providerSummary = (ps: any) => {
	const u = ps.providerProfile?.user;
	return {
		userId: u?.id ?? ps.providerProfile?.userId ?? null,
		name: u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email : null,
		email: u?.email ?? null,
		accountType: u?.accountType ?? null,
		memberSince: u?.createdAt ?? null,
		rating: u?.ratingAverage ?? null,
		completedProjects: u?.completedProjectsCount ?? 0,
		kycStatus: ps.providerProfile?.kycStatus ?? null
	};
};

const reviewUserSelect = { id: true, firstName: true, lastName: true, email: true, accountType: true, createdAt: true, ratingAverage: true, completedProjectsCount: true } as const;

/** Read side of the specialty review: the admin queue (UNDER_AI_REVIEW) and its decided history, straight from provider_specialties. */
export class SpecialtyReviewQueryService {
	async list(params: { status?: string; search?: string; page?: number; limit?: number }) {
		const key = String(params.status ?? 'pending').toLowerCase();
		const statuses = STATUS_FILTERS[key];
		if (!statuses) throw new AppError('حالة غير صحيحة', 400);
		const page = Math.max(1, Math.floor(Number(params.page)) || 1);
		const limit = Math.min(100, Math.max(1, Math.floor(Number(params.limit)) || 20));
		const term = String(params.search ?? '').trim().slice(0, 100);
		const where = {
			status: { in: statuses },
			...(term ? { OR: [
				{ specialty: { nameAr: { contains: term, mode: 'insensitive' as const } } },
				{ providerProfile: { user: { email: { contains: term, mode: 'insensitive' as const } } } },
				{ providerProfile: { user: { firstName: { contains: term, mode: 'insensitive' as const } } } },
				{ providerProfile: { user: { lastName: { contains: term, mode: 'insensitive' as const } } } }
			] } : {})
		};
		const [rows, total, pending, approved, rejected] = await Promise.all([
			prisma.providerSpecialty.findMany({
				where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: limit,
				select: {
					id: true, status: true, subSpecialties: true, aiScore: true, quizScore: true, latestScore: true, ownershipCredibility: true, badgeGrantedAt: true, createdAt: true, updatedAt: true,
					specialty: { select: { id: true, nameAr: true } },
					providerProfile: { select: { userId: true, kycStatus: true, user: { select: reviewUserSelect } } },
					_count: { select: { accreditationSamples: true, workSamples: true } }
				}
			}),
			prisma.providerSpecialty.count({ where }),
			prisma.providerSpecialty.count({ where: { status: SpecialtyVerificationStatus.UNDER_AI_REVIEW } }),
			prisma.providerSpecialty.count({ where: { status: SpecialtyVerificationStatus.APPROVED } }),
			prisma.providerSpecialty.count({ where: { status: SpecialtyVerificationStatus.REJECTED } })
		]);
		return {
			items: rows.map((r: any) => ({
				id: r.id, status: r.status, specialty: r.specialty, subSpecialties: r.subSpecialties, provider: providerSummary(r),
				scores: { aiScore: r.aiScore, quizScore: r.quizScore, latestScore: r.latestScore, ownershipCredibility: r.ownershipCredibility },
				accreditationSamples: r._count?.accreditationSamples ?? 0, workSamples: r._count?.workSamples ?? 0, badgeGrantedAt: r.badgeGrantedAt, submittedAt: r.createdAt, updatedAt: r.updatedAt
			})),
			pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
			counts: { pending, approved, rejected, all: pending + approved + rejected }
		};
	}

	async get(id: string) {
		const ps: any = await prisma.providerSpecialty.findUnique({
			where: { id },
			select: {
				id: true, status: true, subSpecialties: true, aiScore: true, quizScore: true, latestScore: true, ownershipCredibility: true, feasibilityScore: true, clarityScore: true, aiFeedback: true,
				isPassed: true, hasTakenAssessment: true, badgeGrantedAt: true, createdAt: true, updatedAt: true, providerProfileId: true,
				specialty: { select: { id: true, nameAr: true, category: { select: { nameAr: true } } } },
				providerProfile: { select: { userId: true, kycStatus: true, yearsOfExperience: true, headline: true, user: { select: reviewUserSelect } } },
				accreditationSamples: { orderBy: { createdAt: 'desc' }, select: { id: true, title: true, description: true, status: true, projectUrl: true, githubUrl: true, technologiesUsed: true, attachments: true, createdAt: true } },
				workSamples: { orderBy: { createdAt: 'desc' }, select: { id: true, title: true, description: true, technologies: true, publicSampleUrl: true, mimeType: true, createdAt: true } }
			}
		});
		if (!ps) throw new AppError('التخصص غير موجود', 404);
		const userId = ps.providerProfile?.userId;
		const [otherPending, decisions] = await Promise.all([
			prisma.providerSpecialty.findMany({ where: { providerProfileId: ps.providerProfileId, status: SpecialtyVerificationStatus.UNDER_AI_REVIEW, id: { not: id } }, select: { id: true, status: true, specialty: { select: { nameAr: true } } } }),
			userId ? prisma.accountAuditLog.findMany({ where: { userId, eventType: 'SPECIALTY_ADMIN_DECISION', metaData: { path: ['providerSpecialtyId'], equals: id } }, orderBy: { occurredAt: 'desc' }, take: 5, select: { id: true, title: true, summary: true, status: true, occurredAt: true } }) : Promise.resolve([])
		]);
		return {
			id: ps.id, status: ps.status, specialty: { id: ps.specialty?.id, nameAr: ps.specialty?.nameAr, categoryNameAr: ps.specialty?.category?.nameAr ?? null },
			subSpecialties: ps.subSpecialties, provider: { ...providerSummary(ps), yearsOfExperience: ps.providerProfile?.yearsOfExperience ?? null, headline: ps.providerProfile?.headline ?? null },
			scores: { aiScore: ps.aiScore, quizScore: ps.quizScore, latestScore: ps.latestScore, ownershipCredibility: ps.ownershipCredibility, feasibilityScore: ps.feasibilityScore, clarityScore: ps.clarityScore },
			assessmentTaken: ps.hasTakenAssessment, assessmentPassed: ps.isPassed, aiFeedback: ps.aiFeedback ?? null,
			accreditationSamples: ps.accreditationSamples, workSamples: ps.workSamples, otherPending: otherPending.map((o: any) => ({ id: o.id, specialty: o.specialty?.nameAr ?? null, status: o.status })),
			decisions, badgeGrantedAt: ps.badgeGrantedAt, submittedAt: ps.createdAt, updatedAt: ps.updatedAt
		};
	}
}

export const specialtyReviewQueryService = new SpecialtyReviewQueryService();

export const specialtyAdminReviewService = new SpecialtyAdminReviewService();
