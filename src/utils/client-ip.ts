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
