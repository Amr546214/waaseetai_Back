import { z } from 'zod';
import { ModelStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError, fieldError, zodAppError } from '../utils/app-error';

// Moderation maps onto the existing ServiceCatalog.status workflow; nothing new is stored.
const ACTIONS = { APPROVE: 'PUBLISHED', REJECT: 'REJECTED', HIDE: 'ARCHIVED', RESTORE: 'PUBLISHED' } as const;
const ALLOWED_FROM: Record<keyof typeof ACTIONS, string[]> = {
	APPROVE: ['PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'],
	REJECT: ['PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED', 'PUBLISHED'],
	HIDE: ['PUBLISHED', 'APPROVED'],
	RESTORE: ['ARCHIVED']
};
export const moderationSchema = z.object({
	action: z.enum(['APPROVE', 'REJECT', 'HIDE', 'RESTORE'], { message: 'الإجراء غير صحيح' }),
	reason: z.string().trim().max(1000).optional(),
	expectedStatus: z.nativeEnum(ModelStatus).optional()
}).strict();

const STATUSES: ModelStatus[] = ['PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED'];

export class AdminMarketplaceModerationService {
	async list(q: { status?: string; search?: string; page?: number; limit?: number }, includeProviderEmail = true) {
		const where: Record<string, unknown> = {};
		if (q.status) { const s = q.status.toUpperCase(); if (!STATUSES.some(status => status === s)) throw new AppError('حالة غير صحيحة', 400); where.status = s; }
		else where.status = { in: STATUSES };
		if (q.search?.trim()) where.title = { contains: q.search.trim(), mode: 'insensitive' };
		const page = Math.max(1, Number(q.page) || 1), limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
		const [items, total] = await prisma.$transaction([
			prisma.serviceCatalog.findMany({
				where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
				select: { id: true, title: true, status: true, totalAmount: true, totalDays: true, aiScore: true, auditRejectionReason: true, approvedAt: true, createdAt: true, updatedAt: true,
					provider: { select: { id: true, firstName: true, lastName: true, email: includeProviderEmail } }, specialty: { select: { id: true, nameAr: true } } }
			}),
			prisma.serviceCatalog.count({ where })
		]);
		return { items, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
	}

	async detail(id: string) {
		const item = await prisma.serviceCatalog.findFirst({
			where: { id, status: { in: STATUSES } },
			select: {
				id: true, title: true, description: true, status: true, totalAmount: true, totalDays: true,
				auditRejectionReason: true, createdAt: true, updatedAt: true,
				provider: { select: { id: true, firstName: true, lastName: true } },
				specialty: { select: { id: true, nameAr: true } },
				stages: { orderBy: { stepOrder: 'asc' }, select: { id: true, title: true, description: true, deliveryDays: true } },
			},
		});
		if (!item) throw new AppError('النموذج غير موجود', 404);
		const actions = (Object.keys(ALLOWED_FROM) as Array<keyof typeof ACTIONS>)
			.filter(action => ALLOWED_FROM[action].includes(item.status));
		return { ...item, actions };
	}

	async moderate(id: string, body: unknown) {
		const parsed = moderationSchema.safeParse(body);
		if (!parsed.success) throw zodAppError(parsed.error.issues, parsed.error.issues[0]?.message || 'بيانات غير صالحة', { reason: 'السبب غير صالح' });
		const { action, reason, expectedStatus } = parsed.data;
		if (action === 'REJECT' && !reason) throw fieldError('reason', 'سبب الرفض مطلوب');
		const svc = await prisma.serviceCatalog.findUnique({ where: { id }, select: { id: true, title: true, status: true, providerId: true, approvedAt: true } });
		if (!svc) throw new AppError('الخدمة غير موجودة', 404);
		if ((expectedStatus && expectedStatus !== svc.status) || !ALLOWED_FROM[action].includes(svc.status)) throw new AppError('لا يمكن تنفيذ هذا الإجراء على حالة الخدمة الحالية', 409);
		const next = ACTIONS[action];
		const updated = await prisma.serviceCatalog.update({
			where: { id, status: svc.status },
			data: {
				status: next,
				...(action === 'REJECT' ? { auditRejectionReason: reason } : {}),
				...(action === 'APPROVE' ? { approvedAt: svc.approvedAt ?? new Date(), auditRejectionReason: null } : {})
			},
			select: { id: true, title: true, status: true, auditRejectionReason: true, approvedAt: true }
		}).catch((error: unknown) => {
			if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') {
				throw new AppError('تغيّرت حالة النموذج. حدّث الصفحة قبل اتخاذ قرار جديد', 409);
			}
			throw error;
		});
		return { before: { status: svc.status }, after: { status: updated.status }, service: updated, providerId: svc.providerId, action, reason: reason ?? null };
	}
}

export const adminMarketplaceModerationService = new AdminMarketplaceModerationService();
