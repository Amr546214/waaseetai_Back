import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

/**
 * Safe Exam Browser (SEB) verification for the restricted exam mode (spec: safeexambrowser.org/developer/seb-config-key.html).
 *
 * What is checked: SEB's classic engine adds to HTTP requests a hash header it computes itself from the absolute request URL (fragment removed) and a secret key a genuine SEB running the
 * exam's settings has: SHA-256( URL + key ), Base16.
 *   X-SafeExamBrowser-ConfigKeyHash  = SHA-256( URL + Config Key )            [header name verified in the official page]
 *   X-SafeExamBrowser-RequestHash    = SHA-256( URL + Browser Exam Key )      [BEK header name/formula: the official PDF could not be read in review; the same formula is assumed and the
 *                                                                              older X-SafeExam-* spellings are accepted as aliases. VERIFY in a real SEB before relying on the BEK]
 * The server holds the expected keys (EXAM_SEB_CONFIG_KEYS / EXAM_SEB_BROWSER_EXAM_KEYS, copied from the SEB Config Tool) and recomputes the hash for the URL it was asked for.
 * The User-Agent and any value a page sends are NOT trusted: only a matching hash counts.
 *
 * Platform reality (official docs): SEB's modern WebKit engine on macOS/iOS does NOT send the keys in HTTP headers (it exposes them to page JavaScript instead, hashed per PAGE url, not per
 * request: weaker and replayable). The settings template therefore turns the content filter on, which the docs say forces the classic engine that does send headers. That is unproven here.
 *
 * Limits: a matching hash proves the request came from a SEB running the exam's settings; it does not prove the room is safe. Supported systems are those SEB supports.
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

export interface ExamEnvStatus {
	mode: ExamEnvMode;
	/** required AND keys AND an origin AND the approved settings file are all in place: only then can a restricted exam start */
	ready: boolean;
	missing: string[];
	/** the operator declared that the integration was tried in a real SEB (EXAM_SEB_TESTED_IN_REAL_SEB); keys being present does NOT mean this */
	testedInRealSeb: boolean;
	testedNote: string | null;
}
const sha256Buf = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * The settings file users download MUST be the very file the keys on the server were derived from (saved in the SEB Config Tool, which also shows its Config Key and Browser Exam Key):
 * the server serves exactly those bytes and refuses to when their SHA-256 differs from EXAM_SEB_CONFIG_FILE_SHA256 (the digest recorded when the keys were taken). It never builds the file itself.
 */
export function approvedSebConfig(env: NodeJS.ProcessEnv = process.env): { ok: true; bytes: Buffer; sha256: string } | { ok: false; reason: 'NOT_SET' | 'UNREADABLE' | 'DIGEST_NOT_SET' | 'DIGEST_MISMATCH' } {
	const path = String(env.EXAM_SEB_CONFIG_FILE ?? '').trim(); const want = String(env.EXAM_SEB_CONFIG_FILE_SHA256 ?? '').trim().toLowerCase();
	if (!path) return { ok: false, reason: 'NOT_SET' };
	if (!/^[0-9a-f]{64}$/.test(want)) return { ok: false, reason: 'DIGEST_NOT_SET' };
	let bytes: Buffer; try { bytes = readFileSync(path); } catch { return { ok: false, reason: 'UNREADABLE' }; }
	if (bytes.length === 0 || bytes.length > 2_000_000) return { ok: false, reason: 'UNREADABLE' };
	const got = sha256Buf(bytes);
	return got === want ? { ok: true, bytes, sha256: got } : { ok: false, reason: 'DIGEST_MISMATCH' };
}

export function examEnvStatus(env: NodeJS.ProcessEnv = process.env): ExamEnvStatus {
	const mode = examEnvMode(env);
	const note = String(env.EXAM_SEB_TESTED_IN_REAL_SEB ?? '').trim();
	const tested = { testedInRealSeb: note.length > 0, testedNote: note || null };
	if (mode === 'off') return { mode, ready: false, missing: [], ...tested };
	const k = sebKeys(env); const missing: string[] = [];
	if (k.browserExam.length + k.config.length === 0) missing.push('EXAM_SEB_BROWSER_EXAM_KEYS or EXAM_SEB_CONFIG_KEYS (64-hex keys from the SEB Config Tool)');
	if (!examPublicOrigin(env)) missing.push('EXAM_PUBLIC_ORIGIN (or FRONTEND_URL)');
	const f = approvedSebConfig(env);
	if (!f.ok) missing.push(f.reason === 'NOT_SET' ? 'EXAM_SEB_CONFIG_FILE (the .seb saved in the SEB Config Tool, the file the keys came from)' : f.reason === 'DIGEST_NOT_SET' ? 'EXAM_SEB_CONFIG_FILE_SHA256 (SHA-256 of that file)' : f.reason === 'UNREADABLE' ? 'EXAM_SEB_CONFIG_FILE is not readable' : 'EXAM_SEB_CONFIG_FILE does not match EXAM_SEB_CONFIG_FILE_SHA256 (not the approved file)');
	return { mode, ready: missing.length === 0, missing, ...tested };
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
	const bek = header(req, 'x-safeexambrowser-requesthash') || header(req, 'x-safeexam-requesthash');
	const cfg = header(req, 'x-safeexambrowser-configkeyhash') || header(req, 'x-safeexam-configkeyhash');
	if (bek) for (const url of urls) for (const key of k.browserExam) if (equalHex(bek, sha256Hex(url + key))) return { verified: true, via: 'browser-exam-key' };
	if (cfg) for (const url of urls) for (const key of k.config) if (equalHex(cfg, sha256Hex(url + key))) return { verified: true, via: 'config-key' };
	return { verified: false, via: null };
}

/**
 * STARTING POINT for the exam owner, NOT the file users download: an unencrypted SEB settings property list built from keys named in the official manuals. The owner opens it in the SEB Config Tool
 * (per OS), reviews every setting there, saves the file, and takes the Config Key / Browser Exam Key the tool shows; THAT saved file and THOSE keys are what the server uses (see approvedSebConfig).
 * Verification level per key is in SEB_TEMPLATE_KEY_NOTES. Used by scripts/exam/generate-seb-template.ts only: the API never builds or serves this.
 */
export const SEB_TEMPLATE_KEY_NOTES: Record<string, string> = {
	startURL: 'official (all OS)', quitURL: 'official: loading it quits SEB, quit password ignored (Win/Mac/iOS)', sendBrowserExamKey: 'official: "Use Browser & Config Keys (send in HTTP header)"',
	allowQuit: 'official (Win/Mac); a user can still quit with Ctrl/Cmd-Q or the close button unless a quit password is set', URLFilterEnable: 'official', URLFilterEnableContentFilter: 'official: true forces the classic engine on macOS/iOS (the one that sends the key headers)',
	URLFilterRules: 'official: array of {action(1 = allow in the official example), active, expression (host/path, no scheme, * wildcard), regex}', allowVirtualMachine: 'official (Win/Mac)', allowScreenSharing: 'official (Win/Mac)',
	enablePrintScreen: 'official (Windows: Hooked Keys); macOS screenshots use the keys below', enableAltTab: 'official (Windows)', enableStartMenu: 'official (Windows)', enableRightMouse: 'official (Windows)',
	allowSwitchToApplications: 'official (Mac)', allowDictation: 'official (Mac)', allowSpellCheck: 'official (Mac/Win)', showTaskBar: 'official (Win taskbar / Mac dock)', showMenuBar: 'official (Mac)',
	browserWindowAllowReload: 'official (Win): reload stays allowed so the test can resume', allowBrowsingBackForward: 'official (Win)', allowedDisplaysMaxNumber: 'official (Win/Mac)',
	allowScreenCapture: 'official (Mac)', allowWindowCapture: 'official (Mac)', blockScreenShotsLegacy: 'official (Mac)', screenSharingMacEnforceBlocked: 'official (Mac)', allowVideoCapture: 'listed for Windows in the manual summary: confirm the name in the Config Tool',
	enableAppSwitcherCheck: 'Mac manual summary', detectStoppedProcess: 'Mac manual summary', sebConfigPurpose: 'UNVERIFIED value mapping (0 = starting an exam is assumed)'
};
export function buildSebTemplate(origin: string): string {
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const host = new URL(origin).host;
	const bool = (k: string, v: boolean) => `\t<key>${k}</key>\n\t<${v}/>`;
	const str = (k: string, v: string) => `\t<key>${k}</key>\n\t<string>${esc(v)}</string>`;
	const int = (k: string, v: number) => `\t<key>${k}</key>\n\t<integer>${v}</integer>`;
	const rule = (expression: string) => `\t\t<dict>\n\t\t\t<key>action</key>\n\t\t\t<integer>1</integer>\n\t\t\t<key>active</key>\n\t\t\t<true/>\n\t\t\t<key>expression</key>\n\t\t\t<string>${esc(expression)}</string>\n\t\t\t<key>regex</key>\n\t\t\t<false/>\n\t\t</dict>`;
	const rules = [host, `${host}/*`, 'accounts.google.com', 'accounts.google.com/*'].map(rule).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${[
		int('sebConfigPurpose', 0), str('startURL', `${origin}/provider-overview/profile/specialties`), str('quitURL', `${origin}/seb-quit`),
		bool('sendBrowserExamKey', true), bool('allowQuit', true), bool('URLFilterEnable', true), bool('URLFilterEnableContentFilter', true),
		bool('allowVirtualMachine', false), bool('allowScreenSharing', false), bool('enablePrintScreen', false), bool('enableAltTab', false), bool('enableStartMenu', false), bool('enableRightMouse', false),
		bool('allowSwitchToApplications', false), bool('allowDictation', false), bool('allowSpellCheck', false), bool('showTaskBar', false), bool('showMenuBar', false),
		bool('browserWindowAllowReload', true), bool('allowBrowsingBackForward', false), int('allowedDisplaysMaxNumber', 1),
		bool('allowScreenCapture', false), bool('allowWindowCapture', false), bool('blockScreenShotsLegacy', true), bool('screenSharingMacEnforceBlocked', true), bool('allowVideoCapture', false),
		bool('enableAppSwitcherCheck', true), bool('detectStoppedProcess', true)
	].join('\n')}
\t<key>URLFilterRules</key>
\t<array>
${rules}
\t</array>
</dict>
</plist>
`;
}
