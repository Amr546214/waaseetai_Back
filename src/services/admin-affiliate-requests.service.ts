import { prisma } from '../config/db';
import { ChangeRequestStatus, SensitiveFieldType, Prisma } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { notificationService } from './notification.service';

const PENDING_STATUSES: ChangeRequestStatus[] = [ChangeRequestStatus.PENDING_AI_REVIEW, ChangeRequestStatus.PENDING_HUMAN_APPROVAL];

const affiliateRequestInclude = {
	affiliateProfile: {
		select: {
			id: true,
			userId: true,
			referralSlug: true,
			user: { select: { id: true, firstName: true, lastName: true, email: true } }
		}
	}
} as const;

/**
 * Admin review surface for AffiliateProfile's ProfileChangeRequest — the
 * equivalent of provider-profile.service.ts's reviewSensitiveChange/
 * getPendingSensitiveReviews for ProviderProfile's (separate model)
 * ProfileModificationRequest. Deliberately its own service/model — the two
 * are never mixed.
 */
export class AdminAffiliateRequestsService {
	public async listRequests(status?: string) {
		const where = status && status !== 'ALL'
			? { status: status as ChangeRequestStatus }
			: { status: { in: PENDING_STATUSES } };

		return prisma.profileChangeRequest.findMany({
			where,
			orderBy: { createdAt: 'desc' },
			include: affiliateRequestInclude
		});
	}

	public async getRequestById(id: string) {
		const request = await prisma.profileChangeRequest.findUnique({
			where: { id },
			include: affiliateRequestInclude
		});
		if (!request) throw new AppError('طلب التعديل غير موجود', 404);
		return request;
	}

	public async approve(id: string, adminUserId: string) {
		let applied;
		try {
			applied = await prisma.$transaction(async (tx) => {
				const request = await tx.profileChangeRequest.findUnique({ where: { id } });
				if (!request) throw new AppError('طلب التعديل غير موجود', 404);
				if (!PENDING_STATUSES.includes(request.status)) {
					throw new AppError('لا يمكن اعتماد طلب تم إنهاؤه أو سحبه بالفعل', 409);
				}

				await this.applyFieldChange(tx, request.affiliateProfileId, request.fieldType, request.requestedValue);

				return tx.profileChangeRequest.update({
					where: { id },
					data: {
						status: ChangeRequestStatus.APPROVED_AND_APPLIED,
						reviewedBy: adminUserId,
						appliedAt: new Date()
					},
					include: affiliateRequestInclude
				});
			});
		} catch (error: any) {
			if (error?.code === 'P2002') {
				throw new AppError('تعذر تطبيق التعديل: القيمة الجديدة مستخدمة بالفعل لحساب آخر', 409);
			}
			throw error;
		}

		await notificationService.createAndEmit({
			userId: applied.affiliateProfile.userId,
			title: 'تم اعتماد طلب التعديل',
			message: `تم اعتماد طلبك لتعديل "${applied.fieldLabel}" وتطبيقه على حسابك`,
			actionUrl: '/marketer-overview/profile/requests'
		});

		return applied;
	}

	public async reject(id: string, adminUserId: string, rejectionReason: string) {
		const rejected = await prisma.$transaction(async (tx) => {
			const request = await tx.profileChangeRequest.findUnique({ where: { id } });
			if (!request) throw new AppError('طلب التعديل غير موجود', 404);
			if (!PENDING_STATUSES.includes(request.status)) {
				throw new AppError('لا يمكن رفض طلب تم إنهاؤه أو سحبه بالفعل', 409);
			}

			return tx.profileChangeRequest.update({
				where: { id },
				data: { status: ChangeRequestStatus.REJECTED, reviewedBy: adminUserId, rejectionReason },
				include: affiliateRequestInclude
			});
		});

		await notificationService.createAndEmit({
			userId: rejected.affiliateProfile.userId,
			title: 'تم رفض طلب التعديل',
			message: `تم رفض طلبك لتعديل "${rejected.fieldLabel}"${rejectionReason ? `: ${rejectionReason}` : ''}`,
			actionUrl: '/marketer-overview/profile/requests'
		});

		return rejected;
	}

	/**
	 * fieldType -> real column mapping, verified against the current schema
	 * and the exact source each field is read from in marketer-profile.
	 * service.ts#getProfile: EMAIL/PHONE_NUMBER/NATIONAL_ID/FIRST_NAME/
	 * LAST_NAME are all User columns, IBAN/BANK_NAME/ACCOUNT_HOLDER_NAME/
	 * SWIFT_CODE are AffiliateProfile columns. Runs inside the caller's
	 * transaction so a failure here rolls
	 * back the whole approval — the request can never be marked APPROVED
	 * without the real field actually changing.
	 *
	 * EMAIL is explicitly refused (post-safety-review decision) — the
	 * public create endpoint can no longer produce an EMAIL request (see
	 * profile-requests.dto.ts/service.ts), but SensitiveFieldType.EMAIL still
	 * exists on the enum (used elsewhere) and a historical/legacy row could
	 * in principle exist, so this must fail closed rather than silently
	 * applying an unverified email change. Throwing here (inside the
	 * caller's transaction) rolls back the whole approve() call — the
	 * request is never marked APPROVED_AND_APPLIED and User.email is never
	 * touched.
	 */
	private async applyFieldChange(tx: Prisma.TransactionClient, affiliateProfileId: string, fieldType: SensitiveFieldType, requestedValue: string) {
		const profile = await tx.affiliateProfile.findUnique({ where: { id: affiliateProfileId } });
		if (!profile) throw new AppError('ملف الوسيط التسويقي المرتبط بالطلب غير موجود', 404);

		switch (fieldType) {
			case SensitiveFieldType.EMAIL:
				throw new AppError('تعديل البريد الإلكتروني يتطلب مسارًا منفصلاً للتحقق من ملكية البريد الجديد، ولا يمكن اعتماده عبر نظام طلبات التعديل الحالي', 409);
			case SensitiveFieldType.FIRST_NAME:
				await tx.user.update({ where: { id: profile.userId }, data: { firstName: requestedValue } });
				return;
			case SensitiveFieldType.LAST_NAME:
				await tx.user.update({ where: { id: profile.userId }, data: { lastName: requestedValue } });
				return;
			case SensitiveFieldType.PHONE_NUMBER:
				await tx.user.update({ where: { id: profile.userId }, data: { phoneNumber: requestedValue } });
				return;
			case SensitiveFieldType.NATIONAL_ID:
				await tx.user.update({ where: { id: profile.userId }, data: { idNumber: requestedValue } });
				return;
			case SensitiveFieldType.IBAN:
				await tx.affiliateProfile.update({ where: { id: profile.id }, data: { iban: requestedValue } });
				return;
			case SensitiveFieldType.BANK_NAME:
				await tx.affiliateProfile.update({ where: { id: profile.id }, data: { bankName: requestedValue } });
				return;
			case SensitiveFieldType.ACCOUNT_HOLDER_NAME:
				await tx.affiliateProfile.update({ where: { id: profile.id }, data: { accountHolderName: requestedValue } });
				return;
			case SensitiveFieldType.SWIFT_CODE:
				await tx.affiliateProfile.update({ where: { id: profile.id }, data: { swiftCode: requestedValue } });
				return;
			default:
				throw new AppError(`نوع حقل غير مدعوم للتطبيق: ${fieldType}`, 400);
		}
	}
}

export const adminAffiliateRequestsService = new AdminAffiliateRequestsService();
