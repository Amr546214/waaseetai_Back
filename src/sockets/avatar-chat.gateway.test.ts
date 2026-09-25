import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from '../services/ai/gemini/gemini.errors';

// F8-TEXT (ai_chat) — security follow-up batch migration to the shared
// Gemini foundation. Previously embedded inline in socket.ts, calling
// OpenAI gpt-4o-mini directly with no rate limiting, no cancellation, and
// always emitting `success: true` even on total provider failure (a canned
// greeting disguised as a real response). `prisma`, `geminiClient`, and
// `openai` (TTS only — not migrated this batch) are all mocked; no real
// DB/network call happens.

function createMockSocket(opts: { userId?: string; id?: string } = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];

  const socket: any = {
    id: opts.id || 'socket-test-1',
    userId: opts.userId,
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    once: (event: string, handler: (...args: any[]) => any) => {
      (onceHandlers[event] ||= []).push(handler);
    },
    off: (event: string, handler?: (...args: any[]) => any) => {
      if (!onceHandlers[event]) return;
      onceHandlers[event] = handler ? onceHandlers[event].filter((h) => h !== handler) : [];
    },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); }
  };

  return {
    socket,
    handlers,
    emitted,
    triggerDisconnect: () => { (onceHandlers['disconnect'] || []).forEach((h) => h()); }
  };
}

const VALID_CHAT_RESPONSE = {
  fullResponse: 'مرحباً بك! كيف يمكنني مساعدتك اليوم؟',
  speechTimeline: [
    { textSegment: 'مرحباً بك!', excitementLevel: 0.7, gestureFrequency: 0.6, bodyLanguagePose: 'WELCOME_OPEN' }
  ]
};

async function loadGateway(t: TestContext, opts: {
  user?: any;
  isConfigured?: boolean;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
  ttsConfigured?: boolean;
  generateSpeechMp3Base64?: (text: string) => Promise<string>;
} = {}) {
  const prismaMock: any = {
    user: { findUnique: async () => (opts.user === undefined ? { firstName: 'أحمد', lastName: 'محمد', accountType: 'CLIENT_INDIVIDUAL' } : opts.user) }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    isConfigured: () => opts.isConfigured ?? true,
    generateStructured: opts.generateStructured ?? (async (_prompt: string, options: any) => {
      assert.equal(options.validate(VALID_CHAT_RESPONSE), true, 'the real validator must accept a well-formed avatar chat response');
      return { data: VALID_CHAT_RESPONSE, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const openAiTtsMock = {
    isOpenAiTtsConfigured: () => opts.ttsConfigured ?? true,
    generateSpeechMp3Base64: opts.generateSpeechMp3Base64 ?? (async () => Buffer.from('fake-mp3-bytes').toString('base64'))
  };
  t.mock.module('../services/ai/openai-tts.client', { namedExports: openAiTtsMock });

  const moduleUrl = `./avatar-chat.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return mod.registerAvatarChatGateway as (socket: any) => void;
}

// ── authenticated success ─────────────────────────────────────────────────

test('ai_chat: an authenticated user gets a real validated Gemini text response plus audio, status TEXT_GENERATED', async (t) => {
  const register = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai_chat']({ message: 'مرحباً', token: undefined, currentRoute: '/dashboard' });

  assert.equal(emitted.length, 1);
  const res = emitted[0];
  assert.equal(res.event, 'ai_chat_response');
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.status, 'TEXT_GENERATED');
  assert.equal(res.payload.data.text, VALID_CHAT_RESPONSE.fullResponse);
  assert.deepEqual(res.payload.data.speechTimeline, VALID_CHAT_RESPONSE.speechTimeline);
  assert.equal(typeof res.payload.data.audioBase64, 'string');
  assert.ok(res.payload.data.audioBase64.length > 0);
});

// ── guest (unauthenticated) success — soft-auth by design ─────────────────

test('ai_chat: a guest with no userId still gets a real Gemini response (soft-auth, never rejected)', async (t) => {
  let capturedSystemPrompt = '';
  const register = await loadGateway(t, {
    generateStructured: async (_prompt, options) => {
      capturedSystemPrompt = options.systemInstruction;
      return { data: VALID_CHAT_RESPONSE, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);

  await handlers['ai_chat']({ message: 'مرحباً' });

  assert.equal(emitted[0].payload.success, true);
  assert.match(capturedSystemPrompt, /زائر غير مسجل/, 'guest system prompt must be used when there is no authenticated userId');
});

test('ai_chat: a stale/deleted-user token falls back to the honest guest prompt instead of an empty system instruction', async (t) => {
  let capturedSystemPrompt = '';
  const register = await loadGateway(t, {
    user: null,
    generateStructured: async (_prompt, options) => {
      capturedSystemPrompt = options.systemInstruction;
      return { data: VALID_CHAT_RESPONSE, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers } = createMockSocket({ userId: 'deleted-user' });
  register(socket);

  await handlers['ai_chat']({ message: 'مرحباً' });

  assert.match(capturedSystemPrompt, /زائر غير مسجل/);
  assert.ok(capturedSystemPrompt.length > 0);
});

// ── Gemini text failure paths (honest failure, no fabricated response) ────

test('ai_chat: Gemini provider unavailable returns an honest UNAVAILABLE failure, never a canned response', async (t) => {
  const register = await loadGateway(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai_chat']({ message: 'مرحباً' });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.success, false);
  assert.equal(emitted[0].payload.status, 'UNAVAILABLE');
  assert.equal(emitted[0].payload.data, undefined, 'a failure response must never carry a fabricated data.text');
});

test('ai_chat: a Gemini timeout returns the same honest UNAVAILABLE failure', async (t) => {
  const register = await loadGateway(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.TIMEOUT, 'timed out'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai_chat']({ message: 'مرحباً' });

  assert.equal(emitted[0].payload.status, 'UNAVAILABLE');
});

test('ai_chat: malformed/empty Gemini output is rejected by the validator and surfaces as the same honest failure', async (t) => {
  const register = await loadGateway(t, {
    generateStructured: async (_prompt, options) => {
      const malformed = { fullResponse: '', speechTimeline: [] };
      assert.equal(options.validate(malformed), false, 'the validator must reject an empty fullResponse/speechTimeline');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai_chat']({ message: 'مرحباً' });

  assert.equal(emitted[0].payload.success, false);
  assert.equal(emitted[0].payload.status, 'UNAVAILABLE');
});

test('ai_chat: Gemini not configured (no GEMINI_API_KEY) returns the same honest UNAVAILABLE failure', async (t) => {
  const register = await loadGateway(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.NOT_CONFIGURED, 'GEMINI_API_KEY is not configured'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai_chat']({ message: 'مرحباً' });

  assert.equal(emitted[0].payload.status, 'UNAVAILABLE');
});

// ── honest text/audio degradation (Section 7) ──────────────────────────────

test('ai_chat: text succeeds but TTS fails — status TEXT_GENERATED_AUDIO_UNAVAILABLE, real text still returned, no fabricated audio', async (t) => {
  const register = await loadGateway(t, {
    generateSpeechMp3Base64: async () => { throw new Error('TTS provider down'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai_chat']({ message: 'مرحباً' });

  const res = emitted[0].payload;
  assert.equal(res.success, true);
  assert.equal(res.status, 'TEXT_GENERATED_AUDIO_UNAVAILABLE');
  assert.equal(res.data.text, VALID_CHAT_RESPONSE.fullResponse);
  assert.equal(res.data.audioBase64, null);
});

// ── rate limiting (reuses src/utils/socket-ai-rate-limit.ts) ──────────────

test('ai_chat: an authenticated user issuing more than 30 requests within the window is rate-limited on the next one', async (t) => {
  const register = await loadGateway(t, {});
  const uniqueUserId = `rate-limit-user-${Date.now()}-${Math.random()}`;
  const { socket, handlers, emitted } = createMockSocket({ userId: uniqueUserId });
  register(socket);

  for (let i = 0; i < 30; i++) {
    await handlers['ai_chat']({ message: 'مرحباً' });
  }
  emitted.length = 0;

  await handlers['ai_chat']({ message: 'مرحباً' });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.success, false);
  assert.equal(emitted[0].payload.status, 'RATE_LIMITED');
});

test('ai_chat: two different guest sockets (no userId) are rate-limited independently, keyed by socket.id', async (t) => {
  const register = await loadGateway(t, {});
  const guestA = createMockSocket({ userId: undefined, id: `guest-a-${Date.now()}-${Math.random()}` });
  const guestB = createMockSocket({ userId: undefined, id: `guest-b-${Date.now()}-${Math.random()}` });
  register(guestA.socket);
  register(guestB.socket);

  for (let i = 0; i < 30; i++) {
    await guestA.handlers['ai_chat']({ message: 'مرحباً' });
  }
  guestA.emitted.length = 0;

  await guestB.handlers['ai_chat']({ message: 'مرحباً' });

  assert.equal(guestB.emitted[0].payload.status, 'TEXT_GENERATED');
});

// ── input cap ───────────────────────────────────────────────────────────

test('ai_chat: an overlong message is truncated to the max length before being sent to Gemini', async (t) => {
  let capturedPrompt = '';
  const register = await loadGateway(t, {
    generateStructured: async (prompt, options) => {
      capturedPrompt = prompt;
      assert.equal(options.validate(VALID_CHAT_RESPONSE), true);
      return { data: VALID_CHAT_RESPONSE, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers } = createMockSocket({ userId: 'user-1' });
  register(socket);

  const hugeMessage = 'أ'.repeat(5000);
  await handlers['ai_chat']({ message: hugeMessage });

  assert.ok(capturedPrompt.length <= 1000, `expected capped prompt length <= 1000, got ${capturedPrompt.length}`);
});

test('ai_chat: an empty message defaults to a friendly greeting instead of an empty prompt', async (t) => {
  let capturedPrompt = '';
  const register = await loadGateway(t, {
    generateStructured: async (prompt, options) => {
      capturedPrompt = prompt;
      return { data: VALID_CHAT_RESPONSE, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai_chat']({ message: '' });

  assert.equal(capturedPrompt, 'مرحباً');
});

// ── disconnect cancellation ────────────────────────────────────────────────

test('ai_chat: a socket disconnect aborts the in-flight Gemini generation', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const register = await loadGateway(t, {
    generateStructured: (_prompt, options) => {
      capturedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const rejectAborted = () => {
          const err: any = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        // Mirrors the real geminiClient's own defensive check (see
        // gemini.client.ts#buildTimeoutSignal) — the signal may already be
        // aborted by the time this mock runs (e.g. disconnect happened
        // during the preceding DB lookup), in which case 'abort' will never
        // fire again.
        if (options.signal?.aborted) rejectAborted();
        else options.signal?.addEventListener('abort', rejectAborted);
      });
    }
  });
  const { socket, handlers, emitted, triggerDisconnect } = createMockSocket({ userId: 'user-1' });
  register(socket);

  const handlerPromise = handlers['ai_chat']({ message: 'مرحباً' });
  triggerDisconnect();
  await handlerPromise;

  assert.ok(capturedSignal, 'a signal must be passed to generateStructured');
  assert.equal(capturedSignal!.aborted, true);
  assert.equal(emitted[emitted.length - 1].payload.status, 'UNAVAILABLE');
});
