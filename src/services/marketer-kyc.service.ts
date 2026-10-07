import { LogCategory } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { uploadMulterFile } from '../utils/cloudinary-storage';
import { sanitizeText } from '../utils/sanitize-text';
import { notificationService } from './notification.service';
import { accountAuditLogService, AuditContext } from './account-logs.service';

// AUD-FND-000051 — marketer identity document. No schema change: the two existing AffiliateProfile columns carry the whole state.
//   kycDocumentUrl set + identityVerified=false  → PENDING (visible in the admin review list)
//   identityVerified=true                         → APPROVED (only an admin decision writes it)
//   kycDocumentUrl null + identityVerified=false  → none (never uploaded, or the admin rejected it; the reason is sent as a notification
//                                                   and kept in the account audit log — there is no column for a persisted rejection reason)
export const MARKETER_KYC_ALREADY_VERIFIED = 'تم توثيق هويتك مسبقًا ولا يمكن رفع مستند جديد';

export class MarketerKycService {
	/** The marketer uploads (or replaces) the document. Stored PRIVATE; identityVerified is never touched here. */
	async submitDocument(userId: string, file: Express.Multer.File, context?: AuditContext) {
		const profile = await prisma.affiliateProfile.findUnique({ where: { userId }, select: { id: true, identityVerified: true } });
		if (!profile) throw new AppError('ملف الوسيط غير موجود', 404);
		if (profile.identityVerified) throw new AppError(MARKETER_KYC_ALREADY_VERIFIED, 409);

		const stored = await uploadMulterFile(file, `waseetai/marketers/${userId}/identity`, undefined, true);
		// updateMany + identityVerified:false so a concurrent approval can never be overwritten by this write
		const { count } = await prisma.affiliateProfile.updateMany({ where: { id: profile.id, identityVerified: false }, data: { kycDocumentUrl: stored.privateRef } });
		if (count === 0) throw new AppError(MARKETER_KYC_ALREADY_VERIFIED, 409);

		await accountAuditLogService.record({
			userId, eventType: 'MARKETER_KYC_DOCUMENT_SUBMITTED', category: LogCategory.SECURITY_CHANGE, title: 'رفع مستند هوية الوسيط',
			summary: 'رفع الوسيط مستند هوية للمراجعة.', source: 'USER', severity: 'INFO', context
		});
		return { status: 'PENDING' as const };
	}

	async getStatus(userId: string) {
		const p = await prisma.affiliateProfile.findUnique({ where: { userId }, select: { identityVerified: true, kycDocumentUrl: true } });
		if (!p) throw new AppError('ملف الوسيط غير موجود', 404);
		return { status: p.identityVerified ? ('APPROVED' as const) : p.kycDocumentUrl ? ('PENDING' as const) : ('NONE' as const) };
	}

	/** Admin review queue: documents waiting for a decision. */
	async listPending(page = 1, limit = 20) {
		const take = Math.min(100, Math.max(1, limit));
		const skip = (Math.max(1, page) - 1) * take;
		const where = { identityVerified: false, kycDocumentUrl: { not: null } };
		const [items, total] = await Promise.all([
			prisma.affiliateProfile.findMany({
				where, orderBy: { updatedAt: 'asc' }, skip, take,
				select: { id: true, userId: true, referralSlug: true, updatedAt: true, kycDocumentUrl: true, user: { select: { firstName: true, lastName: true, email: true } } }
			}),
			prisma.affiliateProfile.count({ where })
		]);
		return {
			items: items.map(i => ({ affiliateId: i.id, userId: i.userId, referralSlug: i.referralSlug, name: `${i.user?.firstName ?? ''} ${i.user?.lastName ?? ''}`.trim(), email: i.user?.email ?? null, submittedAt: i.updatedAt, kycDocumentUrl: i.kycDocumentUrl })),
			pagination: { page: Math.max(1, page), limit: take, total, totalPages: Math.max(1, Math.ceil(total / take)) }
		};
	}

	private async loadForReview(affiliateId: string, adminUserId: string) {
		const target = await prisma.affiliateProfile.findUnique({ where: { id: affiliateId }, select: { id: true, userId: true, identityVerified: true, kycDocumentUrl: true } });
		if (!target) throw new AppError('طلب التوثيق غير موجود', 404);
		// nobody decides on their own document, even an admin who also holds a marketer profile
		if (target.userId === adminUserId) throw new AppError('لا يمكنك مراجعة مستندك الشخصي', 403);
		if (target.identityVerified) throw new AppError('تم اعتماد هذا الطلب مسبقًا', 409);
		if (!target.kycDocumentUrl) throw new AppError('لا يوجد مستند قيد المراجعة لهذا الوسيط', 404);
		return target;
	}

	async approve(affiliateId: string, adminUserId: string, context?: AuditContext) {
		const target = await this.loadForReview(affiliateId, adminUserId);
		// the decision applies only to a still-pending document (a re-upload or a concurrent decision makes count 0)
		const { count } = await prisma.affiliateProfile.updateMany({ where: { id: target.id, identityVerified: false, kycDocumentUrl: { not: null } }, data: { identityVerified: true } });
		if (count === 0) throw new AppError('تعذر اعتماد الطلب لأن حالته تغيّرت', 409);
		await accountAuditLogService.record({
			userId: target.userId, eventType: 'MARKETER_KYC_APPROVED', category: LogCategory.SECURITY_CHANGE, title: 'اعتماد هوية الوسيط',
			summary: 'اعتمد مشرف مستند هوية الوسيط.', source: 'ADMIN', severity: 'INFO', details: { reviewerUserId: adminUserId }, context
		});
		await this.notify(target.userId, 'تم توثيق هويتك', 'تم اعتماد مستند الهوية وأصبح حسابك موثّقًا.');
		return { affiliateId: target.id, status: 'APPROVED' as const };
	}

	async reject(affiliateId: string, adminUserId: string, reason: string, context?: AuditContext) {
		const cleaned = sanitizeText(String(reason ?? '')).trim().slice(0, 500);
		if (cleaned.length < 3) throw new AppError('سبب الرفض مطلوب', 400);
		const target = await this.loadForReview(affiliateId, adminUserId);
		// the rejected document leaves the queue; identityVerified stays false (it is written only on approval)
		const { count } = await prisma.affiliateProfile.updateMany({ where: { id: target.id, identityVerified: false, kycDocumentUrl: { not: null } }, data: { kycDocumentUrl: null } });
		if (count === 0) throw new AppError('تعذر رفض الطلب لأن حالته تغيّرت', 409);
		await accountAuditLogService.record({
			userId: target.userId, eventType: 'MARKETER_KYC_REJECTED', category: LogCategory.SECURITY_CHANGE, title: 'رفض مستند هوية الوسيط',
			summary: 'رفض مشرف مستند هوية الوسيط.', source: 'ADMIN', severity: 'INFO', details: { reviewerUserId: adminUserId, reason: cleaned }, context
		});
		await this.notify(target.userId, 'تم رفض مستند الهوية', `تم رفض مستند الهوية: ${cleaned}. يمكنك رفع مستند جديد.`);
		return { affiliateId: target.id, status: 'REJECTED' as const };
	}

	private async notify(userId: string, title: string, message: string) {
		try {
			await notificationService.createAndEmit({ userId, title, message, actionUrl: '/marketer-overview/profile' });
		} catch { /* the decision is already committed; a failed notification must not undo it */ }
	}
}

export const marketerKycService = new MarketerKycService();
