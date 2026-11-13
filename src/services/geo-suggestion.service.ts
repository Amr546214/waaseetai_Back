import net from 'node:net';
import { logger } from '../config/logger';

/**
 * Approximate country / city SUGGESTION for the first registration. It is a hint, never a fact: an IP location is not a legal address, the user can change it, and nothing here
 * writes to a profile (the client only fills EMPTY fields). The address is the trusted client address (HTTP: req.ip behind the configured trust-proxy boundary; Socket.IO: trustedClientIp).
 * Sources, in order:
 *   1. CDN geolocation headers - ONLY when GEOIP_TRUST_CDN_HEADERS=cloudflare is set (the origin must then be reachable only through that CDN, otherwise a caller could forge them);
 *   2. the GeoIP provider configured by GEOIP_PROVIDER=ipinfo + GEOIP_TOKEN (the visitor's address is sent to that provider: tell the privacy policy owners before enabling).
 * Neither configured, a private/loopback address, a timeout or any failure => `source: 'none'` and the manual fields keep working. No guessing from language or time zone.
 */
export interface GeoSuggestion { countryCode: string | null; city: string | null; timezone: string | null; source: 'cdn-header' | 'geoip-provider' | 'none'; approximate: true }
const NONE: GeoSuggestion = { countryCode: null, city: null, timezone: null, source: 'none', approximate: true };
const CACHE_MS = 60 * 60_000, CACHE_MAX = 5000, TIMEOUT_MS = 1500;
const cache = new Map<string, { at: number; v: GeoSuggestion }>();
export const clearGeoCache = () => cache.clear();

export const isPublicIp = (ip: string): boolean => {
	if (!net.isIP(ip)) return false;
	if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return !(a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224); }
	const l = ip.toLowerCase(); return !(l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80'));
};
const cc = (v: unknown) => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) && v.trim().toUpperCase() !== 'XX' && v.trim().toUpperCase() !== 'T1' ? v.trim().toUpperCase() : null);
const txt = (v: unknown, max = 80) => (typeof v === 'string' && v.trim() && v.length <= 200 ? v.trim().slice(0, max) : null);
const tz = (v: unknown) => { const s = txt(v, 64); if (!s) return null; try { new Intl.DateTimeFormat('en', { timeZone: s }); return s; } catch { return null; } };

export async function geoSuggestion(ip: string, headers: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<GeoSuggestion> {
	if (!isPublicIp(ip)) return NONE;
	if ((env.GEOIP_TRUST_CDN_HEADERS || '').toLowerCase() === 'cloudflare') {
		const country = cc(headers['cf-ipcountry']); if (country) return { countryCode: country, city: txt(headers['cf-ipcity']), timezone: tz(headers['cf-timezone']), source: 'cdn-header', approximate: true };
	}
	if ((env.GEOIP_PROVIDER || '').toLowerCase() !== 'ipinfo' || !env.GEOIP_TOKEN) return NONE;
	const hit = cache.get(ip); if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
	const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
	try {
		const r = await fetchImpl(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, { headers: { Authorization: `Bearer ${env.GEOIP_TOKEN}`, Accept: 'application/json' }, signal: ctl.signal });
		if (!r.ok) throw new Error(`provider ${r.status}`);
		const j = await r.json() as Record<string, unknown>; const country = cc(j.country);
		const v: GeoSuggestion = country ? { countryCode: country, city: txt(j.city), timezone: tz(j.timezone), source: 'geoip-provider', approximate: true } : NONE;
		if (cache.size >= CACHE_MAX) cache.clear(); cache.set(ip, { at: Date.now(), v }); return v;
	} catch (e) { logger.warn(`[Geo] lookup failed (manual entry still works): ${(e as Error).message}`); return NONE; }
	finally { clearTimeout(timer); }
}
