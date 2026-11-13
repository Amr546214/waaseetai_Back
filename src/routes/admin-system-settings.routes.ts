import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { loadAdminActor, requireAdminAccount, requireAnyPermission, requirePermission, requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { systemSettingsService } from '../services/system-settings.service';
import { isOfficialDeployment } from '../utils/deployment-identity';
import { AppError } from '../utils/app-error';
import { loginGuardService } from '../services/login-guard.service';
import { currencyReadiness } from '../services/currency-readiness.service';

/** Unified system settings: active Super Admin access on both dev and the official deployment.
 * Environment classification is diagnostic metadata, never an access condition. */
const router = Router();
const ok = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await fn(req) }); } catch (e) { next(e); }
};
router.use(authenticate, requireActiveUser);
// What the unified «إعدادات النظام» page needs before it draws anything: may THIS caller see the operations panel here? Decided on the server (the account type read from the database; deployment metadata is informational only).
router.get('/access', requireAdminAccount, async (req, res, next) => { try { const actor = await loadAdminActor(req); if (!actor.isSuperAdmin && actor.permissions.size === 0) throw new AppError('غير مصرح لك بالوصول لهذه الصلاحية', 403); res.json({ success: true, data: { officialDeployment: isOfficialDeployment(), isSuperAdmin: actor.isSuperAdmin, available: actor.isSuperAdmin } }); } catch (e) { next(e); } });
// The operations panel is SUPER_ADMIN only on every deployment, for reading as well as writing (hiding a button is not access control).
router.use(requireSuperAdmin);

router.get('/', ok(async req => systemSettingsService.view(await loadAdminActor(req))));
router.put('/', requirePermission('settings.manage'), ok(async req => systemSettingsService.update(await loadAdminActor(req), req.body, { ip: req.ip, device: String(req.headers['user-agent'] || '') })));
router.get('/history', ok(async req => systemSettingsService.history(await loadAdminActor(req), Number(req.query.limit) || 20)));
router.get('/health', ok(() => systemSettingsService.health()));
router.get('/login-protection/impact', requireSuperAdmin, ok(async req => { const n = (k: string) => (req.query[k] === undefined ? undefined : Number(req.query[k])); return loginGuardService.impact({ maxFails: n('maxFails'), windowMin: n('windowMin'), blockMin: n('blockMin'), ipMaxFails: n('ipMaxFails') } as never); }));
router.get('/sessions-impact', requireSuperAdmin, ok(req => systemSettingsService.sessionsImpact(req.query.idleMinutes)));
router.get('/currency-readiness', requireSuperAdmin, ok(() => currencyReadiness()));

export default router;
