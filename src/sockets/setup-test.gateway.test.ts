import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();
import { GeminiErrorCode, GeminiProviderError } from '../services/ai/gemini/gemini.errors';
import { SETUP_TEST_QUESTION_COUNT } from '../prompts/setup-test.prompt';

// AI-16 (setup_test:init) — OpenAI migration batch. Previously called
// OpenAI gpt-4o-mini directly with no rate limiting, no disconnect
// cancellation, and no validation of the returned question shape beyond
// "is it a non-empty array". `prisma` and `geminiClient` are mocked; no
// real DB/network call ever happens.

function signToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, process.env.JWT_SECRET!);
}

function createMockSocket(id = 'socket-test-1') {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];

  const socket: any = {
    id,
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    once: (event: string, handler: (...args: any[]) => any) => { (onceHandlers[event] ||= []).push(handler); },
    off: (event: string, handler?: (...args: any[]) => any) => {
      if (!onceHandlers[event]) return;
      onceHandlers[event] = handler ? onceHandlers[event].filter((h) => h !== handler) : [];
    },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); }
  };

  return { socket, handlers, emitted, triggerDisconnect: () => { (onceHandlers['disconnect'] || []).forEach((h) => h()); } };
}

function validQuestions(count = SETUP_TEST_QUESTION_COUNT) {
  return Array.from({ length: count }, (_, i) => ({
    id: `q${i + 1}`,
    subSpecialtyTag: 'تطوير الويب',
    text: `سؤال رقم ${i + 1}؟`,
    options: ['أ', 'ب', 'ج', 'د'],
    correctOptionIndex: 1,
    explanation: 'تفسير حقيقي'
  }));
}

async function loadGateway(t: TestContext, opts: {
  profile?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
} = {}) {
  const updateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const defaultProfile = { id: 'profile-1', userId: 'user-1', mainSpecialty: 'تطوير الويب', industry: null, subSpecialties: ['Frontend'], setupTestStatus: 'PENDING', setupTestBannedUntil: null };
  const prismaMock: any = {
    providerProfile: {
      findUnique: async () => (opts.profile === undefined ? defaultProfile : opts.profile),
      update: updateSpy
    }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async (_prompt: string, options: any) => {
      const valid = { questions: validQuestions() };
      assert.equal(options.validate(valid), true, 'the real validator must accept a well-formed 15-question payload');
      return { data: valid, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const moduleUrl = `./setup-test.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { register: mod.registerSetupTestGateway as (socket: any) => void, updateSpy };
}

// ── authenticated success ─────────────────────────────────────────────────

test('setup_test:init — a real validated Gemini result of exactly 15 questions is used', async (t) => {
  const { register } = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });

  const readyEvent = emitted.find((e) => e.event === 'setup_test:ready');
  assert.ok(readyEvent);
  assert.equal(readyEvent!.payload.totalQuestions, SETUP_TEST_QUESTION_COUNT);
});

// ── auth failures ──────────────────────────────────────────────────────────

test('setup_test:init — an invalid/expired token is rejected with an honest error, never a fake test', async (t) => {
  const { register } = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: 'not-a-real-jwt' });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'setup_test:error');
});

test('setup_test:init — a missing provider profile is rejected honestly', async (t) => {
  const { register } = await loadGateway(t, { profile: null });
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'setup_test:error');
});

// ── Gemini failure paths → honest STATIC_FALLBACK, never a fake AI result ──

test('setup_test:init — Gemini unavailable falls back to the static 15-question bank, not an empty/fake test', async (t) => {
  const { register } = await loadGateway(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });

  const readyEvent = emitted.find((e) => e.event === 'setup_test:ready');
  assert.ok(readyEvent);
  assert.equal(readyEvent!.payload.totalQuestions, 15);
});

test('setup_test:init — Gemini not configured falls back to the static bank the same way', async (t) => {
  const { register } = await loadGateway(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.NOT_CONFIGURED, 'GEMINI_API_KEY is not configured'); }
  });
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });

  assert.equal(emitted.find((e) => e.event === 'setup_test:ready')!.payload.totalQuestions, 15);
});

test('setup_test:init — a Gemini timeout falls back to the static bank', async (t) => {
  const { register } = await loadGateway(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.TIMEOUT, 'timed out'); }
  });
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });

  assert.equal(emitted.find((e) => e.event === 'setup_test:ready')!.payload.totalQuestions, 15);
});

test('setup_test:init — a malformed Gemini result (wrong question count) is rejected by the validator and falls back honestly', async (t) => {
  const { register } = await loadGateway(t, {
    generateStructured: async (_prompt, options) => {
      const malformed = { questions: validQuestions(5) };
      assert.equal(options.validate(malformed), false, 'the validator must reject a wrong question count');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });

  assert.equal(emitted.find((e) => e.event === 'setup_test:ready')!.payload.totalQuestions, 15);
});

test('setup_test:init — a malformed Gemini result (duplicate question ids) is rejected by the validator', async (t) => {
  const { register } = await loadGateway(t, {
    generateStructured: async (_prompt, options) => {
      const questions = validQuestions();
      questions[1] = { ...questions[1], id: questions[0].id };
      const malformed = { questions };
      assert.equal(options.validate(malformed), false, 'the validator must reject duplicate ids');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });

  assert.equal(emitted.find((e) => e.event === 'setup_test:ready')!.payload.totalQuestions, 15);
});

test('setup_test:init — a malformed Gemini result (out-of-range correctOptionIndex) is rejected by the validator', async (t) => {
  const { register } = await loadGateway(t, {
    generateStructured: async (_prompt, options) => {
      const questions = validQuestions();
      questions[0] = { ...questions[0], correctOptionIndex: 7 };
      const malformed = { questions };
      assert.equal(options.validate(malformed), false, 'the validator must reject an out-of-range correctOptionIndex');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);

  await handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });

  assert.equal(emitted.find((e) => e.event === 'setup_test:ready')!.payload.totalQuestions, 15);
});

// ── rate limiting ──────────────────────────────────────────────────────────

test('setup_test:init — more than 30 requests within the window is rate-limited on the next one', async (t) => {
  const uniqueUserId = `rate-limit-user-${Date.now()}-${Math.random()}`;
  const { register } = await loadGateway(t, {
    profile: { id: 'profile-x', userId: uniqueUserId, mainSpecialty: 'تطوير الويب', industry: null, subSpecialties: ['Frontend'], setupTestStatus: 'PENDING', setupTestBannedUntil: null }
  });
  const { socket, handlers, emitted } = createMockSocket();
  register(socket);
  const token = signToken({ userId: uniqueUserId });

  for (let i = 0; i < 30; i++) {
    await handlers['setup_test:init']({ token });
  }
  emitted.length = 0;

  await handlers['setup_test:init']({ token });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'setup_test:error');
});

// ── disconnect cancellation ────────────────────────────────────────────────

test('setup_test:init — a socket disconnect aborts the in-flight Gemini generation', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const { register } = await loadGateway(t, {
    generateStructured: (_prompt, options) => {
      capturedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const rejectAborted = () => {
          const err: any = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (options.signal?.aborted) rejectAborted();
        else options.signal?.addEventListener('abort', rejectAborted);
      });
    }
  });
  const { socket, handlers, emitted, triggerDisconnect } = createMockSocket();
  register(socket);

  const handlerPromise = handlers['setup_test:init']({ token: signToken({ userId: 'user-1' }) });
  triggerDisconnect();
  await handlerPromise;

  assert.ok(capturedSignal, 'a signal must be passed to generateStructured');
  assert.equal(capturedSignal!.aborted, true);
  // Falls back to the static bank instead of hanging or crashing.
  assert.equal(emitted.find((e) => e.event === 'setup_test:ready')!.payload.totalQuestions, 15);
});
