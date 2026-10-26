import { createHash } from 'node:crypto';
import { Router } from 'express';
import { SiteIdentityService, siteIdentityService } from '../services/site-identity.service';

/**
 * PUBLIC, no authentication: the published identity manifest and the immutable bytes behind it. Exposes nothing else: no history, no storage fields, no uploader ids, no staged / discarded content.
 *   GET /public/site-identity                          -> {success, data:{version, items:{key:{url,sha256,mime,width,height,version}}}}  (only keys with an active custom version; empty = all built-in defaults)
 *   GET /public/site-identity/assets/:key/:sha256      -> the bytes (immutable: the URL carries the sha256)
 * `url` in the manifest is relative to the API base (the same base the page used to call this route).
 */
export function buildPublicSiteIdentityRouter(service: SiteIdentityService = siteIdentityService): Router {
	const router = Router();

	router.get('/site-identity', async (req, res, next) => {
		try {
			const m = await service.publicManifest();
			const etag = `W/"si-${m.version}-${createHash('sha1').update(JSON.stringify(m.items)).digest('hex').slice(0, 16)}"`;
			res.set({ 'Cache-Control': 'public, max-age=60', ETag: etag, Vary: 'Accept-Encoding' });
			if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
			res.json({ success: true, data: m });
		} catch (e) { next(e); }
	});

	router.get('/site-identity/assets/:key/:sha256', async (req, res, next) => {
		try {
			const a = await service.publicAsset(String(req.params.key), String(req.params.sha256).toLowerCase());
			if (!a) { res.set('Cache-Control', 'no-store').status(404).json({ success: false, message: 'الملف غير موجود.' }); return; }
			const etag = `"${String(req.params.sha256).toLowerCase()}"`;
			res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Disposition': 'inline',
				...(a.mime === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
			if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
			res.status(200).end(a.bytes);
		} catch (e) { next(e); }
	});
	return router;
}

export default buildPublicSiteIdentityRouter();
