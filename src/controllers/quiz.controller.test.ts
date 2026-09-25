import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from '../services/ai/gemini/gemini.errors';
import { DYNAMIC_QUIZ_QUESTION_COUNT } from '../prompts/quiz.prompt';

// AI-17 (initSpecialtyQuiz's background Gemini refinement) — OpenAI
// migration batch. Previously fired a raw `openai.chat.completions.create`
// with NO shape validation at all before writing straight to the DB (only
// checked `questions.length === 20`) — a malformed provider response could
// corrupt the persisted quiz. Only this background-refinement behavior is
// under test here; the REST init flow's DB/static-fallback question
// selection, session resumption, and lockout logic are pre-existing and
// unchanged. `prisma`, `geminiClient`, and `assessmentService` are all
// mocked; no real DB/network call ever happens.

function createMockRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

function providerSpecialtyFixture(overrides: Partial<any> = {}) {
  return {
    id: 'spec-1',
    specialtyId: 'specialty-1',
    subSpecialties: ['Frontend', 'Backend'],
    lockoutUntil: null,
    status: 'PENDING',
    specialty: { nameAr: 'تطوير الويب', name: 'Web Dev' },
    providerProfile: { user: { id: 'user-1', email: 'p@example.com' } },
    testSessions: [],
    ...overrides
  };
}

function validQuestions(count = DYNAMIC_QUIZ_QUESTION_COUNT) {
  return Array.from({ length: count }, (_, i) => ({
    id: `q${i + 1}`,
    subSpecialtyTag: 'Frontend',
    text: `سؤال رقم ${i + 1}؟`,
    options: ['أ', 'ب', 'ج', 'د'],
    correctOptionIndex: 1,
    explanation: 'تفسير حقيقي'
  }));
}

// Flushes the microtask queue enough times for the fire-and-forget
// `.then()/.catch()` continuation on the background Gemini call to run to
// completion after the HTTP response has already been sent.
async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function loadController(t: TestContext, opts: {
  providerSpecialty?: any;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
} = {}) {
  const createSpy = t.mock.fn(async (args: any) => ({ id: 'session-1', ...args.data }));
  const updateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const prismaMock: any = {
    providerSpecialty: {
      findUnique: async () => (opts.providerSpecialty === undefined ? providerSpecialtyFixture() : opts.providerSpecialty)
    },
    specialtyTestSession: {
      create: createSpy,
      update: updateSpy
    }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async (_prompt: string, options: any) => {
      const valid = { questions: validQuestions() };
      assert.equal(options.validate(valid), true, 'the real validator must accept a well-formed 20-question payload');
      return { data: valid, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  t.mock.module('../services/assessment.service', { namedExports: { assessmentService: { generateUniqueQuiz: async () => [] } } });
  t.mock.module('../socket', { namedExports: { ioInstance: null } });

  const moduleUrl = `./quiz.controller.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { initSpecialtyQuiz: mod.initSpecialtyQuiz as (req: any, res: any) => Promise<void>, createSpy, updateSpy };
}

function makeReq(overrides: Partial<any> = {}) {
  return { params: { id: 'spec-1' }, user: { id: 'user-1' }, body: {}, ...overrides };
}

// ── real validated Gemini success ───────────────────────────────────────

test('initSpecialtyQuiz: a real validated 20-question Gemini result silently replaces the persisted questionsPayload', async (t) => {
  const { initSpecialtyQuiz, updateSpy } = await loadController(t, {});
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);
  assert.equal(res.statusCode, 201);
  await flushMicrotasks();

  assert.equal(updateSpy.mock.callCount(), 1);
  const updateArgs = updateSpy.mock.calls[0].arguments[0];
  assert.equal(updateArgs.data.questionsPayload.questions.length, DYNAMIC_QUIZ_QUESTION_COUNT);
  assert.equal(updateArgs.data.questionsPayload.totalQuestions, DYNAMIC_QUIZ_QUESTION_COUNT);
});

// ── malformed/failed Gemini never corrupts the persisted quiz ───────────

test('initSpecialtyQuiz: Gemini provider unavailable never touches the persisted questionsPayload', async (t) => {
  const { initSpecialtyQuiz, updateSpy } = await loadController(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);
  assert.equal(res.statusCode, 201);
  await flushMicrotasks();

  assert.equal(updateSpy.mock.callCount(), 0, 'a failed background refinement must never write to the DB');
});

test('initSpecialtyQuiz: Gemini not configured never touches the persisted questionsPayload', async (t) => {
  const { initSpecialtyQuiz, updateSpy } = await loadController(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.NOT_CONFIGURED, 'GEMINI_API_KEY is not configured'); }
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);
  await flushMicrotasks();

  assert.equal(updateSpy.mock.callCount(), 0);
});

test('initSpecialtyQuiz: a Gemini timeout never touches the persisted questionsPayload', async (t) => {
  const { initSpecialtyQuiz, updateSpy } = await loadController(t, {
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.TIMEOUT, 'timed out'); }
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);
  await flushMicrotasks();

  assert.equal(updateSpy.mock.callCount(), 0);
});

test('initSpecialtyQuiz: a malformed Gemini result (wrong question count) is rejected by the validator and never persisted — this is the confirmed gap the previous OpenAI path had (only checked length === 20, no per-question shape validation)', async (t) => {
  const { initSpecialtyQuiz, updateSpy } = await loadController(t, {
    generateStructured: async (_prompt, options) => {
      const malformed = { questions: validQuestions(5) };
      assert.equal(options.validate(malformed), false, 'the validator must reject a wrong question count');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);
  await flushMicrotasks();

  assert.equal(updateSpy.mock.callCount(), 0);
});

test('initSpecialtyQuiz: a malformed Gemini result (invalid correctOptionIndex) is rejected by the validator and never persisted', async (t) => {
  const { initSpecialtyQuiz, updateSpy } = await loadController(t, {
    generateStructured: async (_prompt, options) => {
      const questions = validQuestions();
      questions[0] = { ...questions[0], correctOptionIndex: 9 };
      const malformed = { questions };
      assert.equal(options.validate(malformed), false, 'the validator must reject an out-of-range correctOptionIndex');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);
  await flushMicrotasks();

  assert.equal(updateSpy.mock.callCount(), 0);
});

test('initSpecialtyQuiz: a malformed Gemini result (duplicate question ids) is rejected by the validator and never persisted', async (t) => {
  const { initSpecialtyQuiz, updateSpy } = await loadController(t, {
    generateStructured: async (_prompt, options) => {
      const questions = validQuestions();
      questions[1] = { ...questions[1], id: questions[0].id };
      const malformed = { questions };
      assert.equal(options.validate(malformed), false, 'the validator must reject duplicate ids');
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'invalid');
    }
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);
  await flushMicrotasks();

  assert.equal(updateSpy.mock.callCount(), 0);
});

// ── the HTTP response never waits on the Gemini call (fire-and-forget) ──

test('initSpecialtyQuiz: the HTTP response is sent immediately with an empty questions array, never blocked on the Gemini call', async (t) => {
  let resolveGemini: (() => void) | null = null;
  const { initSpecialtyQuiz } = await loadController(t, {
    generateStructured: () => new Promise((resolve) => {
      resolveGemini = () => resolve({ data: { questions: validQuestions() }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    })
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.data.questions, []);
  assert.equal(res.body.data.isStreaming, true);
  resolveGemini!();
});

// ── auth ─────────────────────────────────────────────────────────────────

test('initSpecialtyQuiz: an unauthenticated request is rejected before any Gemini call is attempted', async (t) => {
  let called = false;
  const { initSpecialtyQuiz } = await loadController(t, {
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq({ user: undefined }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test('initSpecialtyQuiz: a locked-out specialty is rejected before any Gemini call is attempted', async (t) => {
  let called = false;
  const { initSpecialtyQuiz } = await loadController(t, {
    providerSpecialty: providerSpecialtyFixture({ lockoutUntil: new Date(Date.now() + 60_000) }),
    generateStructured: async () => { called = true; throw new Error('should never be called'); }
  });
  const res = createMockRes();

  await initSpecialtyQuiz(makeReq(), res);

  assert.equal(res.statusCode, 403);
  assert.equal(called, false);
});
