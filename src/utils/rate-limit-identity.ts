import jwt from 'jsonwebtoken';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { getAuthCookie } from './request-cookie';

/**
 * Who a request is, for rate limiting. Two identities, never mixed up:
 *  - `userId`: only from a token whose SIGNATURE and expiry verify with JWT_SECRET (the same token `authenticate` accepts). A forged,
 *    expired or malformed token — or a header like X-User-Id — yields no user, so nobody can fill (or dodge) another account's bucket.
 *    It does not touch the database: whether the session was revoked is `authenticate`'s job, not the limiter's.
 *  - `ip`: `req.ip` as Express derives it from the configured trust-proxy boundary (X-Forwarded-For is never read here directly),
 *    IPv6 collapsed to its /56 so one subscriber cannot rotate through a whole prefix.
 * The user key is the account id, not the token / session / active role: renewing the token or switching role keeps the same bucket.
 */
export interface RateLimitIdentity {
  userId: string | null;
  ip: string;
}

const TOKEN_CACHE_MAX = 5000;
const TOKEN_CACHE_TTL_MS = 30_000;
const tokenCache = new Map<string, { userId: string | null; until: number }>();

function readToken(req: Request): string | null {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim() || null;
  try { return getAuthCookie(req) || null; } catch { return null; }
}

export function verifiedUserId(req: Request): string | null {
  const token = readToken(req);
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return null;
  const now = Date.now();
  const hit = tokenCache.get(token);
  if (hit && hit.until > now) return hit.userId;
  let userId: string | null = null;
  let until = now + TOKEN_CACHE_TTL_MS;
  try {
    const decoded = jwt.verify(token, secret) as { userId?: unknown; exp?: number };
    if (typeof decoded.userId === 'string' && decoded.userId) userId = decoded.userId;
    if (decoded.exp) until = Math.min(until, decoded.exp * 1000);
  } catch { /* invalid / expired token: treated as anonymous */ }
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(token, { userId, until });
  return userId;
}

export function clientIpKey(req: Request): string {
  return ipKeyGenerator(req.ip || '0.0.0.0');
}

export function rateLimitIdentity(req: Request): RateLimitIdentity {
  return { userId: verifiedUserId(req), ip: clientIpKey(req) };
}

/** Bucket key: `u:<userId>` for a verified user, `ip:<address>` otherwise. */
export function identityKey(req: Request): string {
  const { userId, ip } = rateLimitIdentity(req);
  return userId ? `u:${userId}` : `ip:${ip}`;
}

/** test hook */
export function clearRateLimitIdentityCache(): void { tokenCache.clear(); }
