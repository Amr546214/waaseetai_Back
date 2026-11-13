import type { IncomingMessage } from 'node:http';
import { resolveTrustProxy, DEFAULT_TRUST_PROXY } from '../config/trust-proxy';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyaddr = require('proxy-addr') as { (req: IncomingMessage, trust: (addr: string, i: number) => boolean): string; compile: (v: unknown) => (addr: string, i: number) => boolean };

/**
 * The trust function Express builds from the `trust proxy` setting, for use with proxy-addr. proxy-addr itself only understands address lists / presets: a hop COUNT (TRUST_PROXY=1, 2) or
 * `false` makes `proxyaddr.compile` throw, which is why HTTP (Express) and Socket.IO used to disagree. Same semantics as Express: `false` trusts nobody, N trusts the first N hops from the
 * socket, a preset / address / CIDR list trusts exactly those proxies.
 */
export function trustFunction(setting: boolean | number | string | string[]): (addr: string, i: number) => boolean {
	if (setting === false) return () => false;
	if (typeof setting === 'number') return (_addr, i) => i < setting;
	if (setting === true) return proxyaddr.compile(DEFAULT_TRUST_PROXY as string);
	return proxyaddr.compile(setting);
}

/**
 * The trusted client address of a raw request (Socket.IO handshake or HTTP): the SAME rule Express applies to `req.ip` (`TRUST_PROXY`, default 'uniquelocal'), so X-Forwarded-For is believed only
 * behind proxies we trust and a forged header from a public address is ignored. IPv4-mapped IPv6 is normalised.
 */
export function trustedClientIp(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string {
	let ip = '';
	try { ip = proxyaddr(req, trustFunction(resolveTrustProxy(env.TRUST_PROXY))); } catch { ip = req.socket?.remoteAddress ?? ''; }
	return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

/**
 * True when the TCP peer that handed us this request is itself a trusted proxy hop (TRUST_PROXY). Edge-provided data (CDN geolocation headers) may only be believed in that case:
 * a request that reaches the origin directly from a public address carries headers its sender chose.
 */
export function cameThroughTrustedProxy(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
	const peer = req.socket?.remoteAddress ?? '';
	if (!peer) return false;
	try { return trustFunction(resolveTrustProxy(env.TRUST_PROXY))(peer, 0); } catch { return false; }
}

/** What the trust setting really is (the default counts as configured: an unset TRUST_PROXY means 'uniquelocal', not "no proxy trust"). */
export function trustProxyDescription(env: NodeJS.ProcessEnv = process.env): { effective: string; source: 'env' | 'default' } {
	const raw = (env.TRUST_PROXY ?? '').trim();
	const v = resolveTrustProxy(raw);
	return { effective: Array.isArray(v) ? v.join(',') : String(v), source: raw ? 'env' : 'default' };
}
