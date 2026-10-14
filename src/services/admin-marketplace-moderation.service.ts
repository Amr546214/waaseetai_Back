import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

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
	reason: z.string().trim().max(1000).optional()
}).strict();

const STATUSES = ['PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED'];

export class AdminMarketplaceModerationService {
	async list(q: { status?: string; search?: string; page?: number; limit?: number }) {
		const where: Record<string, unknown> = {};
		if (q.status) { const s = q.status.toUpperCase(); if (!STATUSES.includes(s)) throw new AppError('حالة غير صحيحة', 400); where.status = s; }
		else where.status = { in: STATUSES };
		if (q.search?.trim()) where.title = { contains: q.search.trim(), mode: 'insensitive' };
		const page = Math.max(1, Number(q.page) || 1), limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
		const [items, total] = await prisma.$transaction([
			prisma.serviceCatalog.findMany({
				where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: limit,
				select: { id: true, title: true, status: true, totalAmount: true, totalDays: true, aiScore: true, auditRejectionReason: true, approvedAt: true, createdAt: true, updatedAt: true,
					provider: { select: { id: true, firstName: true, lastName: true, email: true } }, specialty: { select: { id: true, nameAr: true } } }
			}),
			prisma.serviceCatalog.count({ where })
		]);
		return { items, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
	}

	async moderate(id: string, body: unknown) {
		const parsed = moderationSchema.safeParse(body);
		if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || 'بيانات غير صالحة', 400);
		const { action, reason } = parsed.data;
		if (action === 'REJECT' && !reason) throw new AppError('سبب الرفض مطلوب', 400);
		const svc = await prisma.serviceCatalog.findUnique({ where: { id }, select: { id: true, title: true, status: true, providerId: true, approvedAt: true } });
		if (!svc) throw new AppError('الخدمة غير موجودة', 404);
		if (!ALLOWED_FROM[action].includes(svc.status)) throw new AppError('لا يمكن تنفيذ هذا الإجراء على حالة الخدمة الحالية', 409);
		const next = ACTIONS[action];
		const updated = await prisma.serviceCatalog.update({
			where: { id },
			data: {
				status: next,
				...(action === 'REJECT' ? { auditRejectionReason: reason } : {}),
				...(action === 'APPROVE' ? { approvedAt: svc.approvedAt ?? new Date(), auditRejectionReason: null } : {})
			},
			select: { id: true, title: true, status: true, auditRejectionReason: true, approvedAt: true }
		});
		return { before: { status: svc.status }, after: { status: updated.status }, service: updated, providerId: svc.providerId, action, reason: reason ?? null };
	}
}

export const adminMarketplaceModerationService = new AdminMarketplaceModerationService();
