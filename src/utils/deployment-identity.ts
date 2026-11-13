import { siteBaseUrl } from './site-url';

/** Diagnostic deployment classification from server configuration, never from request headers.
 * Operations access is authorized by the active Super Admin account on both dev and the official site.
 * This metadata must not be used to enable a dev container as an official deployment. */
export const DEFAULT_OFFICIAL_HOSTS = ['waseetai.com', 'www.waseetai.com'] as const;
export const officialHosts = (env: NodeJS.ProcessEnv = process.env): string[] => {
	const raw = (env.OFFICIAL_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
	return raw.length ? raw : [...DEFAULT_OFFICIAL_HOSTS];
};
export function isOfficialDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
	if ((env.PLATFORM_DEPLOY_ENV || '').trim().toLowerCase() !== 'official') return false;
	const base = env === process.env ? siteBaseUrl() : (() => { try { return new URL(env.FRONTEND_URL || '').origin; } catch { return null; } })();
	if (!base) return false;
	try { return officialHosts(env).includes(new URL(base).hostname.toLowerCase()); } catch { return false; }
}
