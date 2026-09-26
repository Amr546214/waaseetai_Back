import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// F2 (ai:generate_description) — Batch: F1+F2 streaming migration to the
// shared Gemini foundation. Same plain-mock-socket convention as
// ai-review.gateway.test.ts. `geminiClient` is mocked via t.mock.module; no
// real network call happens.

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

const VALID_VALIDATION = { isMeaningful: true, isAligned: true, confidence: 92, reasonAr: 'واضح ومتوافق' };

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
  generateStructured?: (prompt: string, options: any) => Promise<any>;
  generateStream?: (prompt: string, options: any) => AsyncGenerator<string, any, void>;
}) {
  const geminiClientMock = {
    isConfigured: () => opts.isConfigured ?? true,
    generateStructured: opts.generateStructured ?? (async (_prompt: string, options: any) => {
      assert.equal(options.validate(VALID_VALIDATION), true, 'the real validator must accept a well-formed validation result');
      return { data: VALID_VALIDATION, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }),
    generateStream: opts.generateStream ?? (() => fakeStream(['وصف ', 'احترافي']))
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./ai-assistant.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return mod.registerAiAssistantGateway as (socket: any) => void;
}

const VALID_PAYLOAD = { projectTitle: 'تطوير متجر إلكتروني متكامل', specialtyName: 'تطوير الويب', subSpecialties: ['React'] };

// ── auth (NEW — this handler previously had no auth check at all) ────────

test('ai:generate_description: an unauthenticated socket (no userId) is rejected without calling Gemini', async (t) => {
  let called = false;
  const register = await loadGateway(t, {
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(called, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai:description_error');
  assert.equal(emitted[0].payload.code, 'UNAUTHENTICATED');
});

// ── validation success → stream success (two-stage happy path) ───────────

test('ai:generate_description: validation success followed by a successful ordered stream emits the full expected event sequence', async (t) => {
  const register = await loadGateway(t, { generateStream: () => fakeStream(['الوصف ', 'الكامل ', 'للمشروع']) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  const events = emitted.map((e) => e.event);
  assert.deepEqual(events, [
    'ai:description_validation_start',
    'ai:description_validation_passed',
    'ai:description_start',
    'ai:description_chunk',
    'ai:description_chunk',
    'ai:description_chunk',
    'ai:description_complete'
  ]);
  const chunks = emitted.filter((e) => e.event === 'ai:description_chunk').map((e) => e.payload.chunk);
  assert.deepEqual(chunks, ['الوصف ', 'الكامل ', 'للمشروع']);
  const complete = emitted[emitted.length - 1];
  assert.equal(complete.payload.fullText, 'الوصف الكامل للمشروع');
  assert.equal(complete.payload.status, 'success');
});

test('ai:generate_description: the title-validation stage passes an explicit, non-truncating maxOutputTokens (live-Gemini truncation regression)', async (t) => {
  const register = await loadGateway(t, {
    generateStructured: async (_prompt, options) => {
      assert.equal(typeof options.maxOutputTokens, 'number');
      assert.ok(options.maxOutputTokens > 0, 'maxOutputTokens must be a defined positive number');
      assert.ok(options.maxOutputTokens >= 500, 'must retain enough headroom to avoid the observed live truncation at 250');
      return { data: VALID_VALIDATION, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);
});

// ── validation rejection behavior ─────────────────────────────────────────

test('ai:generate_description: a validation result that fails isMeaningful/isAligned/confidence rejects before streaming, with no chunks emitted', async (t) => {
  let streamCalled = false;
  const register = await loadGateway(t, {
    generateStructured: async () => ({
      data: { isMeaningful: false, isAligned: true, confidence: 40, reasonAr: 'العنوان غير مفهوم' },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
    }),
    generateStream: () => { streamCalled = true; return fakeStream(['x']); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(streamCalled, false);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_error');
  assert.equal(last.payload.code, 'TITLE_NOT_MEANINGFUL');
  assert.equal(last.payload.message, 'العنوان غير مفهوم');
});

test('ai:generate_description: a low-confidence-but-meaningful validation result is rejected as TITLE_SPECIALTY_MISMATCH', async (t) => {
  const register = await loadGateway(t, {
    generateStructured: async () => ({
      data: { isMeaningful: true, isAligned: true, confidence: 50, reasonAr: 'الثقة منخفضة' },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
    })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_error');
  assert.equal(last.payload.code, 'TITLE_SPECIALTY_MISMATCH');
});

// ── validation provider failure ───────────────────────────────────────────

test('ai:generate_description: the validation stage throwing surfaces as the same honest AI_GENERATION_FAILED error, never a substitute description', async (t) => {
  let streamCalled = false;
  const register = await loadGateway(t, {
    generateStructured: async () => { throw new Error('Gemini unavailable'); },
    generateStream: () => { streamCalled = true; return fakeStream(['x']); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(streamCalled, false);
  const chunkEvents = emitted.filter((e) => e.event === 'ai:description_chunk');
  assert.equal(chunkEvents.length, 0);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_error');
  assert.equal(last.payload.code, 'AI_GENERATION_FAILED');
});

// ── streaming provider failure ────────────────────────────────────────────

test('ai:generate_description: a mid-stream generation failure never emits description_complete, only the honest error', async (t) => {
  const register = await loadGateway(t, {
    generateStream: () => fakeStream(['جزء أول ', 'جزء لن يصل'], { throwAfter: 1, error: new Error('stream died') })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  const completeEvents = emitted.filter((e) => e.event === 'ai:description_complete');
  assert.equal(completeEvents.length, 0, 'description_complete must only ever fire after a genuinely successful stream');
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_error');
  assert.equal(last.payload.code, 'AI_GENERATION_FAILED');
  assert.doesNotMatch(last.payload.message, /نص افتراضي تم إنشاؤه|بديل جاهز/, 'must never claim a substitute was generated');
});

test('ai:generate_description: an empty (zero-chunk) stream after successful validation is treated as a failure, not silent success', async (t) => {
  const register = await loadGateway(t, { generateStream: () => fakeStream([]) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_error');
  assert.equal(last.payload.code, 'AI_GENERATION_FAILED');
});

// ── not configured ───────────────────────────────────────────────────────

test('ai:generate_description: Gemini not configured emits AI_NOT_CONFIGURED without ever starting validation', async (t) => {
  let validateCalled = false;
  const register = await loadGateway(t, {
    isConfigured: false,
    generateStructured: async () => { validateCalled = true; throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(validateCalled, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai:description_error');
  assert.equal(emitted[0].payload.code, 'AI_NOT_CONFIGURED');
});

// ── rate limiting (NEW) ────────────────────────────────────────────────────

test('ai:generate_description: a user issuing more than 30 requests within the window is rate-limited on the next one', async (t) => {
  const register = await loadGateway(t, {});
  const uniqueUserId = `rate-limit-user-${Date.now()}-${Math.random()}`;
  const { socket, handlers, emitted } = createMockSocket({ userId: uniqueUserId });
  register(socket);

  for (let i = 0; i < 30; i++) {
    await handlers['ai:generate_description'](VALID_PAYLOAD);
  }
  emitted.length = 0;

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai:description_error');
  assert.equal(emitted[0].payload.code, 'RATE_LIMITED');
});

// ── title too vague (existing deterministic check, unaffected) ───────────

test('ai:generate_description: a vague title is rejected before calling Gemini at all', async (t) => {
  let called = false;
  const register = await loadGateway(t, {
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description']({ projectTitle: 'مشروع' });

  assert.equal(called, false);
  assert.equal(emitted[0].payload.code, 'TITLE_TOO_VAGUE');
});

// ── disconnect cancellation ──────────────────────────────────────────────

test('ai:generate_description: a socket disconnect aborts the in-flight Gemini generation stream', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const register = await loadGateway(t, {
    generateStream: (_prompt, options) => {
      capturedSignal = options.signal;
      return fakeStream(['a', 'b', 'c'], { checkSignal: options.signal });
    }
  });
  const { socket, handlers, emitted, triggerDisconnect } = createMockSocket({ userId: 'user-1' });
  register(socket);

  const handlerPromise = handlers['ai:generate_description'](VALID_PAYLOAD);
  triggerDisconnect();
  await handlerPromise;

  assert.ok(capturedSignal, 'a signal must be passed to generateStream');
  assert.equal(capturedSignal!.aborted, true);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_error');
});
