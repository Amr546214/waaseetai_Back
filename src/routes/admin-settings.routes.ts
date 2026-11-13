import { AppError } from '../utils/app-error';
import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { platformSettingsService } from '../services/platform-settings.service';
import { recordAdminAudit } from '../utils/admin-audit';
import { requireSuperAdmin } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requireSuperAdmin);

router.get('/', async (_req, res, next) => {
	try { const data = await platformSettingsService.getAll(); res.json({ success: true, data, storageReady: await platformSettingsService.storageReady() }); } catch (e) { next(e); }
});

// Declared before '/' PUT is irrelevant (different path); the history feeds the "change log" on the settings page.
router.get('/history', async (req, res, next) => {
	try { res.json({ success: true, data: await platformSettingsService.history(Number(req.query.limit) || 20) }); } catch (e) { next(e); }
});

// Retired write format had neither expected versions nor transactionally coupled audit.
router.put('/', (_req, _res, next) => next(new AppError('استخدم إعدادات النظام الموحدة مع رقم النسخة لكل إعداد', 410, undefined, 'LEGACY_SETTINGS_WRITE_RETIRED')));

export default router;
