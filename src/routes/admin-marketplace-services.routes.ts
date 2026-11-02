import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminMarketplaceModerationService } from '../services/admin-marketplace-moderation.service';
import { recordAdminAudit } from '../utils/admin-audit';
import { AppError } from '../utils/app-error';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('content.manage'));

router.get('/', async (req, res, next) => {
	try {
		const q = req.query as Record<string, string | undefined>;
		res.json({ success: true, data: await adminMarketplaceModerationService.list({ status: q.status, search: q.search, page: Number(q.page), limit: Number(q.limit) }) });
	} catch (e) { next(e); }
});

router.patch('/:id/moderation', async (req, res, next) => {
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
