import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { NextFunction, Request, Response, Router } from 'express';
import { AliasKey, SiteIdentityService, siteIdentityService } from '../services/site-identity.service';

/**
 * PUBLIC, no authentication: the published identity manifest and the immutable bytes behind it. Exposes nothing else: no history, no storage fields, no uploader ids, no staged / discarded content.
 *   GET /public/site-identity                          -> {success, data:{version, items:{key:{url,sha256,mime,width,height,version}}}}  (only keys with an active custom version; empty = all built-in defaults)
 *   GET /public/site-identity/assets/:key/:sha256      -> the bytes (immutable: the URL carries the sha256)
 * `url` in the manifest is relative to the API base (the same base the page used to call this route).
 */
export function buildPublicSiteIdentityRouter(service: SiteIdentityService = siteIdentityService): Router {
	const router = Router();

	/** the serialised manifest (+ its gzip) of the last state served: rebuilt only when the ETag changes, so a 340-icon manifest is stringified and compressed once per change, not once per request */
	let cached: { etag: string; json: Buffer; gzip: Buffer } | null = null;
	router.get('/site-identity', async (req, res, next) => {
		try {
			const m = await service.publicManifest();
			const etag = `W/"si-${m.version}-${createHash('sha1').update(JSON.stringify(m.items)).digest('hex').slice(0, 16)}"`;
			res.set({ 'Cache-Control': 'public, max-age=60', ETag: etag, Vary: 'Accept-Encoding' });
			if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
			if (!cached || cached.etag !== etag) { const json = Buffer.from(JSON.stringify({ success: true, data: m })); cached = { etag, json, gzip: gzipSync(json, { level: 6 }) }; }
			const useGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? '')) && cached.gzip.length < cached.json.length;
			res.set({ 'Content-Type': 'application/json; charset=utf-8', ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}) });
			res.status(200).end(useGzip ? cached.gzip : cached.json);
		} catch (e) { next(e); }
	});

	/** stable alias URLs for the two consumers that cannot read the manifest (crawlers, the browser's own /favicon.ico request): custom file if published, else the default file unchanged */
	const alias = (key: AliasKey) => async (req: Request, res: Response, next: NextFunction) => {
		try {
			const a = await service.publicAlias(key); const etag = `"${a.sha256}"`;
			res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400', ETag: etag, 'X-Identity-Source': a.source, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Disposition': 'inline' });
			if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
			res.status(200).end(a.bytes);
		} catch (e) { next(e); }
	};
	const notAllowed = (_req: Request, res: Response) => { res.set('Allow', 'GET, HEAD').status(405).json({ success: false, message: 'الطريقة غير مسموحة.' }); };
	router.route('/site-identity/social/og').get(alias('social.og')).all(notAllowed);
	router.route('/site-identity/favicon.ico').get(alias('favicon.ico')).all(notAllowed);

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
