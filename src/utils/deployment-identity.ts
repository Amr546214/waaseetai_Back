import { siteBaseUrl } from './site-url';

/**
 * Which deployment this process is. Decided ONLY from server configuration, never from the request (Host / Origin / X-Forwarded-* are caller-controlled) and never from NODE_ENV alone
 * (dev runs with NODE_ENV=production too). A deployment is the OFFICIAL site only when BOTH hold:
 *   1. PLATFORM_DEPLOY_ENV=official  (set by whoever deploys the official container; absent everywhere else, so every other environment fails CLOSED), and
 *   2. the host of FRONTEND_URL is one of the official hosts (OFFICIAL_HOSTS, default: waseetai.com, www.waseetai.com).
 * Two independent settings must agree, so copying one environment file to another environment cannot switch the operations panel on by accident.
 */
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
