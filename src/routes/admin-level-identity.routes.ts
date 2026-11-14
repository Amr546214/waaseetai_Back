import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireAnyPermission } from '../middlewares/admin-access.middleware';
import { SITE_IDENTITY_EDIT_PERMISSIONS, SITE_IDENTITY_READ_PERMISSIONS } from '../config/admin-permissions';
import { AppError } from '../utils/app-error';
import { LEVEL_IDENTITY_CONFLICT, LevelIdentityService, levelIdentityService } from '../services/level-identity.service';

/**
 * /api/admin/level-identity - the name and colour of every level of the three ladders («هوية المستويات والشارات»). Same permissions as the rest of «التحكم بالموقع»: reading needs
 * `site.view` / `site.manage` / `site_control.manage`, saving needs the edit capability (`site.manage` or the legacy `site_control.manage`). A stale `expectedVersion` is a 409 with the winner's state.
 */
export function buildAdminLevelIdentityRouter(service: LevelIdentityService = levelIdentityService): Router {
	const router = Router();
	router.use(authenticate, requireActiveUser, requireAnyPermission(...SITE_IDENTITY_READ_PERMISSIONS));
	router.get('/', async (_req: Request, res: Response, next: NextFunction) => { try { res.json({ success: true, data: await service.view() }); } catch (e) { next(e); } });
	router.put('/', requireAnyPermission(...SITE_IDENTITY_EDIT_PERMISSIONS), async (req: Request, res: Response, next: NextFunction) => {
		try {
			const body = (req.body ?? {}) as { expectedVersion?: unknown; changes?: unknown };
			res.json({ success: true, data: await service.save(req.user!.id, { ip: req.ip, device: String(req.headers['user-agent'] || '').slice(0, 120) }, body.expectedVersion, body.changes) });
		} catch (e) {
			if (e instanceof AppError && e.code === LEVEL_IDENTITY_CONFLICT) { res.status(409).json({ success: false, message: e.message, code: e.code, current: (e as AppError & { current?: unknown }).current }); return; }
			next(e);
		}
	});
	return router;
}
export default buildAdminLevelIdentityRouter();
