import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WaseetAiError, WaseetAiErrorCode } from '../services/ai/waseet-ai/waseet-ai.errors';
import type { WaseetAiStreamEvent } from '../services/ai/waseet-ai/waseet-ai.types';

// stream_ai_suggest_text / stream_ai_enhance_description — WaseetAI only.
// No real Socket.IO server and no network: a plain mock socket captures
// handlers/emitted events and `waseetAiClient` is mocked.

function createMockSocket(opts: { userId?: string } = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const socket: any = {
    id: 'socket-test-1',
    userId: opts.userId,
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    once: (event: string, handler: (...args: any[]) => any) => { (onceHandlers[event] ||= []).push(handler); },
    off: (event: string, handler?: (...args: any[]) => any) => {
      if (!onceHandlers[event]) return;
      onceHandlers[event] = handler ? onceHandlers[event].filter((h) => h !== handler) : [];
    },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); }
  };
  return { socket, handlers, emitted, triggerDisconnect: () => { (onceHandlers['disconnect'] || []).forEach((h) => h()); }, onceHandlers };
}

const delta = (chunk: string): WaseetAiStreamEvent => ({ type: 'delta', chunk });

function fakeStream(events: WaseetAiStreamEvent[], opts: { throwAfter?: number; error?: Error } = {}) {
  return (async function* () {
    for (let i = 0; i < events.length; i++) {
      if (opts.throwAfter !== undefined && i === opts.throwAfter) throw opts.error ?? new Error('stream failed');
      yield events[i];
    }
  })();
}
const okEvents = (chunks: string[]): WaseetAiStreamEvent[] => [{ type: 'started' }, ...chunks.map(delta), { type: 'completed' }];

interface Call { method: string; body: any; opts: any }

async function loadGateway(t: TestContext, opts: {
  isConfigured?: boolean;
  stream?: (call: Call) => AsyncGenerator<WaseetAiStreamEvent, void, void>;
  accountType?: string | null;
} = {}) {
  const calls: Call[] = [];
  const make = (method: string) => (body: any, o: any) => {
    const call = { method, body, opts: o };
    calls.push(call);
    return (opts.stream ?? (() => fakeStream(okEvents(['حصة ', 'ثانية']))))(call);
  };
  const clientMock = {
    isConfigured: () => opts.isConfigured ?? true,
    streamTextSuggestion: make('streamTextSuggestion'),
    streamTextEnhancement: make('streamTextEnhancement')
  };
  t.mock.module('../services/ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: clientMock } });
  const accountType = opts.accountType === undefined ? 'PROVIDER_INDIVIDUAL' : opts.accountType;
  t.mock.module('../config/db', {
    namedExports: { prisma: { user: { findUnique: async () => (accountType === null ? null : { accountType }) } } }
  });
  const mod = await import(`./ai-review.gateway.ts?fixture=${Date.now()}-${Math.random()}`);
  const register = mod.registerAiReviewGateway as (socket: any) => void;
  return Object.assign(register, { calls });
}

const TITLE = 'تطوير متجر إلكتروني متكامل';

// ── auth / role ──────────────────────────────────────────────────────────

test('suggest: unauthenticated socket is rejected without calling WaseetAI', async (t) => {
  const register = await loadGateway(t);
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE });
  assert.equal(register.calls.length, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
  assert.match(emitted[0].payload.message, /تسجيل الدخول/);
});

test('enhance: unauthenticated socket is rejected without calling WaseetAI', async (t) => {
  const register = await loadGateway(t);
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);
  await handlers['stream_ai_enhance_description']({ description: 'وصف مبدئي' });
  assert.equal(register.calls.length, 0);
  assert.match(emitted[0].payload.message, /تسجيل الدخول/);
});

for (const accountType of ['CLIENT_INDIVIDUAL', 'CLIENT_COMPANY', null]) {
  test(`both events: account ${accountType} (not a provider) is rejected without calling WaseetAI`, async (t) => {
    const register = await loadGateway(t, { accountType });
    const { socket, handlers, emitted } = createMockSocket({ userId: 'user-2' });
    register(socket);
    await handlers['stream_ai_suggest_text']({ title: TITLE });
    await handlers['stream_ai_enhance_description']({ description: 'وصف مبدئي' });
    assert.equal(register.calls.length, 0);
    assert.equal(emitted.length, 2);
    for (const e of emitted) assert.match(e.payload.message, /مقدمي الخدمة/);
  });
}

for (const accountType of ['PROVIDER_INDIVIDUAL', 'PROVIDER_COMPANY']) {
  test(`both events: ${accountType} reaches WaseetAI`, async (t) => {
    const register = await loadGateway(t, { accountType });
    const { socket, handlers } = createMockSocket({ userId: 'user-1' });
    register(socket);
    await handlers['stream_ai_suggest_text']({ title: TITLE });
    await handlers['stream_ai_enhance_description']({ description: 'وصف مبدئي' });
    assert.deepEqual(register.calls.map((c) => c.method), ['streamTextSuggestion', 'streamTextEnhancement']);
  });
}

// ── validation ───────────────────────────────────────────────────────────

test('suggest: a vague title is rejected before calling WaseetAI', async (t) => {
  const register = await loadGateway(t);
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: 'aaaaaaaa' });
  assert.equal(register.calls.length, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
});

test('enhance: empty description is rejected (title alone is not sent) without calling WaseetAI', async (t) => {
  const register = await loadGateway(t);
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_enhance_description']({ title: TITLE, description: '   ' });
  assert.equal(register.calls.length, 0);
  assert.equal(emitted.length, 1);
  assert.match(emitted[0].payload.message, /وصف/);
});

test('enhance: a vague title still fails the deterministic check', async (t) => {
  const register = await loadGateway(t);
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_enhance_description']({ title: 'aaaaaaaa', description: 'وصف مبدئي' });
  assert.equal(register.calls.length, 0);
  assert.equal(emitted[0].event, 'ai_text_stream_end');
});

test('both events: the 31st request within the window is rate-limited without calling WaseetAI', async (t) => {
  const register = await loadGateway(t);
  const { socket, handlers, emitted } = createMockSocket({ userId: 'rate-limit-user' });
  register(socket);
  for (let i = 0; i < 30; i++) await handlers['stream_ai_suggest_text']({ title: TITLE });
  assert.equal(register.calls.length, 30);
  emitted.length = 0;
  await handlers['stream_ai_suggest_text']({ title: TITLE });
  await handlers['stream_ai_enhance_description']({ description: 'وصف مبدئي' });
  assert.equal(register.calls.length, 30);
  assert.equal(emitted.length, 2);
  for (const e of emitted) assert.match(e.payload.message, /تجاوز الحد/);
});

// ── success mapping ──────────────────────────────────────────────────────

test('suggest: sends ONLY { title } and relays deltas in order on the existing events', async (t) => {
  const register = await loadGateway(t, { stream: () => fakeStream(okEvents(['أهلاً ', 'وسهلاً ', 'بكم'])) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: `  ${TITLE}  `, description: 'extra', specialty: 'x' });

  assert.deepEqual(register.calls[0].body, { title: TITLE });
  assert.deepEqual(emitted.map((e) => e.event), ['ai_text_stream_start', 'ai_text_stream_chunk', 'ai_text_stream_chunk', 'ai_text_stream_chunk', 'ai_text_stream_end']);
  assert.deepEqual(emitted.filter((e) => e.event === 'ai_text_stream_chunk').map((e) => e.payload.chunk), ['أهلاً ', 'وسهلاً ', 'بكم']);
  assert.ok(emitted.every((e) => e.payload.mode === 'suggest'));
  assert.match(emitted[4].payload.message, /اكتمل/);
});

test('enhance: sends ONLY { description } (title is not forwarded) with mode improve', async (t) => {
  const register = await loadGateway(t);
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_enhance_description']({ title: TITLE, description: '  وصف مبدئي  ' });

  assert.equal(register.calls[0].method, 'streamTextEnhancement');
  assert.deepEqual(register.calls[0].body, { description: 'وصف مبدئي' });
  assert.ok(emitted.every((e) => e.payload.mode === 'improve'));
  assert.equal(emitted[emitted.length - 1].event, 'ai_text_stream_end');
  assert.match(emitted[emitted.length - 1].payload.message, /تم تحسين/);
});

test('streaming is real: each delta is emitted before the next one is requested', async (t) => {
  const seen: string[] = [];
  let emittedAtSecondPull = -1;
  const register = await loadGateway(t, {
    stream: () => (async function* () {
      yield delta('أول');
      emittedAtSecondPull = seen.length;
      yield delta('ثاني');
      yield { type: 'completed' } as WaseetAiStreamEvent;
    })()
  });
  const { socket, handlers } = createMockSocket({ userId: 'user-1' });
  const origEmit = socket.emit;
  socket.emit = (e: string, p: any) => { if (e === 'ai_text_stream_chunk') seen.push(p.chunk); origEmit(e, p); };
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE });
  assert.equal(emittedAtSecondPull, 1, 'first chunk must already be on the socket when the second is pulled');
});

// ── failures ─────────────────────────────────────────────────────────────

test('suggest: upstream failure before any chunk -> honest ai_text_stream_end, no chunk, no upstream text', async (t) => {
  const SECRET = 'UPSTREAM-SECRET-DETAIL';
  const register = await loadGateway(t, {
    stream: () => fakeStream([delta('x')], { throwAfter: 0, error: new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, SECRET, { status: 502 }) })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE });
  assert.ok(!emitted.some((e) => e.event === 'ai_text_stream_chunk'));
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai_text_stream_end');
  assert.match(last.payload.message, /تعذر/);
  assert.ok(!JSON.stringify(emitted).includes(SECRET));
});

test('enhance: mid-stream failure ends with the failure message, never the success message', async (t) => {
  const register = await loadGateway(t, {
    stream: () => fakeStream(okEvents(['جزء أول ', 'x']), { throwAfter: 2, error: new Error('boom') })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_enhance_description']({ description: 'وصف مبدئي' });
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'ai_text_stream_end');
  assert.match(last.payload.message, /تعذر/);
  assert.doesNotMatch(last.payload.message, /تم تحسين/);
});

test('timeout maps to the timeout message', async (t) => {
  const register = await loadGateway(t, {
    stream: () => fakeStream([delta('x')], { throwAfter: 0, error: new WaseetAiError(WaseetAiErrorCode.TIMEOUT, 'timeout') })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE });
  assert.match(emitted[emitted.length - 1].payload.message, /مهلة/);
});

test('a stream that completes with no text is a failure, not a silent success', async (t) => {
  const register = await loadGateway(t, { stream: () => fakeStream([{ type: 'started' }, { type: 'completed' }]) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE });
  assert.match(emitted[emitted.length - 1].payload.message, /تعذر/);
});

test('a stream that ends without a completed event is a failure', async (t) => {
  const register = await loadGateway(t, { stream: () => fakeStream([delta('نص')]) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_enhance_description']({ description: 'وصف مبدئي' });
  assert.match(emitted[emitted.length - 1].payload.message, /تعذر/);
});

test('WaseetAI not configured -> honest message before any call', async (t) => {
  const register = await loadGateway(t, { isConfigured: false });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE });
  assert.equal(register.calls.length, 0);
  assert.equal(emitted.length, 1);
  assert.match(emitted[0].payload.message, /غير مهيأة/);
});

// ── abort ────────────────────────────────────────────────────────────────

test('socket disconnect aborts the in-flight upstream stream and emits nothing further', async (t) => {
  let signal: AbortSignal | undefined;
  const register = await loadGateway(t, {
    stream: (call) => {
      signal = call.opts.signal;
      return (async function* () {
        yield delta('أول');
        await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve()));
        const e: any = new Error('aborted'); e.name = 'AbortError'; throw e;
      })();
    }
  });
  const { socket, handlers, emitted, triggerDisconnect, onceHandlers } = createMockSocket({ userId: 'user-1' });
  register(socket);
  const running = handlers['stream_ai_suggest_text']({ title: TITLE });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(signal?.aborted, false);
  triggerDisconnect();
  await running;
  assert.equal(signal?.aborted, true);
  assert.deepEqual(emitted.map((e) => e.event), ['ai_text_stream_start', 'ai_text_stream_chunk']);
  assert.equal((onceHandlers['disconnect'] || []).length, 0, 'disconnect listener is cleaned up');
});

// ── static ───────────────────────────────────────────────────────────────

test('the gateway has no direct-Gemini dependency', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./ai-review.gateway.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gemini\.client|geminiClient|generateStructured|generateStream/);
});
