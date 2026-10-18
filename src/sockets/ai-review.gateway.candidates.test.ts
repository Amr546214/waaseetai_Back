import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WaseetAiError, WaseetAiErrorCode } from '../services/ai/waseet-ai/waseet-ai.errors';
import type { WaseetAiStreamEvent } from '../services/ai/waseet-ai/waseet-ai.types';

// G1: description AI output validation (limit, discrete candidates, failure state, request ids). WaseetAI is mocked; no network.
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
  activeRole?: string | null;
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
    namedExports: { prisma: { user: { findUnique: async () => (accountType === null ? null : { accountType, activeRole: opts.activeRole ?? undefined }) } } }
  });
  const mod = await import(`./ai-review.gateway.ts?fixture=${Date.now()}-${Math.random()}`);
  const register = mod.registerAiReviewGateway as (socket: any) => void;
  return Object.assign(register, { calls });
}

const TITLE = 'تطوير متجر إلكتروني متكامل';


const LIMIT = 1500;
const sentences = (n: number, w = 'نبني لك متجراً إلكترونياً متكاملاً مع لوحة تحكم وتقارير مبيعات') => Array.from({ length: n }, (_, i) => `${w} رقم ${i + 1}.`).join(' ');
const endOf = (emitted: any[]) => emitted.filter(e => e.event === 'ai_text_stream_end').map(e => e.payload);

test('over-limit reply (3091 chars) is never announced as a valid result: it is cut at a complete sentence <= limit', async (t) => {
  const long = sentences(60);
  assert.ok(long.length > 3000);
  const register = await loadGateway(t, { stream: () => fakeStream(okEvents([long.slice(0, 1000), long.slice(1000, 2000), long.slice(2000)])) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'u1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE, requestId: 'r1' });
  const [end] = endOf(emitted);
  assert.equal(end.error, undefined);
  assert.equal(end.limit, LIMIT);
  assert.equal(end.requestId, 'r1');
  assert.equal(end.candidates.length, 1);
  const c = end.candidates[0];
  assert.ok(c.length <= LIMIT && c.length === c.text.length, `length ${c.length}`);
  assert.equal(c.trimmed, true);
  assert.ok(c.text.endsWith('.'), 'cut only at a sentence end');
  assert.ok(/رقم \d+\.$/.test(c.text), 'last sentence is complete');
});

test('over-limit reply with no sentence boundary at all is an honest OUTPUT_TOO_LONG error, never an approvable result', async (t) => {
  const blob = 'كلمة '.repeat(700); // 3500 chars, no terminator
  const register = await loadGateway(t, { stream: () => fakeStream(okEvents([blob])) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'u1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE, requestId: 'r2' });
  const ends = endOf(emitted);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].error, true);
  assert.equal(ends[0].code, 'OUTPUT_TOO_LONG');
  assert.equal(ends[0].candidates, undefined);
  assert.equal(ends[0].requestId, 'r2');
});

test('alternatives become separate candidates; the introduction and the closing advice are dropped', async (t) => {
  const reply = `بالتأكيد، إليك ثلاث صياغات للوصف:\n\n## الخيار الأول\nأطوّر لك متجراً إلكترونياً كاملاً بتصميم متجاوب. أسلّمه على مراحل واضحة.\n\n## الخيار الثاني\nخدمة متكاملة لبناء متجرك مع الدفع والشحن. تشمل الدعم بعد التسليم.\n\n## نصائح\nاختر الصياغة الأنسب لك.`;
  const register = await loadGateway(t, { stream: () => fakeStream(okEvents([reply.slice(0, 80), reply.slice(80)])) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'u1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE });
  const [end] = endOf(emitted);
  assert.equal(end.candidates.length, 2);
  assert.deepEqual(end.candidates.map((c: any) => c.id), ['option-1', 'option-2']);
  const all = end.candidates.map((c: any) => c.text).join('\n');
  assert.ok(!all.includes('إليك'), 'no introduction');
  assert.ok(!all.includes('نصائح') && !all.includes('اختر الصياغة'), 'no advice');
  assert.ok(!all.includes('#') && !all.includes('الخيار'), 'no headings or markup');
  assert.ok(end.candidates.every((c: any) => c.length <= LIMIT));
});

test('stream disconnect mid-way: no end, no candidates (the page keeps the user text)', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const register = await loadGateway(t, { stream: () => (async function* () { yield delta('بداية '); await gate; yield delta('نهاية.'); yield { type: 'completed' } as WaseetAiStreamEvent; })() });
  const { socket, handlers, emitted, triggerDisconnect } = createMockSocket({ userId: 'u1' });
  register(socket);
  const running = handlers['stream_ai_suggest_text']({ title: TITLE, requestId: 'r3' });
  await new Promise(r => setImmediate(r));
  triggerDisconnect();
  release();
  await running;
  assert.equal(endOf(emitted).length, 0);
});

test('upstream stream that ends without a completion event after text streamed: error end, no candidates', async (t) => {
  const register = await loadGateway(t, { stream: () => fakeStream([{ type: 'started' }, delta(sentences(10))]) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'u1' });
  register(socket);
  await handlers['stream_ai_suggest_text']({ title: TITLE, requestId: 'r4' });
  assert.ok(emitted.some(e => e.event === 'ai_text_stream_chunk'), 'text did stream');
  const [end] = endOf(emitted);
  assert.equal(end.error, true);
  assert.equal(end.code, 'FAILED');
  assert.equal(end.candidates, undefined);
});

test('every event echoes the request id; a new request supersedes the running one, which emits nothing more', async (t) => {
  let n = 0;
  const gates: Array<() => void> = [];
  const register = await loadGateway(t, {
    stream: (call) => {
      const mine = ++n;
      return (async function* () {
        yield delta(`الأول ${mine} `);
        if (mine === 1) await new Promise<void>(r => gates.push(r));
        yield delta(`جملة كاملة ${mine}.`);
        yield { type: 'completed' } as WaseetAiStreamEvent;
      })();
    },
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'u1' });
  register(socket);
  const first = handlers['stream_ai_suggest_text']({ title: TITLE, requestId: 'old' });
  await new Promise(r => setImmediate(r));
  const second = handlers['stream_ai_suggest_text']({ title: TITLE, requestId: 'new' });
  gates.forEach(g => g());
  await Promise.all([first, second]);
  const ends = endOf(emitted);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].requestId, 'new');
  assert.ok(emitted.filter(e => e.payload?.requestId === 'old').every(e => e.event === 'ai_text_stream_start' || e.event === 'ai_text_stream_chunk'));
  assert.ok(!emitted.some(e => e.payload?.requestId === 'old' && e.event === 'ai_text_stream_end'));
});

test('ai_text_stream_cancel stops the running stream silently', async (t) => {
  const gates: Array<() => void> = [];
  const register = await loadGateway(t, { stream: () => (async function* () { yield delta('بداية '); await new Promise<void>(r => gates.push(r)); yield delta('نهاية.'); yield { type: 'completed' } as WaseetAiStreamEvent; })() });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'u1' });
  register(socket);
  const running = handlers['stream_ai_suggest_text']({ title: TITLE, requestId: 'c1' });
  await new Promise(r => setImmediate(r));
  handlers['ai_text_stream_cancel']({ requestId: 'c1' });
  gates.forEach(g => g());
  await running;
  assert.equal(endOf(emitted).length, 0);
});

test('seeded enhance (empty-field generation): same enhance endpoint, seed sent as description, candidates flagged fromContext with unmentioned specifics', async (t) => {
  const seed = 'تعليمات...\nالبيانات المقدمة:\nعنوان المشروع: تطوير متجر إلكتروني متكامل\nالمهارات: React';
  const reply = 'مباشر وواضح\n\nنطوّر متجراً إلكترونياً باستخدام React خلال 30 يوماً بسعر 500 دولار.\n\nاحترافي\n\nنطوّر متجراً إلكترونياً متكاملاً وتُحدد التفاصيل بالاتفاق.';
  const register = await loadGateway(t, { stream: () => fakeStream(okEvents([reply])) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'u1' });
  register(socket);
  await handlers['stream_ai_enhance_description']({ title: TITLE, description: seed, seeded: true, requestId: 's1' });
  assert.equal((register as any).calls[0].method, 'streamTextEnhancement');
  assert.deepEqual((register as any).calls[0].body, { description: seed });
  const [end] = endOf(emitted);
  assert.equal(end.fromContext, true);
  assert.equal(end.candidates.length, 2);
  assert.deepEqual(end.candidates[0].unmentioned.sort(), ['30', '500']);
  assert.equal(end.candidates[1].unmentioned, undefined);
  assert.ok(end.candidates.every((c: any) => !c.text.includes('البيانات المقدمة')));
});

test('a normal (non-seeded) improve request carries no fromContext / unmentioned flags', async (t) => {
  const register = await loadGateway(t, { stream: () => fakeStream(okEvents(['وصف محسن كامل يحتوي 30 يوماً.'])) });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'u1' });
  register(socket);
  await handlers['stream_ai_enhance_description']({ title: TITLE, description: 'وصف أصلي كتبه المستخدم' });
  const [end] = endOf(emitted);
  assert.equal(end.fromContext, undefined);
  assert.equal(end.candidates[0].unmentioned, undefined);
});
