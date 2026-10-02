import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WaseetAiClient, type FetchLike } from '../services/ai/waseet-ai/waseet-ai.client';

// WaseetAI integration (AI-01): generate mode streams from WaseetAI
// /v1/ai/project-description/stream. The REAL WaseetAiClient (SSE parsing,
// status mapping, timeout) runs against a mocked fetch that returns SSE
// frames — zero real WaseetAI calls. There is no Gemini path at all (the
// gateway no longer imports it). Dummy test token only.
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

// ai:generate_description — WaseetAI-only. Same plain-mock-socket convention
// as ai-review.gateway.test.ts; no real network call happens.

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

async function loadGateway(t: TestContext, opts: {
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

test('ai:generate_description: an unauthenticated socket (no userId) is rejected without calling WaseetAI', async (t) => {
  const register = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(register.waseetCalls.length, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai:description_error');
  assert.equal(emitted[0].payload.code, 'UNAUTHENTICATED');
});

// ── Phase 3 Batch 2A: role authorization — this feature's only real UI
// caller is the CLIENT-facing Create Request page (confirmed by tracing
// every frontend emit site of ai:generate_description) ────────────────────

test('ai:generate_description: current CLIENT activeRole is accepted and reaches WaseetAI', async (t) => {
  const register = await loadGateway(t, { activeRole: 'CLIENT' });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.ok(emitted.some((e) => e.event === 'ai:description_complete'), 'the intended role must reach the normal success path');
});

test('ai:generate_description: current PROVIDER activeRole is rejected without calling WaseetAI', async (t) => {
  const register = await loadGateway(t, { activeRole: 'PROVIDER' });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-2' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(register.waseetCalls.length, 0, 'WaseetAI must never be invoked for an unauthorized role');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai:description_error');
  assert.equal(emitted[0].payload.code, 'FORBIDDEN_ROLE');
});

test('ai:generate_description: an ADMIN account with default CLIENT activeRole is rejected', async (t) => {
  const register = await loadGateway(t, { activeRole: 'CLIENT', accountType: 'ADMIN' });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'admin-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  assert.equal(register.waseetCalls.length, 0);
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

test('ai:generate_description: a successful ordered stream emits the expected event sequence (no AI pre-check events)', async (t) => {
  const register = await loadGateway(t, { waseetFetch: async () => okStream(['الوصف ', 'الكامل ', 'للمشروع']) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

  const events = emitted.map((e) => e.event);
  assert.deepEqual(events, [
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

test('ai:generate_description: a vague title is rejected before calling WaseetAI at all', async (t) => {
  const register = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description']({ projectTitle: 'مشروع' });

  assert.equal(register.waseetCalls.length, 0);
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
  const register = await loadGateway(t, { waseetConfigured: false });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description'](VALID_PAYLOAD);

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

test('refine mode (existing draft > 5 chars) streams from the enhance endpoint with ONLY the description', async (t) => {
  const register = await loadGateway(t, {
    waseetFetch: async () => okStream(['وصف ', 'محسّن'])
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description']({ ...VALID_PAYLOAD, existingDescription: 'مسودة وصف موجودة للمشروع' });

  assert.equal(register.waseetCalls.length, 1);
  assert.equal(register.waseetCalls[0].url, 'https://waseet-ai.test/v1/ai/text/enhance/stream');
  assert.deepEqual(register.waseetCalls[0].body, { description: 'مسودة وصف موجودة للمشروع' });
  assert.deepEqual(emitted.map((e) => e.event), ['ai:description_start', 'ai:description_chunk', 'ai:description_chunk', 'ai:description_complete']);
  assert.ok(emitted.every((e) => e.payload.mode === 'refine'));
  assert.equal(emitted[3].payload.fullText, 'وصف محسّن');
  assert.ok(!emitted.some((e) => e.payload?.code === 'REFINE_UNAVAILABLE'));
});

test('refine mode: a draft of 5 chars or fewer falls back to generate mode', async (t) => {
  const register = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description']({ ...VALID_PAYLOAD, existingDescription: 'قصير' });

  assert.equal(register.waseetCalls[0].url, 'https://waseet-ai.test/v1/ai/project-description/stream');
  assert.equal(emitted[0].payload.mode, 'generate');
});

test('refine mode: upstream failure yields the honest AI_GENERATION_FAILED and no complete event', async (t) => {
  const register = await loadGateway(t, {
    waseetFetch: async () => new Response(UPSTREAM_SECRET_TEXT, { status: 502 })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['ai:generate_description']({ ...VALID_PAYLOAD, existingDescription: 'مسودة وصف موجودة للمشروع' });

  assert.ok(!emitted.some((e) => e.event === 'ai:description_complete'));
  assert.equal(emitted[emitted.length - 1].payload.code, 'AI_GENERATION_FAILED');
  assert.ok(!JSON.stringify(emitted).includes(UPSTREAM_SECRET_TEXT));
});

test('the gateway has no direct-Gemini dependency (no AI pre-check, no fallback)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./ai-assistant.gateway.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gemini\.client|geminiClient|generateStructured|generateStream/);
});
