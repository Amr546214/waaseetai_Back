import type { IncomingMessage } from 'node:http';
import { resolveTrustProxy } from '../config/trust-proxy';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyaddr = require('proxy-addr') as { (req: IncomingMessage, trust: (addr: string, i: number) => boolean): string; compile: (v: unknown) => (addr: string, i: number) => boolean };

/**
 * The trusted client address of a raw request (Socket.IO handshake): the SAME rule Express applies to HTTP (`TRUST_PROXY`, default 'uniquelocal'), so X-Forwarded-For is believed only
 * behind proxies we trust and a forged header from a public address is ignored. IPv4-mapped IPv6 is normalised.
 */
export function trustedClientIp(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string {
	let ip = '';
	try { ip = proxyaddr(req, proxyaddr.compile(resolveTrustProxy(env.TRUST_PROXY))); } catch { ip = req.socket?.remoteAddress ?? ''; }
	return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

/**
 * True when the TCP peer that handed us this request is itself a trusted proxy hop (TRUST_PROXY). Edge-provided data (CDN geolocation headers) may only be believed in that case:
 * a request that reaches the origin directly from a public address carries headers its sender chose.
 */
export function cameThroughTrustedProxy(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
	const peer = req.socket?.remoteAddress ?? '';
	if (!peer) return false;
	try { return proxyaddr.compile(resolveTrustProxy(env.TRUST_PROXY))(peer, 0); } catch { return false; }
}
