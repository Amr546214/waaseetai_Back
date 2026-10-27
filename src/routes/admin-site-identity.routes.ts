import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { loadAdminActor, requireAnyPermission, requirePermission } from '../middlewares/admin-access.middleware';
import { SITE_IDENTITY_READ_PERMISSIONS } from '../config/admin-permissions';
import { actorHas } from '../services/admin-access.service';
import { memoryUpload } from '../utils/cloudinary-storage';
import { AppError } from '../utils/app-error';
import { ATLAS_MAX_BYTES, KEY_PATTERN, isKnownIdentityKey } from '../config/site-identity.registry';
import { SiteIdentityConflict, SiteIdentityService, SITE_IDENTITY_ERRORS, siteIdentityService } from '../services/site-identity.service';

/**
 * /api/admin/site-identity - the identity manager of «التحكم بالموقع». Reading (the page, history, previews) needs `site.view`, `site.manage` or the legacy section id `site_control.manage` (read-only alias, never write: see SITE_IDENTITY_READ_PERMISSIONS); uploading, publishing, restoring and discarding need
 * `site.manage`. SUPER_ADMIN holds every permission; no base role holds either. The guard sits on the router (every route, before any body is read) and the write routes add the stricter id themselves.
 * Success bodies are `{success:true, data}`; a version conflict is `409 {success:false, message, code:'SITE_IDENTITY_VERSION_CONFLICT', current}` where `current` is the winner's state.
 */
export function buildAdminSiteIdentityRouter(service: SiteIdentityService = siteIdentityService): Router {
	const router = Router();
	const ctx = (req: Request) => ({ ip: req.ip, device: String(req.headers['user-agent'] || '').slice(0, 120) });
	const ok = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
		try { res.status(status).json({ success: true, data: await fn(req) }); } catch (e) {
			if (e instanceof SiteIdentityConflict) { res.status(409).json({ success: false, message: e.message, code: e.code, current: e.current }); return; }
			next(e);
		}
	};
	/** an unknown key is refused BEFORE a file is buffered */
	const knownKey = (req: Request, _res: Response, next: NextFunction) => (KEY_PATTERN.test(String(req.params.key)) && isKnownIdentityKey(String(req.params.key)) ? next() : next(new AppError('عنصر الهوية غير موجود.', 404, undefined, SITE_IDENTITY_ERRORS.UNKNOWN_KEY)));
	const upload = memoryUpload({ fileSize: ATLAS_MAX_BYTES, files: 1 });

	router.use(authenticate, requireActiveUser, requireAnyPermission(...SITE_IDENTITY_READ_PERMISSIONS));

	router.get('/', ok(async req => service.overview(actorHas(await loadAdminActor(req), 'site.manage'))));
	router.get('/history', ok(req => service.history(req.query as Record<string, unknown>)));
	router.get('/:key/versions/:id/preview', knownKey, async (req, res, next) => {
		try {
			const r = await service.previewBytes(String(req.params.key), String(req.params.id));
			res.set({ 'Content-Type': r.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'cross-origin',
				...(r.mime === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
			res.status(200).end(r.bytes);
		} catch (e) { next(e); }
	});

	router.post('/restore-set', requirePermission('site.manage'), ok(req => service.restoreSet(req.body ?? {}, req.user!.id, ctx(req))));
	router.post('/:key/upload', requirePermission('site.manage'), knownKey, upload.single('file'), ok(req => service.stage(String(req.params.key), req.file, req.user!.id, ctx(req)), 201));
	router.post('/:key/publish', requirePermission('site.manage'), knownKey, ok(req => service.publish(String(req.params.key), req.body ?? {}, req.user!.id, ctx(req))));
	router.post('/:key/restore', requirePermission('site.manage'), knownKey, ok(req => service.restore(String(req.params.key), req.body ?? {}, req.user!.id, ctx(req))));
	router.delete('/:key/versions/:id', requirePermission('site.manage'), knownKey, ok(req => service.discard(String(req.params.key), String(req.params.id), req.user!.id, ctx(req))));
	return router;
}

export default buildAdminSiteIdentityRouter();
