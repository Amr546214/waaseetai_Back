import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Safe Exam Browser (SEB) verification for the restricted exam mode.
 *
 * What is checked (the official SEB mechanism): SEB adds to EVERY request a hash header computed by the browser itself from the full request URL and a secret key that only a
 * genuine SEB running the exam's settings has:
 *   X-SafeExam-RequestHash    = SHA-256( absolute URL + Browser Exam Key )     (BEK: depends on the SEB build and the settings)
 *   X-SafeExam-ConfigKeyHash  = SHA-256( absolute URL + Config Key )           (Config Key: depends on the settings only)
 * The server holds the expected keys (EXAM_SEB_BROWSER_EXAM_KEYS / EXAM_SEB_CONFIG_KEYS, copied from the SEB Config Tool) and recomputes the hash for the URL it was asked for.
 * The User-Agent and any value a page sends (e.g. the SEB JavaScript API) are NOT trusted: a page script can send anything. Only a matching header hash counts.
 *
 * Limits, stated plainly: a matching hash proves the request came from a SEB configured with the exam's settings; it does not prove the exam room is safe (a second camera, a
 * second device, a remote-control tool outside SEB's checks are outside what any website or SEB can fully prevent). Supported platforms are those SEB supports (Windows, macOS, iOS/iPadOS).
 */
export type ExamEnvMode = 'off' | 'required';

export const examEnvMode = (env: NodeJS.ProcessEnv = process.env): ExamEnvMode => (String(env.EXAM_SEB_MODE ?? '').trim().toLowerCase() === 'required' ? 'required' : 'off');
const hexKeys = (v: unknown) => String(v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(k => /^[0-9a-f]{64}$/.test(k));
export const sebKeys = (env: NodeJS.ProcessEnv = process.env) => ({ browserExam: hexKeys(env.EXAM_SEB_BROWSER_EXAM_KEYS), config: hexKeys(env.EXAM_SEB_CONFIG_KEYS) });

/** The public origin the browser sees (the hash covers the exact URL the browser requested): EXAM_PUBLIC_ORIGIN, else the origin of FRONTEND_URL. */
export function examPublicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
	for (const raw of [env.EXAM_PUBLIC_ORIGIN, env.FRONTEND_URL]) {
		try { const u = new URL(String(raw ?? '')); if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin; } catch { /* next */ }
	}
	return null;
}

export interface ExamEnvStatus { mode: ExamEnvMode; /** required AND keys AND an origin are configured: only then can a restricted exam start */ ready: boolean; missing: string[] }
export function examEnvStatus(env: NodeJS.ProcessEnv = process.env): ExamEnvStatus {
	const mode = examEnvMode(env);
	if (mode === 'off') return { mode, ready: false, missing: [] };
	const k = sebKeys(env); const missing: string[] = [];
	if (k.browserExam.length + k.config.length === 0) missing.push('EXAM_SEB_BROWSER_EXAM_KEYS or EXAM_SEB_CONFIG_KEYS (64-hex keys from the SEB Config Tool)');
	if (!examPublicOrigin(env)) missing.push('EXAM_PUBLIC_ORIGIN (or FRONTEND_URL)');
	return { mode, ready: missing.length === 0, missing };
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const equalHex = (a: string, b: string) => a.length === b.length && /^[0-9a-f]+$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const header = (req: IncomingMessage, name: string): string => { const v = req.headers[name]; return String(Array.isArray(v) ? v[0] : v ?? '').trim().toLowerCase(); };

/** The absolute URLs the browser may have requested for this request: the proxy may or may not strip the /api prefix before it reaches us. */
export function candidateUrls(req: Pick<IncomingMessage, 'url'> & { originalUrl?: string }, origin: string): string[] {
	const path = String(req.originalUrl ?? req.url ?? '').split('#')[0];
	if (!path.startsWith('/')) return [];
	return [...new Set([origin + path, ...(path.startsWith('/api/') ? [] : [origin + '/api' + path])])];
}

export type SebVerdict = { verified: true; via: 'browser-exam-key' | 'config-key' } | { verified: false; via: null };
export function verifySebRequest(req: IncomingMessage & { originalUrl?: string }, env: NodeJS.ProcessEnv = process.env): SebVerdict {
	const origin = examPublicOrigin(env); const k = sebKeys(env);
	if (!origin) return { verified: false, via: null };
	const urls = candidateUrls(req, origin);
	const bek = header(req, 'x-safeexam-requesthash'), cfg = header(req, 'x-safeexam-configkeyhash');
	if (bek) for (const url of urls) for (const key of k.browserExam) if (equalHex(bek, sha256Hex(url + key))) return { verified: true, via: 'browser-exam-key' };
	if (cfg) for (const url of urls) for (const key of k.config) if (equalHex(cfg, sha256Hex(url + key))) return { verified: true, via: 'config-key' };
	return { verified: false, via: null };
}

/** SEB settings for a restricted exam (an unencrypted .seb property list, no secret inside). A TEMPLATE: the exam owner loads it in the SEB Config Tool, checks it, saves it, and copies the resulting keys into the server settings. */
export function buildSebConfig(origin: string): string {
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const host = new URL(origin).host;
	const bool = (k: string, v: boolean) => `\t<key>${k}</key>\n\t<${v}/>`;
	const str = (k: string, v: string) => `\t<key>${k}</key>\n\t<string>${esc(v)}</string>`;
	const int = (k: string, v: number) => `\t<key>${k}</key>\n\t<integer>${v}</integer>`;
	const rules = [host, 'accounts.google.com'].map(h => `\t\t<dict>\n\t\t\t<key>action</key>\n\t\t\t<integer>1</integer>\n\t\t\t<key>active</key>\n\t\t\t<true/>\n\t\t\t<key>expression</key>\n\t\t\t<string>${esc(h)}</string>\n\t\t\t<key>regex</key>\n\t\t\t<false/>\n\t\t</dict>`).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${[
		int('sebConfigPurpose', 0),
		str('startURL', `${origin}/provider-overview/profile/specialties`),
		str('quitURL', `${origin}/seb-quit`),
		bool('sendBrowserExamKey', true),
		bool('allowQuit', true),
		bool('URLFilterEnable', true),
		bool('URLFilterEnableContentFilter', false),
		bool('allowVirtualMachine', false),
		bool('allowScreenSharing', false),
		bool('enablePrintScreen', false),
		bool('enableAltTab', false),
		bool('enableAltEsc', false),
		bool('enableCtrlEsc', false),
		bool('enableRightMouse', false),
		bool('enableStartMenu', false),
		bool('allowSwitchToApplications', false),
		bool('allowDictation', false),
		bool('allowSpellCheck', false),
		bool('showTaskBar', false),
		bool('browserWindowAllowReload', true),
		bool('allowBrowsingBackForward', false),
		bool('allowDeveloperConsole', false)
	].join('\n')}
\t<key>urlFilterRules</key>
\t<array>
${rules}
\t</array>
</dict>
</plist>
`;
}
