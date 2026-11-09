import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { adminMarketplaceModerationService } from '../services/admin-marketplace-moderation.service';
import { actorHas } from '../services/admin-access.service';
import { recordAdminAudit } from '../utils/admin-audit';
import { AppError } from '../utils/app-error';
import { requireAnyPermission, requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser);
const mayRead = requireAnyPermission('content.manage', 'business_models.review');
const pageQuery = z.object({
	status: z.string().max(32).optional(),
	search: z.string().trim().max(150).optional(),
	page: z.coerce.number().int().min(1).max(1_000_000).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/', mayRead, async (req, res, next) => {
	try {
		const parsed = pageQuery.safeParse(req.query);
		if (!parsed.success) throw new AppError('فلاتر البحث أو رقم الصفحة غير صالحة', 400);
		res.set('Cache-Control', 'no-store');
		res.json({ success: true, data: await adminMarketplaceModerationService.list(parsed.data, !!req.adminActor && actorHas(req.adminActor, 'content.manage')) });
	} catch (e) { next(e); }
});

router.get('/:id', mayRead, async (req, res, next) => {
	try {
		const id = z.string().uuid().safeParse(req.params.id);
		if (!id.success) throw new AppError('معرّف غير صالح', 400);
		res.set('Cache-Control', 'no-store');
		res.json({ success: true, data: await adminMarketplaceModerationService.detail(id.data) });
	} catch (e) { next(e); }
});

router.patch('/:id/moderation', requirePermission('content.manage'), async (req, res, next) => {
	try {
		const id = String(req.params.id);
		if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('معرّف غير صالح', 400);
		const r = await adminMarketplaceModerationService.moderate(id, req.body);
		await recordAdminAudit(req, {
			eventType: `MARKETPLACE_SERVICE_${r.action}`, title: 'مراجعة خدمة في السوق', severity: r.action === 'REJECT' || r.action === 'HIDE' ? 'WARNING' : 'INFO',
			summary: `مراجعة خدمة «${r.service.title}»: ${r.before.status} ← ${r.after.status}`, before: r.before, after: r.after, details: { serviceId: id, providerId: r.providerId, action: r.action, reason: r.reason }
		});
		res.json({ success: true, message: 'تم تحديث حالة الخدمة', data: r.service });
	} catch (e) { next(e); }
});

export default router;
