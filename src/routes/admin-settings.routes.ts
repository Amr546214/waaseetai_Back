import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { platformSettingsService } from '../services/platform-settings.service';
import { recordAdminAudit } from '../utils/admin-audit';

const router = Router();
router.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

router.get('/', async (_req, res, next) => {
	try { res.json({ success: true, data: await platformSettingsService.getAll() }); } catch (e) { next(e); }
});

// Declared before '/' PUT is irrelevant (different path); the history feeds the "change log" on the settings page.
router.get('/history', async (req, res, next) => {
	try { res.json({ success: true, data: await platformSettingsService.history(Number(req.query.limit) || 20) }); } catch (e) { next(e); }
});

router.put('/', async (req, res, next) => {
	try {
		const clean = platformSettingsService.validate(req.body);
		const result = await platformSettingsService.update(clean, req.user!.id);
		if (result.changed.length) {
			await recordAdminAudit(req, {
				eventType: 'PLATFORM_SETTINGS_UPDATED', title: 'تعديل إعدادات المنصة',
				summary: `تعديل إعدادات المنصة: ${result.changed.join('، ')}`, before: result.before, after: result.after, details: { keys: result.changed }
			});
		}
		res.json({ success: true, message: result.changed.length ? 'تم حفظ الإعدادات' : 'لا توجد تغييرات للحفظ', data: result.settings });
	} catch (e) { next(e); }
});

export default router;
