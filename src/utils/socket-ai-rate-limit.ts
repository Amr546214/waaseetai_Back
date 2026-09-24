// Minimal, self-contained per-user cooldown for AI-triggering Socket.IO
// events. `express-rate-limit` (this project's existing `aiLimiter`) only
// covers HTTP routes — sockets have no equivalent, so before this the
// AI-bound socket events (F1b, F2) had zero throttling at all: any
// authenticated user could emit them in a tight loop and burn provider
// quota indefinitely. This mirrors aiLimiter's own window/max exactly,
// just keyed by userId instead of IP, since that's the identity Socket.IO
// gateways in this codebase already have available.
//
// Deliberately in-memory and process-local — same operational scope as the
// rest of this project's rate limiting (no cross-instance store exists for
// the HTTP limiter either), and reset on restart, which is acceptable for
// an abuse-cooldown rather than a hard quota.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;

const requestLog = new Map<string, number[]>();

export const SOCKET_AI_RATE_LIMIT_MESSAGE = 'تم تجاوز الحد المسموح لطلبات الذكاء الاصطناعي، يرجى المحاولة لاحقاً';

/**
 * Returns true (and records nothing further) once `key` has made
 * MAX_REQUESTS_PER_WINDOW or more requests within the trailing WINDOW_MS;
 * otherwise records this request and returns false.
 */
export function isSocketAiRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (requestLog.get(key) || []).filter((timestamp) => now - timestamp < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    requestLog.set(key, recent);
    return true;
  }

  recent.push(now);
  requestLog.set(key, recent);
  return false;
}
