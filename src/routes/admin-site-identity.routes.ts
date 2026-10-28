import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { loadAdminActor, requireAnyPermission, requirePermission } from '../middlewares/admin-access.middleware';
import { SITE_IDENTITY_EDIT_PERMISSIONS, SITE_IDENTITY_READ_PERMISSIONS } from '../config/admin-permissions';
import { actorHasAny } from '../services/admin-access.service';
import { memoryUpload } from '../utils/cloudinary-storage';
import { AppError } from '../utils/app-error';
import { ATLAS_MAX_BYTES, KEY_PATTERN, isKnownIdentityKey } from '../config/site-identity.registry';
import { isTokenKey } from '../config/site-identity-tokens';
import { ICON_PREFIX } from '../config/site-identity-icons';
import { SiteIdentityConflict, SiteIdentityService, SITE_IDENTITY_ERRORS, iconUnknownMessage, siteIdentityService } from '../services/site-identity.service';

/**
 * /api/admin/site-identity - the identity manager of «التحكم بالموقع». Reading (the page, history, previews) needs `site.view`, `site.manage` or the legacy section id `site_control.manage`; uploading, publishing, restoring and
 * discarding need the EDIT capability = `site.manage` OR the legacy `site_control.manage` (its old meaning "manage التحكم بالموقع" is mapped onto edit; `site.view` stays read-only: see SITE_IDENTITY_EDIT_PERMISSIONS).
 * SUPER_ADMIN holds every permission; no base role holds any. The read guard sits on the router (every route, before any body is read) and the write routes add the edit guard themselves.
 * Success bodies are `{success:true, data}`; a version conflict is `409 {success:false, message, code:'SITE_IDENTITY_VERSION_CONFLICT', current}` where `current` is the winner's state.
 * Design-token keys (`tokens.*`, kind json) accept the upload either as multipart field `file` (a JSON file) or as a JSON body `{ "value": { "--teal": "#..." } }`.
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
	const knownKey = (req: Request, _res: Response, next: NextFunction) => {
		const key = String(req.params.key);
		if (KEY_PATTERN.test(key) && isKnownIdentityKey(key)) return next();
		const id = key.startsWith(ICON_PREFIX) ? key.slice(ICON_PREFIX.length) : null;
		next(new AppError(id !== null ? iconUnknownMessage(id) : 'عنصر الهوية غير موجود.', 404, undefined, SITE_IDENTITY_ERRORS.UNKNOWN_KEY));
	};
	const upload = memoryUpload({ fileSize: ATLAS_MAX_BYTES, files: 1 });

	const edit = requireAnyPermission(...SITE_IDENTITY_EDIT_PERMISSIONS);
	/** the uploaded file, or (token keys only) the JSON `value` of the body turned into the same kind of in-memory file */
	const fileOf = (req: Request) => req.file ?? (isTokenKey(String(req.params.key)) && req.body && typeof req.body === 'object' && !Array.isArray(req.body) && (req.body as Record<string, unknown>).value !== undefined
		? { buffer: Buffer.from(JSON.stringify((req.body as Record<string, unknown>).value) ?? '', 'utf8'), mimetype: 'application/json', fromValue: true } : undefined);

	router.use(authenticate, requireActiveUser, requireAnyPermission(...SITE_IDENTITY_READ_PERMISSIONS));

	router.get('/', ok(async req => {
		const actor = await loadAdminActor(req);
		return service.overview(actorHasAny(actor, ...SITE_IDENTITY_EDIT_PERMISSIONS), req.user!.id, !actor.isSuperAdmin && actorHasAny(actor, 'site_control.manage') && !actorHasAny(actor, 'site.manage', 'site.view'));
	}));
	router.get('/families', ok(() => service.familyList()));
	router.get('/families/:id', ok(async req => service.familyItem(String(req.params.id), actorHasAny(await loadAdminActor(req), ...SITE_IDENTITY_EDIT_PERMISSIONS), req.user!.id)));
	router.get('/icons', ok(req => service.iconList(req.query as Record<string, unknown>)));
	router.get('/icons/:symbolId', ok(async req => service.iconItem(String(req.params.symbolId), actorHasAny(await loadAdminActor(req), ...SITE_IDENTITY_EDIT_PERMISSIONS), req.user!.id)));
	router.get('/history', ok(req => service.history(req.query as Record<string, unknown>)));
	router.get('/restore-set/:manifestVersion/preview', ok(req => service.previewRestoreSet(req.params.manifestVersion)));
	router.get('/:key/versions/:id/preview', knownKey, async (req, res, next) => {
		try {
			const r = await service.previewBytes(String(req.params.key), String(req.params.id));
			res.set({ 'Content-Type': r.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'cross-origin',
				...(r.mime === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
			res.status(200).end(r.bytes);
		} catch (e) { next(e); }
	});

	router.post('/families/:id/upload', edit, upload.single('file'), ok(req => service.familyUpload(String(req.params.id), req.file, (req.body as Record<string, unknown> | undefined)?.keys, req.user!.id, ctx(req), (req.body as Record<string, unknown> | undefined)?.sourceRef), 201));
	router.post('/families/:id/preview', edit, ok(req => service.familyPreview(String(req.params.id), req.body ?? {}, req.user!.id)));
	router.post('/families/:id/publish', edit, ok(req => service.familyApply(String(req.params.id), 'publish', req.body ?? {}, req.user!.id, ctx(req))));
	router.post('/families/:id/restore', edit, ok(req => service.familyApply(String(req.params.id), 'restore', req.body ?? {}, req.user!.id, ctx(req))));
	router.delete('/families/:id/drafts', edit, ok(req => service.familyDiscard(String(req.params.id), req.body ?? {}, req.user!.id, ctx(req))));
	router.post('/restore-set', edit, ok(req => service.restoreSet(req.body ?? {}, req.user!.id, ctx(req))));
	router.post('/:key/upload', edit, knownKey, upload.single('file'), ok(req => service.stage(String(req.params.key), fileOf(req), req.user!.id, ctx(req), (req.body as Record<string, unknown> | undefined)?.sourceRef), 201));
	router.post('/:key/publish', edit, knownKey, ok(req => service.publish(String(req.params.key), req.body ?? {}, req.user!.id, ctx(req))));
	router.post('/:key/restore', edit, knownKey, ok(req => service.restore(String(req.params.key), req.body ?? {}, req.user!.id, ctx(req))));
	router.delete('/:key/versions/:id', edit, knownKey, ok(req => service.discard(String(req.params.key), String(req.params.id), req.user!.id, ctx(req))));
	return router;
}

export default buildAdminSiteIdentityRouter();
