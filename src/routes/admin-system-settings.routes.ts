import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { loadAdminActor, requireAnyPermission, requirePermission, requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { systemSettingsService } from '../services/system-settings.service';
import { currencyReadiness } from '../services/currency-readiness.service';

/**
 * /api/admin/system-settings - the registry-driven settings of «إعدادات النظام» and «Super Admin».
 * The router needs `settings.view` or `settings.manage`; WHICH keys a caller may read or change is decided per key by the registry (SUPER_ADMIN-only keys stay SUPER_ADMIN-only).
 */
const router = Router();
const ok = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await fn(req) }); } catch (e) { next(e); }
};
router.use(authenticate, requireActiveUser, requireAnyPermission('settings.view', 'settings.manage'));

router.get('/', ok(async req => systemSettingsService.view(await loadAdminActor(req))));
router.put('/', requirePermission('settings.manage'), ok(async req => systemSettingsService.update(await loadAdminActor(req), req.body, { ip: req.ip, device: String(req.headers['user-agent'] || '') })));
router.get('/history', ok(async req => systemSettingsService.history(await loadAdminActor(req), Number(req.query.limit) || 20)));
router.get('/health', ok(() => systemSettingsService.health()));
router.get('/sessions-impact', requireSuperAdmin, ok(req => systemSettingsService.sessionsImpact(req.query.idleMinutes)));
router.get('/currency-readiness', requireSuperAdmin, ok(() => currencyReadiness()));

export default router;
