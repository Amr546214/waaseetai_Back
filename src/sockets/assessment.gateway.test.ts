import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// F14 (assessment.gateway.ts) — Batch: F12+F13+F14 assessment pipeline
// migration to the shared Gemini foundation. Same plain-mock-socket
// convention as ai-review.gateway.test.ts / proposal-audit.gateway.test.ts.
// `prisma`, `geminiClient`, and `aiAssessmentAnalyzerService` are all
// mocked; no real DB/network call happens.

function createMockSocket(opts: { userId?: string } = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const rooms: string[] = [];

  const socket: any = {
    id: 'socket-test-1',
    userId: opts.userId,
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    once: (event: string, handler: (...args: any[]) => any) => { (onceHandlers[event] ||= []).push(handler); },
    off: (event: string, handler?: (...args: any[]) => any) => {
      if (!onceHandlers[event]) return;
      onceHandlers[event] = handler ? onceHandlers[event].filter((h) => h !== handler) : [];
    },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); },
    join: (room: string) => { rooms.push(room); }
  };

  return {
    socket,
    handlers,
    emitted,
    triggerDisconnect: () => { (onceHandlers['disconnect'] || []).forEach((h) => h()); }
  };
}

function validQuestion(id: number) {
  return {
    id,
    textAr: `سؤال ${id}`,
    options: [{ id: 'a', text: 'أ' }, { id: 'b', text: 'ب' }, { id: 'c', text: 'ج' }, { id: 'd', text: 'د' }],
    correctAnswer: 'b',
    explanation: 'شرح',
    assessmentArea: 'التخصص الرئيسي'
  };
}

async function loadGateway(t: TestContext, opts: {
  providerSpecialty?: any;
  attempt?: any;
  createSpy?: any;
  generate20Questions?: (input: any) => Promise<any>;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const createSpy = opts.createSpy ?? t.mock.fn(async (args: any) => ({ id: 'attempt-abc-123', ...args.data }));
  const updateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const tx = {
    assessmentAttempt: { update: updateSpy },
    providerSpecialty: { update: updateSpy }
  };
  const prismaMock: any = {
    providerSpecialty: { findFirst: async () => (opts.providerSpecialty === undefined ? { id: 'spec-1', specialtyId: 'specialty-1', providerProfileId: 'profile-1', subSpecialties: [] } : opts.providerSpecialty) },
    assessmentAttempt: {
      create: createSpy,
      update: updateSpy,
      findFirst: async () => (opts.attempt === undefined ? null : opts.attempt)
    },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const analyzerMock = {
    generate20Questions: opts.generate20Questions ?? (async () => ({
      questions: Array.from({ length: 20 }, (_, i) => validQuestion(i + 1)),
      subSpecialtiesSnapshot: [],
      analyzedAssetsSnapshot: [],
      generationSource: 'GEMINI'
    })),
    generateFallback20Questions: () => Array.from({ length: 20 }, (_, i) => validQuestion(i + 1))
  };
  t.mock.module('../services/ai-assessment-analyzer.service', { namedExports: { aiAssessmentAnalyzerService: analyzerMock } });

  const moduleUrl = `./assessment.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { register: mod.registerAssessmentGateway as (socket: any) => void, createSpy, updateSpy };
}

const START_PAYLOAD = { providerSpecialtyId: 'spec-1', specialtyId: 'specialty-1' };

// ── auth / ownership ─────────────────────────────────────────────────────

test('start_assessment: an unauthenticated socket (no userId) is rejected without calling the analyzer', async (t) => {
  let called = false;
  const { register } = await loadGateway(t, { generate20Questions: async () => { called = true; throw new Error('should never be called'); } });
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  assert.equal(called, false);
  assert.equal(emitted[0].event, 'assessment_error');
});

test('start_assessment: a providerSpecialty not owned by the caller is rejected', async (t) => {
  const { register } = await loadGateway(t, { providerSpecialty: null });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  assert.equal(emitted[emitted.length - 1].event, 'assessment_error');
});

// ── successful ordered flow ────────────────────────────────────────────────

test('start_assessment: a real validated Gemini generation streams all 20 questions in order then assessment_ready with generationSource GEMINI', async (t) => {
  const { register, createSpy } = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  const streamed = emitted.filter((e) => e.event === 'question_streamed');
  assert.equal(streamed.length, 20);
  assert.deepEqual(streamed.map((e) => e.payload.questionIndex), Array.from({ length: 20 }, (_, i) => i + 1));

  const ready = emitted.find((e) => e.event === 'assessment_ready');
  assert.ok(ready);
  assert.equal(ready!.payload.generationSource, 'GEMINI');

  const createArgs = createSpy.mock.calls[0].arguments[0].data;
  assert.equal(createArgs.analyzedAssetsSnapshot.generationSource, 'GEMINI');
});

test('start_assessment: a static-fallback generation is honestly reported in assessment_ready', async (t) => {
  const { register } = await loadGateway(t, {
    generate20Questions: async () => ({
      questions: Array.from({ length: 20 }, (_, i) => validQuestion(i + 1)),
      subSpecialtiesSnapshot: [],
      analyzedAssetsSnapshot: [],
      generationSource: 'STATIC_FALLBACK'
    })
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  const ready = emitted.find((e) => e.event === 'assessment_ready');
  assert.equal(ready!.payload.generationSource, 'STATIC_FALLBACK');
  assert.doesNotMatch(ready!.payload.message, /عبر الذكاء الاصطناعي بنجاح/);
});

// ── rate limiting ────────────────────────────────────────────────────────

test('start_assessment: a user issuing more than 30 requests within the window is rate-limited on the next one', async (t) => {
  // A single-question fixture keeps this fast — the real handler's 40ms
  // inter-question pacing delay would otherwise multiply across all 30
  // allowed iterations (irrelevant to what this test actually verifies).
  const { register } = await loadGateway(t, {
    generate20Questions: async () => ({
      questions: [validQuestion(1)],
      subSpecialtiesSnapshot: [],
      analyzedAssetsSnapshot: [],
      generationSource: 'GEMINI'
    })
  });
  const uniqueUserId = `rate-limit-user-${Date.now()}-${Math.random()}`;
  const { socket, handlers, emitted } = createMockSocket({ userId: uniqueUserId });
  register(socket);

  for (let i = 0; i < 30; i++) {
    await handlers['start_assessment']({ providerSpecialtyId: 'spec-1' });
  }
  emitted.length = 0;

  await handlers['start_assessment']({ providerSpecialtyId: 'spec-1' });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'assessment_error');
  assert.match(emitted[0].payload.message, /تجاوز الحد المسموح/);
});

// ── disconnect cancellation ──────────────────────────────────────────────

test('start_assessment: a socket disconnect aborts the in-flight Gemini generation', async (t) => {
  let capturedSignal: AbortSignal | undefined;
  const { register } = await loadGateway(t, {
    generate20Questions: async (input: any) => {
      capturedSignal = input.signal;
      const abortError: any = new Error('aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
  });
  const { socket, handlers, emitted, triggerDisconnect } = createMockSocket({ userId: 'user-1' });
  register(socket);

  const handlerPromise = handlers['start_assessment'](START_PAYLOAD);
  triggerDisconnect();
  await handlerPromise;

  assert.ok(capturedSignal, 'a signal must be passed to generate20Questions');
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'assessment_error');
});

// ── submission: ownership fix (NEW — previously missing entirely) ────────

test('submit_answer: an attempt not owned by the calling user is rejected, never scored', async (t) => {
  const { register } = await loadGateway(t, { attempt: null });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'real-db-attempt-uuid-123', answers: {} });

  const completeEvents = emitted.filter((e) => e.event === 'evaluation_complete');
  assert.equal(completeEvents.length, 0);
  assert.equal(emitted[emitted.length - 1].event, 'assessment_error');
});

test('submit_answer: an unauthenticated socket is rejected', async (t) => {
  const { register } = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'real-db-attempt-uuid-123', answers: {} });

  assert.equal(emitted[0].event, 'assessment_error');
});

test('submit_answer: a user issuing more than 30 submissions within the window is rate-limited', async (t) => {
  const attempt = {
    id: 'db-attempt-uuid-1',
    providerSpecialtyId: 'spec-1',
    questionsPayload: Array.from({ length: 4 }, (_, i) => validQuestion(i + 1)),
    providerSpecialty: { specialty: {} }
  };
  const { register } = await loadGateway(t, { attempt });
  const uniqueUserId = `rate-limit-submit-${Date.now()}-${Math.random()}`;
  const { socket, handlers, emitted } = createMockSocket({ userId: uniqueUserId });
  register(socket);

  for (let i = 0; i < 30; i++) {
    await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });
  }
  emitted.length = 0;

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });

  assert.equal(emitted.length, 1);
  assert.match(emitted[0].payload.message, /تجاوز الحد المسموح/);
});

// ── successful ordered submission flow + real Gemini feedback ────────────

test('submit_answer: a genuinely owned attempt with a real validated Gemini feedback success emits evaluation_complete with real feedback', async (t) => {
  const attempt = {
    id: 'db-attempt-uuid-1',
    providerSpecialtyId: 'spec-1',
    questionsPayload: Array.from({ length: 4 }, (_, i) => validQuestion(i + 1)),
    providerSpecialty: { specialty: { nameAr: 'تطوير الويب' } }
  };
  const feedback = { feedbackAr: 'ملاحظة حقيقية', strengths: ['قوة'], weaknesses: [] };
  const { register, updateSpy } = await loadGateway(t, {
    attempt,
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(feedback), true);
      return { data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b', '2': 'b', '3': 'b', '4': 'b' } });

  const complete = emitted.find((e) => e.event === 'evaluation_complete');
  assert.ok(complete);
  assert.equal(complete!.payload.feedbackAr, 'ملاحظة حقيقية');
  assert.equal(complete!.payload.isPassed, true);
  assert.equal(updateSpy.mock.calls.some((c: any) => c.arguments[0].data?.feedbackAr === 'ملاحظة حقيقية'), true);
});

test('submit_answer: Gemini feedback failure still completes with the deterministic real-outcome feedback, never blocking completion', async (t) => {
  const attempt = {
    id: 'db-attempt-uuid-1',
    providerSpecialtyId: 'spec-1',
    questionsPayload: Array.from({ length: 4 }, (_, i) => validQuestion(i + 1)),
    providerSpecialty: { specialty: {} }
  };
  const { register } = await loadGateway(t, {
    attempt,
    generateStructured: async () => { throw new Error('unavailable'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b', '2': 'b', '3': 'b', '4': 'b' } });

  const complete = emitted.find((e) => e.event === 'evaluation_complete');
  assert.ok(complete, 'completion must still occur — a Gemini feedback failure is not the same as a submission failure');
  assert.equal(complete!.payload.isPassed, true);
});
