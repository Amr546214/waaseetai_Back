import { logger } from '../config/logger';

/**
 * The ONE place a link that goes into an e-mail (or any text a user receives outside the app) is given its host.
 * A link without a host is worse than no link: Gmail wraps it as `http:///path` and shows Google's "invalid redirect" page.
 * So nothing here ever returns a relative or host-less URL: when the site address is not configured the answer is `null`
 * and the caller leaves the link out (and says so in the log, once).
 */
const parseBase = (raw: string | undefined): string | null => {
	const v = String(raw ?? '').trim();
	if (!v) return null;
	try {
		const u = new URL(v);
		if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null;
		return u.origin;
	} catch {
		return null;
	}
};

let warned = false;
const warnOnce = () => {
	if (warned) return;
	warned = true;
	logger.warn('[SiteUrl] FRONTEND_URL is missing or not an absolute http(s) address: links in e-mails are left out until it is configured.');
};
/** Test hook: lets a test observe the one-time warning again. */
export const resetSiteUrlWarning = () => { warned = false; };

/** The public site's origin (`https://dev.waseetai.com`), or null when FRONTEND_URL is not a valid absolute address. */
export const siteBaseUrl = (): string | null => {
	const base = parseBase(process.env.FRONTEND_URL);
	if (!base) warnOnce();
	return base;
};

/** Where an e-mail IMAGE lives: EMAIL_ASSET_BASE_URL when set (moving a logo never moves a user link), else the site. */
export const emailAssetBaseUrl = (): string | null => parseBase(process.env.EMAIL_ASSET_BASE_URL) ?? siteBaseUrl();

/**
 * `path` is an app route (`/provider-overview/...`, query allowed). Returns an absolute https/http URL on the site, or null when
 * the site address is not configured or `path` is not a plain app path (absolute URLs, `//host`, other schemes and control characters are refused:
 * a notification can never turn into a link to somewhere else).
 */
export const siteUrl = (path: string | null | undefined): string | null => {
	const p = String(path ?? '').trim();
	if (!p || /[\s\u0000-\u001f]/.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//') || p.includes('\\')) return null;
	const base = siteBaseUrl();
	if (!base) return null;
	return `${base}${p.startsWith('/') ? '' : '/'}${p}`;
};

/**
 * An absolute URL on the PUBLIC API of this environment (`<site origin>/api<path>`; the API is served under /api of the site host). Never localhost unless FRONTEND_URL itself says so,
 * never a double slash; null when the site address is not configured (the caller falls back to its default).
 */
export const apiPublicUrl = (path: string): string | null => {
	const base = siteBaseUrl();
	if (!base || /[\s\u0000-\u001f\\]/.test(path)) return null;
	return `${base}/api/${String(path).replace(/^\/+/, '')}`;
};

let warnedAssetHost = false;
/** Test hook: lets a test observe the one-time "asset host cannot serve /api" warning again. */
export const resetEmailAssetHostWarning = () => { warnedAssetHost = false; };
/**
 * An absolute URL for a PUBLIC API asset (`/public/...`) that a MAIL recipient's client will fetch with no cookie and no Authorization header: `<emailAssetBaseUrl()>/api<path>`.
 * EMAIL_ASSET_BASE_URL is honoured (moving images never moves a user link), BUT only when that host can really serve the API: it is the site's own origin, or EMAIL_ASSET_SERVES_API=true says the
 * asset host proxies `/api/public/**` (a CDN that only mirrors the static `/images/*` files cannot). Otherwise null = the caller keeps its built-in default image (and one warning is logged).
 */
export const emailPublicApiUrl = (path: string): string | null => {
	const base = emailAssetBaseUrl();
	if (!base || /[\s\u0000-\u001f\\]/.test(path)) return null;
	const site = parseBase(process.env.FRONTEND_URL);
	const serves = base === site || /^(?:1|true|yes)$/i.test(String(process.env.EMAIL_ASSET_SERVES_API ?? '').trim());
	if (!serves) {
		if (!warnedAssetHost) { warnedAssetHost = true; logger.warn('[SiteUrl] EMAIL_ASSET_BASE_URL is a different host than the site and EMAIL_ASSET_SERVES_API is not set: the custom e-mail logo is not used (the built-in default image stays).'); }
		return null;
	}
	return `${base}/api/${String(path).replace(/^\/+/, '')}`;
};
