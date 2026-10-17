/** Local development helper only. No platform API proxy, database, or local auth bypass. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { assistantOptionsSchema, assistantGreetingResponse, isGreetingIntent, resolveAssistantMode } from '../src/services/ai/assistant-request';
import { streamAssistantAnswer } from '../src/services/ai/assistant-answer';
import { waseetAiClient, type WaseetAiClient, type WaseetAiCallOptions } from '../src/services/ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError, WaseetAiErrorCode } from '../src/services/ai/waseet-ai/waseet-ai.errors';
import { readSearchSuggestionsHtml } from '../src/services/ai/waseet-ai/waseet-ai.grounding';
import type { HelpChatRequest, HelpChatHistoryMessage } from '../src/services/ai/waseet-ai/waseet-ai.types';
import { scrubFreeText } from '../src/services/llm/llm.payload';

export const BRIDGE_ORIGINS = ['http://localhost:4200', 'http://localhost:4210'] as const;
export const DEFAULT_PLATFORM_API = 'https://dev.waseetai.com/api';
export const PLATFORM_IDENTITY_PATH = '/profiles/me'; // AuthStore's platform: authenticate + requireActiveUser, not /auth/me.
export type BridgeRole = 'client' | 'provider' | 'marketer' | 'admin';
export type VerifiedActor = { userId: string; role: BridgeRole };
export type BridgeClient = Pick<WaseetAiClient, 'streamHelpChat' | 'isConfigured'> & Partial<Pick<WaseetAiClient, 'avatarChat'>>;
export type BridgeFetch = (input: string, init: RequestInit) => Promise<Response>;
export type BridgeDiagnostic = (code: 'AUTH_PROFILE_SHAPE', fields: Record<string, boolean>) => void;
type FailureCode = 'AUTH_REQUIRED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT' | 'NOT_CONFIGURED';
const MESSAGES: Record<FailureCode, string> = {
  AUTH_REQUIRED: 'جلسة الدخول غير صالحة. يرجى تسجيل الدخول مجددًا.',
  FORBIDDEN: 'المساعد غير متاح لهذا الحساب حاليًا.',
  INVALID_INPUT: 'السؤال أو إعدادات المساعد غير صالحة. الحد الأقصى للسؤال 500 حرف.',
  RATE_LIMITED: 'وصلت للحد المؤقت للمساعد. انتظر قليلًا ثم حاول مجددًا.',
  UNAVAILABLE: 'تعذر الحصول على رد من المساعد حاليًا. حاول مرة أخرى.',
  TIMEOUT: 'انتهت مهلة انتظار المساعد. حاول مرة أخرى.',
  NOT_CONFIGURED: 'اتصال المساعد المحلي غير مُعدّ حاليًا.',
};
export class BridgeFailure extends Error {
  constructor(readonly code: FailureCode) { super(MESSAGES[code]); }
}
export function isBridgeOriginAllowed(origin: unknown): boolean {
  return typeof origin === 'string' && (BRIDGE_ORIGINS as readonly string[]).includes(origin);
}

function roleFromVerifiedProfile(value: Record<string, unknown>): BridgeRole | null {
  if (value.accountType === 'ADMIN' || value.accountType === 'SUPER_ADMIN') return 'admin';
  const active = { CLIENT: 'client', PROVIDER: 'provider', AFFILIATE: 'marketer', ADMIN: 'admin', SUPER_ADMIN: 'admin' } as const;
  if (typeof value.activeRole === 'string' && Object.hasOwn(active, value.activeRole)) return active[value.activeRole as keyof typeof active];
  const account = { CLIENT_INDIVIDUAL: 'client', CLIENT_COMPANY: 'client', PROVIDER_INDIVIDUAL: 'provider', PROVIDER_COMPANY: 'provider', MARKETING_BROKER: 'marketer' } as const;
  return typeof value.accountType === 'string' && Object.hasOwn(account, value.accountType) ? account[value.accountType as keyof typeof account] : null;
}

/** The REMOTE authenticate middleware verifies signature, expiry, account and live session. No JWT claims are trusted locally. */
export function createPlatformVerifier(options: { baseUrl?: string; fetchImpl?: BridgeFetch; timeoutMs?: number; diagnostic?: BridgeDiagnostic } = {}) {
  const base = new URL(options.baseUrl ?? DEFAULT_PLATFORM_API);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('INVALID_PLATFORM_API_BASE');
  const url = base.toString().replace(/\/+$/, '') + PLATFORM_IDENTITY_PATH;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return async (token: unknown, signal?: AbortSignal): Promise<VerifiedActor> => {
    // Syntax only; authenticity is checked by the real platform on every invocation.
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new BridgeFailure('AUTH_REQUIRED');
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 8000);
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', credentials: 'omit', signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new BridgeFailure(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
      }
      if (!response.body) throw new BridgeFailure('UNAVAILABLE');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '', bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 256 * 1024) { await reader.cancel(); throw new BridgeFailure('UNAVAILABLE'); }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      const payload = JSON.parse(text) as { success?: unknown; data?: Record<string, unknown> };
      const data = payload?.data;
      if (payload?.success !== true || !data || typeof data !== 'object' || Array.isArray(data)) {
        options.diagnostic?.('AUTH_PROFILE_SHAPE', { successFieldPresent: payload?.success !== undefined, profileObjectPresent: !!data && typeof data === 'object' && !Array.isArray(data) });
        throw new BridgeFailure('UNAVAILABLE');
      }
      // getProfile returns { currentProfileData, latestHistory }; older builds returned a flat profile.
      // A present malformed wrapper is rejected, never replaced with the enclosing object.
      const wrapped = Object.hasOwn(data, 'currentProfileData');
      const candidate = wrapped ? data.currentProfileData : data;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        options.diagnostic?.('AUTH_PROFILE_SHAPE', { wrappedProfileFieldPresent: wrapped, profileObjectPresent: false });
        throw new BridgeFailure('UNAVAILABLE');
      }
      const profile = candidate as Record<string, unknown>;
      if (typeof profile.status !== 'string' || typeof profile.isBanned !== 'boolean') {
        options.diagnostic?.('AUTH_PROFILE_SHAPE', { statusFieldPresent: typeof profile.status === 'string', bannedFlagPresent: typeof profile.isBanned === 'boolean',
          userIdFieldPresent: typeof profile.userId === 'string', idFieldPresent: typeof profile.id === 'string', activeRoleFieldPresent: typeof profile.activeRole === 'string', accountTypeFieldPresent: typeof profile.accountType === 'string' });
      }
      if (profile.status !== 'ACTIVE' || profile.isBanned !== false) throw new BridgeFailure('FORBIDDEN');
      // /profiles/me spreads the role profile, which may overwrite id; userId remains the identity FK.
      const userId = profile.userId ?? profile.id;
      const role = roleFromVerifiedProfile(profile);
      if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(userId) || !role) {
        options.diagnostic?.('AUTH_PROFILE_SHAPE', { userIdFieldPresent: typeof profile.userId === 'string', idFieldPresent: typeof profile.id === 'string', activeRoleFieldPresent: typeof profile.activeRole === 'string', accountTypeFieldPresent: typeof profile.accountType === 'string' });
        throw new BridgeFailure('FORBIDDEN');
      }
      return { userId, role };
    } catch (error) {
      if (error instanceof BridgeFailure) throw error;
      if (deadline.aborted && !signal?.aborted) throw new BridgeFailure('TIMEOUT');
      throw new BridgeFailure('UNAVAILABLE');
    }
  };
}

// Front historyTail sends whole completed answers (up to its 30k transcript bound).
// Validate that compatible input, then retain only a short tail for the model.
const historyMessage = z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(30_000) }).strip();
const historyTurn = z.object({ question: z.string().trim().min(1).max(1000), answer: z.string().trim().min(1).max(30_000) }).strip();
export const bridgeAskSchema = assistantOptionsSchema.extend({
  question: z.string().trim().min(1).max(500),
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  history: z.array(z.union([historyMessage, historyTurn])).max(6).optional(),
}).strip();
function historyForUpstream(history: z.infer<typeof bridgeAskSchema>['history']): HelpChatHistoryMessage[] {
  return (history ?? []).flatMap(item => 'role' in item ? [{ role: item.role, content: scrubFreeText(item.content.slice(0, 1000)) }]
    : [{ role: 'user' as const, content: scrubFreeText(item.question.slice(0, 1000)) }, { role: 'assistant' as const, content: scrubFreeText(item.answer.slice(0, 1000)) }]).slice(-6);
}

type RequestState = { id: string; controller: AbortController };
export function createBridgeGateway(options: {
  verify: ReturnType<typeof createPlatformVerifier>; client?: BridgeClient; now?: () => number;
  maxPerMinute?: number; maxInFlightPerUser?: number; maxInFlight?: number; streamTimeoutMs?: number;
}) {
  const client = options.client ?? waseetAiClient;
  const now = options.now ?? Date.now;
  const current = new Map<Socket, RequestState>();
  const busy = new Map<string, number>();
  const rates = new Map<string, { start: number; count: number }>();
  let authInFlight = 0, totalInFlight = 0;
  const verify = async (token: unknown, signal?: AbortSignal) => {
    if (authInFlight >= 16) throw new BridgeFailure('RATE_LIMITED');
    authInFlight++;
    try { return await options.verify(token, signal); } finally { authInFlight--; }
  };
  const limited = (userId: string) => {
    const time = now();
    // Opportunistic cleanup; bounded storage without a background polling loop.
    for (const [key, bucket] of rates) if (time - bucket.start >= 60_000) rates.delete(key);
    if (!rates.has(userId) && rates.size >= 256) return true;
    const bucket = rates.get(userId) ?? { start: time, count: 0 };
    rates.set(userId, bucket);
    return ++bucket.count > (options.maxPerMinute ?? 12);
  };
  const tokenOf = (socket: Socket) => socket.handshake.auth?.token;
  async function authenticate(socket: Socket): Promise<void> {
    socket.data.bridgeActor = await verify(tokenOf(socket));
  }
  function register(socket: Socket): void {
    socket.on('help:cancel', payload => {
      const state = current.get(socket);
      if (state && payload?.clientRequestId === state.id) state.controller.abort();
    });
    socket.on('disconnect', () => { current.get(socket)?.controller.abort(); current.delete(socket); });
    socket.on('help:ask', async (raw: unknown) => {
      const rawId = raw && typeof raw === 'object' ? (raw as { clientRequestId?: unknown }).clientRequestId : undefined;
      const id = typeof rawId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rawId) ? rawId : randomUUID();
      current.get(socket)?.controller.abort();
      const state = { id, controller: new AbortController() };
      current.set(socket, state);
      const alive = () => socket.connected && current.get(socket) === state && !state.controller.signal.aborted;
      const fail = (code: FailureCode) => { if (alive()) socket.emit('help:error', { clientRequestId: id, code, message: MESSAGES[code], humanSupportFallback: false }); };
      let reservedUser: string | undefined;
      let deadline: AbortSignal | undefined;
      try {
        const actor = await verify(tokenOf(socket), state.controller.signal);
        if (!alive()) return;
        const parsed = bridgeAskSchema.safeParse(raw);
        if (!parsed.success) throw new BridgeFailure('INVALID_INPUT');
        if (limited(actor.userId)) throw new BridgeFailure('RATE_LIMITED');
        if ((busy.get(actor.userId) ?? 0) >= (options.maxInFlightPerUser ?? 2) || totalInFlight >= (options.maxInFlight ?? 8)) throw new BridgeFailure('RATE_LIMITED');
        reservedUser = actor.userId;
        busy.set(actor.userId, (busy.get(actor.userId) ?? 0) + 1);
        totalInFlight++;
        const { question, history, clientRequestId: unusedId, pageContext: untrustedContext, ...settings } = parsed.data;
        // Page paths/records are deliberately omitted; this bridge has no owned-record resolver or local DB.
        const body: HelpChatRequest = { ...settings, language: settings.language?.startsWith('en') ? 'en' : settings.language === 'ar-EG' ? 'ar-EG' : settings.language ? 'ar' : undefined,
          mode: resolveAssistantMode(question, settings.mode), question: scrubFreeText(question), history: historyForUpstream(history) };
        let started = false;
        const start = () => { if (!started && alive()) { started = true; socket.emit('help:answer_start', { clientRequestId: id }); } };
        const bypassGreeting = process.env.DISABLE_GREETING_FILTER === 'true' || process.env.BYPASS_GREETING_FILTER === 'true';
        if (!bypassGreeting && isGreetingIntent(question)) {
          start(); socket.emit('help:answer_chunk', { clientRequestId: id, chunk: assistantGreetingResponse(body) });
          socket.emit('help:answer_complete', { clientRequestId: id }); return;
        }
        if (!client.isConfigured()) throw new BridgeFailure('NOT_CONFIGURED');
        deadline = AbortSignal.timeout(options.streamTimeoutMs ?? 60_000);
        const callOptions: WaseetAiCallOptions = { signal: AbortSignal.any([state.controller.signal, deadline]), timeoutMs: options.streamTimeoutMs ?? 60_000, requestId: randomUUID(), actor };
        let length = 0, hasText = false, completed = false;
        for await (const event of streamAssistantAnswer(body, callOptions, client)) {
          if (!alive()) return;
          if (deadline.aborted) throw new BridgeFailure('TIMEOUT');
          if (event.type === 'started') start();
          else if (event.type === 'delta') {
            length += event.chunk.length;
            if (length > 24_000) throw new BridgeFailure('UNAVAILABLE');
            hasText ||= !!event.chunk.trim();
            start(); socket.emit('help:answer_chunk', { clientRequestId: id, chunk: event.chunk });
          } else if (event.type === 'citations') {
            const searchSuggestionsHtml = readSearchSuggestionsHtml(event.searchSuggestionsHtml);
            socket.emit('help:citations', { clientRequestId: id, citations: event.citations,
              ...(searchSuggestionsHtml !== undefined ? { searchSuggestionsHtml } : {}) });
          } else if (event.type === 'progress') socket.emit('help:progress', { clientRequestId: id, stage: event.stage, ...(event.message ? { message: event.message } : {}) });
          else if (event.type === 'completed') { completed = true; break; }
        }
        if (alive()) {
          if (deadline.aborted) throw new BridgeFailure('TIMEOUT');
          if (!completed || !hasText) throw new BridgeFailure('UNAVAILABLE');
          socket.emit('help:answer_complete', { clientRequestId: id });
        }
      } catch (error) {
        const failure = normalizeWaseetAiError(error);
        fail(error instanceof BridgeFailure ? error.code : deadline?.aborted || failure.code === WaseetAiErrorCode.TIMEOUT ? 'TIMEOUT' : failure.code === WaseetAiErrorCode.NOT_CONFIGURED ? 'NOT_CONFIGURED' : 'UNAVAILABLE');
      } finally {
        if (reservedUser) {
          const count = (busy.get(reservedUser) ?? 1) - 1;
          if (count) busy.set(reservedUser, count); else busy.delete(reservedUser);
          totalInFlight--;
        }
        if (current.get(socket) === state) current.delete(socket);
      }
    });
  }
  return { authenticate, register, cancelAll() { for (const state of current.values()) state.controller.abort(); current.clear(); } };
}

export function createAssistantDevBridge(options: { platformBaseUrl?: string; fetchImpl?: BridgeFetch; client?: BridgeClient } = {}) {
  const gateway = createBridgeGateway({ verify: createPlatformVerifier({ baseUrl: options.platformBaseUrl, fetchImpl: options.fetchImpl,
    diagnostic: (code, fields) => console.warn(`[AssistantDevBridge] code=${code}`, fields) }), client: options.client });
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', service: 'assistant-dev-bridge', localOnly: true }));
    } else { res.writeHead(404); res.end(); }
  });
  const io = new Server(http, {
    // Existing Angular transport sets withCredentials; cookies are never read or forwarded for authentication.
    cors: { origin: [...BRIDGE_ORIGINS], methods: ['GET', 'POST'], credentials: true },
    maxHttpBufferSize: 256 * 1024, serveClient: false,
    allowRequest: (req, done) => {
      const allowed = isBridgeOriginAllowed(req.headers.origin);
      if (!allowed) console.warn('[AssistantDevBridge] code=ORIGIN_NOT_ALLOWED');
      done(null, allowed);
    },
  });
  let pendingHandshakes = 0;
  io.use((socket, next) => {
    if (io.of('/').sockets.size + pendingHandshakes >= 32) { console.warn('[AssistantDevBridge] handshake rejected code=RATE_LIMITED'); return next(new Error(MESSAGES.RATE_LIMITED)); }
    pendingHandshakes++;
    let released = false;
    const release = () => { if (!released) { released = true; pendingHandshakes--; } };
    void gateway.authenticate(socket).then(() => {
      next();
      // Socket.IO queues _doConnect on nextTick after middleware next(); reserve until it enters .sockets.
      process.nextTick(release);
    }, error => {
      release();
      const code = error instanceof BridgeFailure ? error.code : 'UNAVAILABLE';
      console.warn(`[AssistantDevBridge] handshake rejected code=${code}`);
      next(Object.assign(new Error(MESSAGES[code]), { data: { code } }));
    });
  });
  io.on('connection', socket => gateway.register(socket));
  return {
    http, io,
    start(port = 5011): Promise<void> { return new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', () => { http.off('error', reject); resolve(); }); }); },
    close(): Promise<void> { gateway.cancelAll(); return new Promise(resolve => io.close(() => resolve())); },
  };
}

if (require.main === module) {
  if (process.env.NODE_ENV === 'production') { console.error('The assistant bridge is local development only.'); process.exitCode = 1; }
  else {
    const bridge = createAssistantDevBridge({ platformBaseUrl: process.env.ASSISTANT_DEV_PLATFORM_API || DEFAULT_PLATFORM_API });
    void bridge.start().then(() => console.log('Local assistant bridge ready on http://127.0.0.1:5011 (localhost development origins only).'), () => { console.error('Could not start the local assistant bridge.'); process.exitCode = 1; });
    for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => { void bridge.close().then(() => { process.exitCode = 0; }); });
  }
}
