import { logger } from '../config/logger';
import { isWiredKey } from '../config/site-identity.registry';
import { apiPublicUrl } from '../utils/site-url';

/**
 * A small SYNCHRONOUS in-process view of the identity for code that cannot await (the e-mail shell is a synchronous renderer): today only `logo.email`.
 *  - loads at startup WITHOUT blocking (a failure leaves the built-in default);
 *  - is refreshed by the identity service right after every publish / restore / restore-set / automatic revert committed in THIS process, and by a short TTL (30 s, never more than 60 s)
 *    so other instances catch up; a read that finds the value older than the TTL answers with what it has and refreshes in the background;
 *  - a later refresh failure keeps the last good value (the database being down must not change the logo of outgoing mail);
 *  - the answer is an ABSOLUTE URL `<site origin>/api/public/site-identity/assets/logo.email/<sha256>`, or null = "use the built-in default" (also when the key is not wired, or no site address is configured).
 * Mails already sent keep the URL they were produced with: the bytes of superseded versions stay served by the public route.
 */
export const EMAIL_LOGO_KEY = 'logo.email';
export const CACHE_TTL_MS = 30_000;

let started = false; let sha: string | null = null; let loadedAt = 0; let inflight: Promise<void> | null = null; let isWired: (key: string) => boolean = (k) => isWiredKey(k);
/** the database read is registered by site-identity.service.ts (keeps this module free of any database import, so rendering a mail in a unit test never loads one); without a loader the answer is the default */
let loader: () => Promise<string | null> = async () => null;
export const registerSiteIdentityCacheLoader = (fn: () => Promise<string | null>) => { loader = fn; };

/** reload now (awaitable). Never throws. */
export function refreshSiteIdentityCache(): Promise<void> {
	if (inflight) return inflight;
	inflight = (async () => {
		try { sha = await loader(); loadedAt = Date.now(); } catch (e) {
			// keep the last good value (null before the first load = the default); retry after the TTL
			loadedAt = Date.now(); logger.warn(`[SiteIdentityCache] refresh failed, keeping the last value: ${(e as Error)?.message ?? e}`);
		} finally { inflight = null; }
	})();
	return inflight;
}

/** non-blocking warm-up at startup */
/** (only a started cache - the running server - refreshes itself by TTL; a unit test that merely renders a mail never opens a database connection) */
export function startSiteIdentityCache(): void { started = true; void refreshSiteIdentityCache(); }

/** the absolute public URL of the replaced e-mail logo, or null = the built-in default */
export function getEmailLogoUrl(): string | null {
	if (started && (loadedAt === 0 || Date.now() - loadedAt > CACHE_TTL_MS) && !inflight) void refreshSiteIdentityCache();
	if (!sha || !isWired(EMAIL_LOGO_KEY)) return null;
	return apiPublicUrl(`/public/site-identity/assets/${EMAIL_LOGO_KEY}/${sha}`);
}

/** test seams (never used by the app) */
export const siteIdentityCacheTestKit = {
	set(value: string | null, at = Date.now()) { sha = value; loadedAt = at; },
	reset() { started = false; sha = null; loadedAt = 0; inflight = null; isWired = (k) => isWiredKey(k); },
	setLoader(fn: () => Promise<string | null>) { loader = fn; },
	setStarted(v: boolean) { started = v; },
	setWired(fn: (key: string) => boolean) { isWired = fn; },
	peek: () => ({ sha, loadedAt, loading: !!inflight }),
};
