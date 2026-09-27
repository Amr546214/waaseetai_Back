import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// F1b (stream_ai_suggest_text / stream_ai_enhance_description) — Batch:
// F1+F2 streaming migration to the shared Gemini foundation. No real
// Socket.IO server is used — a plain mock socket captures registered
// handlers/emitted events, matching this project's established
// req/res-mock convention for controller tests (see
// profile.controller.test.ts) applied to the socket transport.
// `geminiClient` is mocked via t.mock.module; no real network call happens.

function createMockSocket(opts: { userId?: string } = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];

  const socket: any = {
    id: 'socket-test-1',
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

function fakeStream(chunks: string[], opts: { throwAfter?: number; error?: Error; checkSignal?: AbortSignal } = {}) {
  return (async function* () {
    for (let i = 0; i < chunks.length; i++) {
      if (opts.checkSignal?.aborted) {
        const abortError: any = new Error('aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }
      if (opts.throwAfter !== undefined && i === opts.throwAfter) {
        throw opts.error || new Error('stream failed');
      }
      yield chunks[i];
    }
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
  })();
}

async function loadGateway(t: TestContext, opts: {
  isConfigured?: boolean;
  generateStream?: (prompt: string, options: any) => AsyncGenerator<string, any, void>;
  // Defaults to a PROVIDER account — the only current real UI caller of
  // both events (New Project wizard, guarded by providerGuard) — so every
  // pre-existing test above (all using userId: 'user-1') keeps passing
  // unchanged under the new Phase 3 Batch 2A role check.
  accountType?: string | null;
}) {
  const generateStreamSpy = opts.generateStream ?? (() => fakeStream(['حصة']));
  const geminiClientMock = {
    isConfigured: () => opts.isConfigured ?? true,
    generateStream: generateStreamSpy
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const accountType = opts.accountType === undefined ? 'PROVIDER_INDIVIDUAL' : opts.accountType;
  t.mock.module('../config/db', {
    namedExports: { prisma: { user: { findUnique: async () => (accountType === null ? null : { accountType }) } } }
  });

  const moduleUrl = `./ai-review.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return mod.registerAiReviewGateway as (socket: any) => void;
}

// ── auth ─────────────────────────────────────────────────────────────────

test('stream_ai_suggest_text: an unauthenticated socket (no userId) is rejected without calling Gemini', async (t) => {
  let called = false;
  const register = await loadGateway(t, { generateStream: () => { called = true; return fakeStream([]); } });
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  assert.equal(called, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
  assert.match(emitted[0].payload.message, /تسجيل الدخول/);
});

// ── Phase 3 Batch 2A: role authorization — both events' only real UI caller
// is the PROVIDER-facing New Project wizard (confirmed by tracing every
// frontend emit site of stream_ai_suggest_text / stream_ai_enhance_description) ──

test('stream_ai_suggest_text: a PROVIDER_INDIVIDUAL account (the intended role) is accepted and reaches Gemini', async (t) => {
  const register = await loadGateway(t, { accountType: 'PROVIDER_INDIVIDUAL' });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  assert.ok(emitted.some((e) => e.event === 'ai_text_stream_chunk'), 'the intended role must reach the normal streaming success path');
});

test('stream_ai_suggest_text: a CLIENT_INDIVIDUAL account (unintended role) is rejected without calling Gemini', async (t) => {
  let called = false;
  const register = await loadGateway(t, {
    accountType: 'CLIENT_INDIVIDUAL',
    generateStream: () => { called = true; return fakeStream(['x']); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-2' });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  assert.equal(called, false, 'Gemini must never be invoked for an unauthorized role');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
  assert.match(emitted[0].payload.message, /مقدمي الخدمة/);
});

test('stream_ai_enhance_description: a PROVIDER_COMPANY account (the intended role) is accepted and reaches Gemini', async (t) => {
  const register = await loadGateway(t, { accountType: 'PROVIDER_COMPANY' });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-3' });
  register(socket);

  await handlers['stream_ai_enhance_description']({ title: 'تطوير متجر إلكتروني متكامل', description: 'وصف مبدئي' });

  assert.ok(emitted.some((e) => e.event === 'ai_text_stream_chunk'));
});

test('stream_ai_enhance_description: a CLIENT_COMPANY account (unintended role) is rejected without calling Gemini', async (t) => {
  let called = false;
  const register = await loadGateway(t, {
    accountType: 'CLIENT_COMPANY',
    generateStream: () => { called = true; return fakeStream(['x']); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-4' });
  register(socket);

  await handlers['stream_ai_enhance_description']({ title: 'تطوير متجر إلكتروني متكامل', description: 'وصف مبدئي' });

  assert.equal(called, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
  assert.match(emitted[0].payload.message, /مقدمي الخدمة/);
});

// ── successful multiple-chunk stream + ordering + completion-only-on-success ──

test('stream_ai_suggest_text: a real validated Gemini stream emits chunks in order then a single success end event', async (t) => {
  const register = await loadGateway(t, { generateStream: () => fakeStream(['أهلاً ', 'وسهلاً ', 'بكم']) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  const events = emitted.map((e) => e.event);
  assert.deepEqual(events, ['ai_text_stream_start', 'ai_text_stream_chunk', 'ai_text_stream_chunk', 'ai_text_stream_chunk', 'ai_text_stream_end']);
  const chunks = emitted.filter((e) => e.event === 'ai_text_stream_chunk').map((e) => e.payload.chunk);
  assert.deepEqual(chunks, ['أهلاً ', 'وسهلاً ', 'بكم']);
  const end = emitted[emitted.length - 1];
  assert.match(end.payload.message, /اكتمل/);
});

// ── stream failure / timeout / provider failure — honest end, no fake fallback ──

test('stream_ai_suggest_text: Gemini throwing immediately produces an honest failure end event with zero chunks emitted', async (t) => {
  const register = await loadGateway(t, {
    generateStream: () => fakeStream([], { throwAfter: 0, error: new Error('provider unavailable') })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  const chunkEvents = emitted.filter((e) => e.event === 'ai_text_stream_chunk');
  assert.equal(chunkEvents.length, 0, 'no fake/canned text may ever be emitted as chunks on failure');
  const end = emitted[emitted.length - 1];
  assert.equal(end.event, 'ai_text_stream_end');
  assert.match(end.payload.message, /تعذر/);
});

test('stream_ai_suggest_text: a mid-stream failure (simulating a timeout) still yields already-sent chunks but ends honestly, not with a success message', async (t) => {
  const register = await loadGateway(t, {
    generateStream: () => fakeStream(['جزء أول ', 'جزء لن يصل'], { throwAfter: 1, error: new Error('timeout') })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  const chunkEvents = emitted.filter((e) => e.event === 'ai_text_stream_chunk');
  assert.equal(chunkEvents.length, 1);
  const end = emitted[emitted.length - 1];
  assert.equal(end.event, 'ai_text_stream_end');
  assert.match(end.payload.message, /تعذر/, 'must never claim success after a mid-stream failure');
});

test('stream_ai_suggest_text: an empty (zero-chunk) Gemini stream is treated as a failure, never a silent success', async (t) => {
  const register = await loadGateway(t, { generateStream: () => fakeStream([]) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  const end = emitted[emitted.length - 1];
  assert.equal(end.event, 'ai_text_stream_end');
  assert.match(end.payload.message, /تعذر/);
});

// ── not configured ───────────────────────────────────────────────────────

test('stream_ai_suggest_text: Gemini not configured emits an honest "not configured" end event without starting a stream', async (t) => {
  let called = false;
  const register = await loadGateway(t, { isConfigured: false, generateStream: () => { called = true; return fakeStream([]); } });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  assert.equal(called, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
  assert.match(emitted[0].payload.message, /غير مهيأة/);
});

// ── rate limiting ────────────────────────────────────────────────────────

test('stream_ai_suggest_text: a user issuing more than 30 requests within the window is rate-limited on the next one', async (t) => {
  const register = await loadGateway(t, { generateStream: () => fakeStream(['ok']) });
  const { socket, handlers, emitted } = createMockSocket({ userId: `rate-limit-user-${Date.now()}-${Math.random()}` });
  register(socket);

  for (let i = 0; i < 30; i++) {
    await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });
  }
  emitted.length = 0;

  await handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
  assert.match(emitted[0].payload.message, /تجاوز الحد المسموح/);
});

// ── invalid title (existing deterministic validator, unaffected by migration) ──

test('stream_ai_suggest_text: a non-meaningful title is rejected before ever calling Gemini', async (t) => {
  let called = false;
  const register = await loadGateway(t, { generateStream: () => { called = true; return fakeStream([]); } });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_suggest_text']({ title: 'اا' });

  assert.equal(called, false);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
});

// ── disconnect cancellation ──────────────────────────────────────────────

test('stream_ai_suggest_text: a socket disconnect aborts the in-flight Gemini stream', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const register = await loadGateway(t, {
    generateStream: (_prompt, options) => {
      capturedSignal = options.signal;
      return fakeStream(['a', 'b', 'c'], { checkSignal: options.signal });
    }
  });
  const { socket, handlers, emitted, triggerDisconnect } = createMockSocket({ userId: 'user-1' });
  register(socket);

  // Abort before the handler even starts consuming — proves the same signal
  // wired into generateStream() is the one the disconnect handler aborts.
  const handlerPromise = handlers['stream_ai_suggest_text']({ title: 'تطوير متجر إلكتروني متكامل' });
  // Phase 3 Batch 2A added an async role-check (a DB lookup) before the
  // disconnect handler gets registered — let that one microtask resolve so
  // the abort-controller registration (still fully synchronous after it)
  // has actually happened before we fire the disconnect trigger below.
  await Promise.resolve();
  triggerDisconnect();
  await handlerPromise;

  assert.ok(capturedSignal, 'a signal must be passed to generateStream');
  assert.equal(capturedSignal!.aborted, true);
  const end = emitted[emitted.length - 1];
  assert.equal(end.event, 'ai_text_stream_end');
  assert.match(end.payload.message, /تعذر/);
});

// ── enhance-description event (same contract, different event name) ──────

test('stream_ai_enhance_description: a real validated Gemini stream completes successfully with the "improve" mode preserved', async (t) => {
  const register = await loadGateway(t, { generateStream: () => fakeStream(['نص ', 'محسّن']) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_enhance_description']({ title: 'تطوير متجر إلكتروني متكامل', description: 'وصف مبدئي' });

  const events = emitted.map((e) => e.event);
  assert.deepEqual(events, ['ai_text_stream_start', 'ai_text_stream_chunk', 'ai_text_stream_chunk', 'ai_text_stream_end']);
  assert.ok(events.every((_, i) => emitted[i].payload.mode === 'improve'));
});

test('stream_ai_enhance_description: missing both title and description is rejected before calling Gemini', async (t) => {
  let called = false;
  const register = await loadGateway(t, { generateStream: () => { called = true; return fakeStream([]); } });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['stream_ai_enhance_description']({ title: '', description: '' });

  assert.equal(called, false);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
});
