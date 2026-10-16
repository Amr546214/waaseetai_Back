// Handshake limiter for Socket.IO, per verified account. A reconnect loop (a client bug, a flapping network, a script) used to be free:
// every attempt ran a JWT verify and two database reads. The app opens ~5 sockets per browser tab (chat, notifications, anti-cheat, help
// assistant, project stream), so a normal reload burst is ~5 and ten tabs ~50; the cap below is far above that and far below a loop.
// In memory and per process, like the other socket limiter (socket-ai-rate-limit.ts); an anonymous socket carries no identity and the
// proxy address is not visible on a websocket handshake, so only authenticated handshakes are counted.
export const SOCKET_CONNECT_WINDOW_MS = Number(process.env.RL_SOCKET_CONNECT_WINDOW_MS) > 0 ? Number(process.env.RL_SOCKET_CONNECT_WINDOW_MS) : 5 * 60 * 1000;
export const SOCKET_CONNECT_MAX = Number(process.env.RL_SOCKET_CONNECT_MAX) > 0 ? Number(process.env.RL_SOCKET_CONNECT_MAX) : 120;
export const SOCKET_CONNECT_RATE_LIMIT_MESSAGE = 'محاولات اتصال كثيرة، سيعاد الاتصال تلقائيًا بعد قليل';
export const SOCKET_CONNECT_RATE_LIMIT_CODE = 'RATE_LIMITED';

const log = new Map<string, number[]>();

/** Returns true when `userId` already made SOCKET_CONNECT_MAX handshakes in the window; otherwise records this one. */
export function isSocketConnectLimited(userId: string, now = Date.now()): boolean {
  if (process.env.RATE_LIMIT_ENABLED === 'false') return false; // the same local/QA switch as the HTTP limiters
  const recent = (log.get(userId) || []).filter((t) => now - t < SOCKET_CONNECT_WINDOW_MS);
  if (recent.length >= SOCKET_CONNECT_MAX) { log.set(userId, recent); return true; }
  recent.push(now);
  log.set(userId, recent);
  if (log.size > 5000) for (const [k, v] of log) if (!v.some((t) => now - t < SOCKET_CONNECT_WINDOW_MS)) log.delete(k);
  return false;
}

export function resetSocketConnectLimiter(): void { log.clear(); }
