import { NextFunction, Request, Response } from 'express';
import zlib from 'node:zlib';

/**
 * gzip for JSON API answers. Measured on dev: neither this server nor the proxy in front compresses anything (/api/admin/site-identity/icons = 258 KB, /notifications?unreadOnly=true = 86 KB,
 * /api/admin/site-identity/ = 75 KB, /api/admin/system-settings = 31 KB, all raw), and the admin pages read several of them on every open.
 *
 * Only `application/json` answers of at least 1 KB, only for a client that sent `Accept-Encoding: gzip`, only when nothing else already encoded the body (a proxy / CDN that compresses later sees
 * Content-Encoding and leaves it alone). Binary answers (images, uploads, KYC files), streams, HEAD, 204/304 and anything marked `Cache-Control: no-transform` are never touched. Plain Node zlib,
 * no dependency; `API_GZIP=off` switches it off without a deploy of code. The body is identical after decoding (no field is added or removed).
 */
const MIN_BYTES = 1024;

export function responseGzip(req: Request, res: Response, next: NextFunction): void {
	if (process.env.API_GZIP === 'off' || req.method === 'HEAD' || !/\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) return next();
	const send = res.send.bind(res) as (body?: unknown) => Response;
	res.send = function (this: Response, body?: unknown): Response {
		try {
			const ct = String(this.getHeader('Content-Type') ?? '');
			const ok = !this.headersSent && this.statusCode !== 204 && this.statusCode !== 304 && !this.getHeader('Content-Encoding')
				&& /^application\/json\b/i.test(ct) && !/no-transform/i.test(String(this.getHeader('Cache-Control') ?? ''))
				&& (typeof body === 'string' || Buffer.isBuffer(body)) && Buffer.byteLength(body) >= MIN_BYTES;
			if (ok) {
				const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : (body as Buffer);
				const gz = zlib.gzipSync(raw, { level: 4 });
				if (gz.length < raw.length) {
					this.setHeader('Content-Encoding', 'gzip');
					this.vary('Accept-Encoding');
					this.removeHeader('Content-Length');
					return send(gz);
				}
			}
		} catch { /* any failure: send the answer as it was */ }
		return send(body);
	} as Response['send'];
	next();
}
