import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WaseetAiClient, type FetchLike } from '../services/ai/waseet-ai/waseet-ai.client';

// WaseetAI integration (AI-01): generate mode streams from WaseetAI
// /v1/ai/project-description/stream. The REAL WaseetAiClient (SSE parsing,
// status mapping, timeout) runs against a mocked fetch that returns SSE
// frames — zero real WaseetAI/Gemini calls. Gemini is still mocked for the
// title-validation stage and refine mode. Dummy test token only.
const TEST_TOKEN = 'unit-test-dummy-token-0000';
const UPSTREAM_SECRET_TEXT = 'UPSTREAM-INTERNAL-DETAIL-should-never-leak';
const enc = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function sseResponse(frames: string[], opts: { errorAfter?: number; hangAfter?: boolean; signal?: AbortSignal | null } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      frames.forEach((f, i) => {
        if (opts.errorAfter === i) return;
        if (opts.errorAfter !== undefined && i > opts.errorAfter) return;
        controller.enqueue(enc.encode(f));
      });
      if (opts.errorAfter !== undefined) { controller.error(new TypeError('socket hang up')); return; }
      if (opts.hangAfter) {
        if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; controller.error(e); return; }
        opts.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; controller.error(e); });
        return;
      }
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const okStream = (chunks: string[]) => sseResponse([
  frame('generation.started', { status: 'started' }),
  ...chunks.map((chunk) => frame('text.delta', { chunk })),
  frame('generation.completed', { status: 'completed' })
]);

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
  // Defaults to the current CLIENT role. Socket authorization must follow
  // the user's fresh activeRole, not the base accountType.
  activeRole?: string | null;
  accountType?: string | null;
  waseetFetch?: FetchLike;
  waseetConfigured?: boolean;
  waseetTimeoutMs?: number;
}) {
  const waseetCalls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const waseetFetch: FetchLike = opts.waseetFetch ?? (async () => okStream(['وصف ', 'احترافي']));
  const realClient = new WaseetAiClient(async (url, init) => {
    waseetCalls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return waseetFetch(url, init);
  }, () => ({
    baseUrl: 'https://waseet-ai.test',
    bearerToken: opts.waseetConfigured === false ? undefined : TEST_TOKEN,
    restTimeoutMs: 1000,
    streamTimeoutMs: opts.waseetTimeoutMs ?? 1000
  }));
  t.mock.module('../services/ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: realClient } });

  const geminiClientMock = {
    isConfigured: () => opts.isConfigured ?? true,
    generateStructured: opts.generateStructured ?? (async (_prompt: string, options: any) => {
      assert.equal(options.validate(VALID_VALIDATION), true, 'the real validator must accept a well-formed validation result');
      return { data: VALID_VALIDATION, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }),
    generateStream: opts.generateStream ?? (() => fakeStream(['وصف ', 'احترافي']))
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const activeRole = opts.activeRole === undefined ? 'CLIENT' : opts.activeRole;
  const accountType = opts.accountType === undefined ? 'CLIENT_INDIVIDUAL' : opts.accountType;
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        user: {
          findUnique: async () =>
            activeRole === null || accountType === null
              ? null
              : { activeRole, accountType }
        }
      }
    }
  });

  const moduleUrl = `./ai-assistant.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  const register = mod.registerAiAssistantGateway as (socket: any) => void;
  return Object.assign(register, { waseetCalls });
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

// ── Phase 3 Batch 2A: role authorization — this feature's only real UI
// caller is the CLIENT-facing Create Request page (confirmed by tracing
// every frontend emit site of ai:generate_description) ────────────────────

test('ai:generate_description: current CLIENT activeRole is accepted and reaches Gemini', async (t) => {
  const register = await loadGateway(t, { activeRole: 'CLIENT' });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.ok(emitted.some((e) => e.event === 'ai:description_complete'), 'the intended role must reach the normal success path');
});

test('ai:generate_description: current PROVIDER activeRole is rejected without calling Gemini', async (t) => {
  let called = false;
  const register = await loadGateway(t, {
    activeRole: 'PROVIDER',
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-2' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(called, false, 'Gemini must never be invoked for an unauthorized role');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai:description_error');
  assert.equal(emitted[0].payload.code, 'FORBIDDEN_ROLE');
});

test('ai:generate_description: an ADMIN account with default CLIENT activeRole is rejected', async (t) => {
  let called = false;
  const register = await loadGateway(t, {
    activeRole: 'CLIENT',
    accountType: 'ADMIN',
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'admin-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(called, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai:description_error');
  assert.equal(emitted[0].payload.code, 'FORBIDDEN_ROLE');
});

test('ai:generate_description: switching a multi-role user back to CLIENT is accepted', async (t) => {
  const register = await loadGateway(t, { activeRole: 'CLIENT' });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-3' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.ok(emitted.some((e) => e.event === 'ai:description_complete'));
});

// ── validation success → stream success (two-stage happy path) ───────────

test('ai:generate_description: validation success followed by a successful ordered stream emits the full expected event sequence', async (t) => {
  const register = await loadGateway(t, { waseetFetch: async () => okStream(['الوصف ', 'الكامل ', 'للمشروع']) });
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
    waseetFetch: async () => { streamCalled = true; return okStream(['x']); }
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
    waseetFetch: async () => { streamCalled = true; return okStream(['x']); }
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
    waseetFetch: async () => sseResponse([frame('text.delta', { chunk: 'جزء أول ' }), frame('text.delta', { chunk: 'جزء لن يصل' })], { errorAfter: 1 })
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
  const register = await loadGateway(t, { waseetFetch: async () => okStream([]) });
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

test('ai:generate_description: a socket disconnect aborts the in-flight WaseetAI generation stream', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const register = await loadGateway(t, {
    waseetFetch: async (_url, init) => {
      capturedSignal = init.signal ?? undefined;
      return sseResponse([frame('text.delta', { chunk: 'a' })], { hangAfter: true, signal: init.signal });
    }
  });
  const { socket, handlers, emitted, triggerDisconnect } = createMockSocket({ userId: 'user-1' });
  register(socket);

  const handlerPromise = handlers['ai:generate_description'](VALID_PAYLOAD);
  // Phase 3 Batch 2A added an async role-check (a DB lookup) before the
  // disconnect handler gets registered — let that one microtask resolve so
  // the abort-controller registration (still fully synchronous after it)
  // has actually happened before we fire the disconnect trigger below.
  await Promise.resolve();
  triggerDisconnect();
  await handlerPromise;

  assert.ok(capturedSignal, 'a signal must be passed to the WaseetAI stream');
  assert.equal(capturedSignal!.aborted, true);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_error');
});

// ── WaseetAI AI-01 contract / adapter tests ─────────────────────────────────

test('AI-01: request mapping — generate mode POSTs the documented /v1/ai/project-description/stream body', async (t) => {
  const register = await loadGateway(t, {});
  const { socket, handlers } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(register.waseetCalls.length, 1);
  assert.equal(register.waseetCalls[0].url, 'https://waseet-ai.test/v1/ai/project-description/stream');
  assert.deepEqual(register.waseetCalls[0].body, { title: 'تطوير متجر إلكتروني متكامل', category: 'تطوير الويب — React', language: 'ar' });
  assert.equal(register.waseetCalls[0].headers.Accept, 'text/event-stream');
});

test('AI-01: streaming chunks are relayed in order as plain strings and completion emits ai:description_complete with the full text', async (t) => {
  const register = await loadGateway(t, {
    waseetFetch: async () => sseResponse([
      frame('generation.started', { status: 'started' }),
      frame('text.delta', { chunk: '## نطاق ' }),
      frame('text.delta', { chunk: 'العمل' }),
      frame('generation.completed', { status: 'completed' })
    ])
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  const chunks = emitted.filter((e) => e.event === 'ai:description_chunk');
  assert.deepEqual(chunks.map((c) => c.payload), [{ chunk: '## نطاق ', mode: 'generate' }, { chunk: 'العمل', mode: 'generate' }]);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_complete');
  assert.equal(last.payload.fullText, '## نطاق العمل');
});

for (const [label, status] of [['4xx', 400], ['401', 401], ['5xx', 503]] as const) {
  test(`AI-01: upstream ${label} → honest AI_GENERATION_FAILED, no chunks, no upstream text leaked`, async (t) => {
    const register = await loadGateway(t, {
      waseetFetch: async () => new Response(JSON.stringify({ error: UPSTREAM_SECRET_TEXT }), { status })
    });
    const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
    register(socket);

    await handlers['ai:generate_description'](VALID_PAYLOAD);

    assert.equal(emitted.filter((e) => e.event === 'ai:description_chunk').length, 0);
    assert.equal(emitted.filter((e) => e.event === 'ai:description_complete').length, 0);
    const last = emitted[emitted.length - 1];
    assert.equal(last.event, 'ai:description_error');
    assert.equal(last.payload.code, 'AI_GENERATION_FAILED');
    assert.ok(!JSON.stringify(emitted).includes(UPSTREAM_SECRET_TEXT));
  });
}

test('AI-01: timeout → honest AI_GENERATION_FAILED (no partial "success")', async (t) => {
  const register = await loadGateway(t, {
    waseetTimeoutMs: 20,
    waseetFetch: async (_url, init) => sseResponse([frame('text.delta', { chunk: 'جزء' })], { hangAfter: true, signal: init.signal })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(emitted.filter((e) => e.event === 'ai:description_complete').length, 0);
  assert.equal(emitted[emitted.length - 1].payload.code, 'AI_GENERATION_FAILED');
});

for (const [label, frames] of [
  ['malformed text event (no string chunk)', [frame('text.delta', { notChunk: 1 }), frame('generation.completed', {})]],
  ['stream ends without a completion event', [frame('text.delta', { chunk: 'نص بدون اكتمال' })]],
  ['in-stream error event', [frame('text.delta', { chunk: 'جزء' }), frame('generation.failed', { message: UPSTREAM_SECRET_TEXT })]]
] as const) {
  test(`AI-01: ${label} → honest AI_GENERATION_FAILED, never ai:description_complete`, async (t) => {
    const register = await loadGateway(t, { waseetFetch: async () => sseResponse([...frames]) });
    const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
    register(socket);

    await handlers['ai:generate_description'](VALID_PAYLOAD);

    assert.equal(emitted.filter((e) => e.event === 'ai:description_complete').length, 0);
    assert.equal(emitted[emitted.length - 1].payload.code, 'AI_GENERATION_FAILED');
    assert.ok(!JSON.stringify(emitted).includes(UPSTREAM_SECRET_TEXT));
  });
}

test('AI-01: WaseetAI not configured → AI_NOT_CONFIGURED before any AI call', async (t) => {
  let validateCalled = false;
  const register = await loadGateway(t, {
    waseetConfigured: false,
    generateStructured: async () => { validateCalled = true; throw new Error('should never be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(validateCalled, false);
  assert.equal(register.waseetCalls.length, 0);
  assert.deepEqual(emitted.map((e) => e.payload.code), ['AI_NOT_CONFIGURED']);
});

test('AI-01: the WaseetAI credential is never emitted to the browser socket', async (t) => {
  const register = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(register.waseetCalls[0].headers.Authorization, `Bearer ${TEST_TOKEN}`, 'backend→WaseetAI hop only');
  const wire = JSON.stringify(emitted);
  assert.ok(!wire.includes(TEST_TOKEN));
  assert.ok(!wire.includes('waseet-ai.test'), 'the upstream URL is never exposed either');
});

test('refine mode (existing draft) stays on Gemini — the documented WaseetAI body has no draft field — and never calls WaseetAI', async (t) => {
  let geminiPrompt = '';
  const register = await loadGateway(t, {
    generateStream: (prompt) => { geminiPrompt = prompt; return fakeStream(['نص ', 'محسن']); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description']({ ...VALID_PAYLOAD, existingDescription: 'مسودة وصف موجودة للمشروع' });

  assert.equal(register.waseetCalls.length, 0);
  assert.match(geminiPrompt, /مسودة وصف موجودة للمشروع/);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai:description_complete');
  assert.equal(last.payload.mode, 'refine');
  assert.equal(last.payload.fullText, 'نص محسن');
});
