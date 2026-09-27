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
  updateSpy?: any;
  updateManySpy?: any;
  claimExistingAttempt?: any;
  queryRawSpy?: any;
  generate20Questions?: (input: any) => Promise<any>;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
}) {
  const createSpy = opts.createSpy ?? t.mock.fn(async (args: any) => ({ id: 'attempt-abc-123', ...args.data }));
  const updateSpy = opts.updateSpy ?? t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  // Batch 3D-1: the atomic claim uses updateMany, conditioned on the
  // attempt's current status matching the submittable list. Defaults to a
  // successful claim (count: 1); tests simulating a lost race pass their own
  // spy that returns { count: 0 }.
  const updateManySpy = opts.updateManySpy ?? t.mock.fn(async () => ({ count: 1 }));
  // Batch 3D-2: the generation claim reserves the AssessmentAttempt row
  // (tx.assessmentAttempt.create) inside the same locked transaction that
  // checks for an existing active attempt (tx.assessmentAttempt.findFirst).
  const claimFindFirstSpy = t.mock.fn(async () => (opts.claimExistingAttempt !== undefined ? opts.claimExistingAttempt : null));
  const queryRawSpy = opts.queryRawSpy ?? t.mock.fn(async () => []);
  const tx = {
    $queryRaw: queryRawSpy,
    assessmentAttempt: { update: updateSpy, create: createSpy, findFirst: claimFindFirstSpy },
    providerSpecialty: { update: updateSpy }
  };
  const prismaMock: any = {
    providerSpecialty: { findFirst: async () => (opts.providerSpecialty === undefined ? { id: 'spec-1', specialtyId: 'specialty-1', providerProfileId: 'profile-1', subSpecialties: [] } : opts.providerSpecialty) },
    assessmentAttempt: {
      create: createSpy,
      update: updateSpy,
      updateMany: updateManySpy,
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
  return { register: mod.registerAssessmentGateway as (socket: any) => void, createSpy, updateSpy, updateManySpy, claimFindFirstSpy, queryRawSpy };
}

// Batch 3D-1: a full, "submittable" attempt fixture — real DB submission
// authority checks now require status/startedAt/timeLimitMinutes to be
// present, in addition to the pre-existing ownership/questionsPayload shape.
function submittableAttemptFixture(overrides: Partial<any> = {}) {
  return {
    id: 'db-attempt-uuid-1',
    providerSpecialtyId: 'spec-1',
    totalQuestions: 4,
    status: 'IN_PROGRESS',
    startedAt: new Date(),
    timeLimitMinutes: 15,
    questionsPayload: Array.from({ length: 4 }, (_, i) => validQuestion(i + 1)),
    providerSpecialty: { specialty: { nameAr: 'تطوير الويب' } },
    ...overrides
  };
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

test('start_assessment: a real validated Gemini generation reserves the attempt before Gemini runs, streams all 20 questions in order, then assessment_ready with generationSource GEMINI', async (t) => {
  const { register, createSpy, updateSpy } = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  const streamed = emitted.filter((e) => e.event === 'question_streamed');
  assert.equal(streamed.length, 20);
  assert.deepEqual(streamed.map((e) => e.payload.questionIndex), Array.from({ length: 20 }, (_, i) => i + 1));

  const ready = emitted.find((e) => e.event === 'assessment_ready');
  assert.ok(ready);
  assert.equal(ready!.payload.generationSource, 'GEMINI');

  // The reservation (Batch 3D-2) is created BEFORE Gemini, with an empty
  // placeholder payload — the real data only lands via the follow-up update.
  const reserveArgs = createSpy.mock.calls[0].arguments[0].data;
  assert.equal(reserveArgs.status, 'STREAMING');
  assert.deepEqual(reserveArgs.questionsPayload, []);

  const persistCall = updateSpy.mock.calls.find((c: any) => c.arguments[0].data?.analyzedAssetsSnapshot);
  assert.ok(persistCall, 'the real generated data must be persisted via an update after Gemini succeeds');
  assert.equal(persistCall.arguments[0].data.analyzedAssetsSnapshot.generationSource, 'GEMINI');
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

// ── Batch 3D-2: assessment generation integrity (duplicate generation) ───

test('start_assessment: the active-attempt lookup only matches IN_PROGRESS/STREAMING — a COMPLETED historical attempt can never block a new legitimate assessment', async (t) => {
  const { register, claimFindFirstSpy } = await loadGateway(t, {});
  const { socket, handlers } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  const claimWhere = claimFindFirstSpy.mock.calls[0].arguments[0].where;
  assert.deepEqual(claimWhere.status.in, ['IN_PROGRESS', 'STREAMING']);
  assert.equal(claimWhere.status.in.includes('COMPLETED'), false);
});

test('start_assessment: an existing active attempt with real questions already generated (e.g. the REST twin finished first) is replayed — no second Gemini call, no second attempt row', async (t) => {
  let geminiCalled = false;
  const { register, createSpy } = await loadGateway(t, {
    claimExistingAttempt: {
      id: 'rest-owned-attempt-1',
      questionsPayload: Array.from({ length: 20 }, (_, i) => validQuestion(i + 1)),
      analyzedAssetsSnapshot: { generationSource: 'GEMINI' }
    },
    generate20Questions: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  assert.equal(geminiCalled, false, 'replaying an already-generated attempt must never spend a second Gemini call');
  assert.equal(createSpy.mock.calls.length, 0, 'no second AssessmentAttempt row may be created');
  const streamed = emitted.filter((e) => e.event === 'question_streamed');
  assert.equal(streamed.length, 20);
  assert.ok(streamed.every((e) => e.payload.attemptId === 'rest-owned-attempt-1'));
  const ready = emitted.find((e) => e.event === 'assessment_ready');
  assert.ok(ready);
  assert.equal(ready!.payload.attemptId, 'rest-owned-attempt-1');
  assert.equal(ready!.payload.generationSource, 'GEMINI');
});

test('start_assessment: an existing active attempt still generating (no questions yet) is rejected — no Gemini call, no second attempt row', async (t) => {
  let geminiCalled = false;
  const { register, createSpy } = await loadGateway(t, {
    claimExistingAttempt: { id: 'rest-owned-attempt-1', questionsPayload: [], analyzedAssetsSnapshot: null },
    generate20Questions: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  assert.equal(geminiCalled, false);
  assert.equal(createSpy.mock.calls.length, 0);
  assert.equal(emitted.filter((e) => e.event === 'question_streamed').length, 0);
  assert.equal(emitted.filter((e) => e.event === 'assessment_ready').length, 0);
  assert.equal(emitted[emitted.length - 1].event, 'assessment_error');
});

test('start_assessment: a persist failure after a successful claim releases the reservation to CANCELLED, so a retry is never permanently blocked', async (t) => {
  const updateCalls: any[] = [];
  const failingUpdateSpy = async (args: any) => {
    updateCalls.push(args);
    if (updateCalls.length === 1) throw new Error('DB write failed');
    return { id: args.where.id, ...args.data };
  };
  const { register } = await loadGateway(t, { updateSpy: failingUpdateSpy });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['start_assessment'](START_PAYLOAD);

  assert.equal(emitted[emitted.length - 1].event, 'assessment_error');
  const cancelCall = updateCalls.find((c: any) => c.data.status === 'CANCELLED');
  assert.ok(cancelCall, 'the reservation must be released to CANCELLED, not left stuck in STREAMING, so a retry can claim a fresh attempt');
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
  assert.equal(emitted[emitted.length - 1].payload.code, 'NOT_FOUND', 'Batch 3D-3: structured code lets the frontend classify this as a terminal, non-retryable failure');
});

test('submit_answer: an unauthenticated socket is rejected', async (t) => {
  const { register } = await loadGateway(t, {});
  const { socket, handlers, emitted } = createMockSocket({ userId: undefined });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'real-db-attempt-uuid-123', answers: {} });

  assert.equal(emitted[0].event, 'assessment_error');
  assert.equal(emitted[0].payload.code, 'AUTH_REQUIRED');
});

test('submit_answer: a user issuing more than 30 submissions within the window is rate-limited', async (t) => {
  const attempt = submittableAttemptFixture({ providerSpecialty: { specialty: {} } });
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
  const attempt = submittableAttemptFixture();
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

test('submit_answer: passes an explicit, non-truncating maxOutputTokens (live-Gemini truncation regression)', async (t) => {
  const attempt = submittableAttemptFixture();
  const feedback = { feedbackAr: 'ملاحظة حقيقية', strengths: ['قوة'], weaknesses: [] };
  const { register } = await loadGateway(t, {
    attempt,
    generateStructured: async (_prompt, options) => {
      assert.equal(typeof options.maxOutputTokens, 'number');
      assert.ok(options.maxOutputTokens > 0, 'maxOutputTokens must be a defined positive number');
      assert.ok(options.maxOutputTokens >= 1000, 'must retain enough headroom to avoid the observed live truncation at 500');
      return { data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });
  const { socket, handlers } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b', '2': 'b', '3': 'b', '4': 'b' } });
});

test('submit_answer: Gemini feedback failure still completes with the deterministic real-outcome feedback, never blocking completion', async (t) => {
  const attempt = submittableAttemptFixture({ providerSpecialty: { specialty: {} } });
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

// ── Batch 3D-1: assessment submission integrity ─────────────────────────

test('submit_answer: a COMPLETED attempt cannot be re-scored through the socket — rejected before any Gemini call', async (t) => {
  let geminiCalled = false;
  const attempt = submittableAttemptFixture({ status: 'COMPLETED', score: 100, isPassed: true });
  const { register } = await loadGateway(t, {
    attempt,
    generateStructured: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b', '2': 'b', '3': 'b', '4': 'b' } });

  assert.equal(geminiCalled, false);
  const completeEvents = emitted.filter((e) => e.event === 'evaluation_complete');
  assert.equal(completeEvents.length, 0, 'an already-COMPLETED attempt must never be re-scored/re-emitted');
  assert.equal(emitted[emitted.length - 1].event, 'assessment_error');
  assert.equal(emitted[emitted.length - 1].payload.code, 'ALREADY_FINALIZED', 'Batch 3D-3: a terminal outcome must never be classified as a retryable transport failure');
});

test('submit_answer: an already-EXPIRED attempt cannot be scored through the socket — rejected before any Gemini call', async (t) => {
  let geminiCalled = false;
  const attempt = submittableAttemptFixture({ status: 'EXPIRED' });
  const { register } = await loadGateway(t, {
    attempt,
    generateStructured: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b' } });

  assert.equal(geminiCalled, false);
  assert.equal(emitted.filter((e) => e.event === 'evaluation_complete').length, 0);
  assert.equal(emitted[emitted.length - 1].event, 'assessment_error');
  assert.equal(emitted[emitted.length - 1].payload.code, 'ALREADY_FINALIZED');
});

test('submit_answer: a late submission (elapsed past the 15+1 minute grace period) performs no Gemini call and grants no specialty result', async (t) => {
  let geminiCalled = false;
  const attempt = submittableAttemptFixture({ startedAt: new Date(Date.now() - 20 * 60 * 1000) });
  const { register, updateManySpy } = await loadGateway(t, {
    attempt,
    generateStructured: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b' } });

  assert.equal(geminiCalled, false, 'an expired attempt must never trigger a Gemini feedback call');
  const complete = emitted.find((e) => e.event === 'evaluation_complete');
  assert.ok(complete, 'an expired result is still reported honestly to the client');
  assert.equal(complete!.payload.status, 'EXPIRED');
  assert.equal(complete!.payload.isPassed, false);
  const claimArgs = updateManySpy.mock.calls[0].arguments[0];
  assert.equal(claimArgs.data.status, 'EXPIRED');
});

test('submit_answer: losing the atomic claim to a concurrent submission (e.g. the REST twin) rejects safely, calls no Gemini, and never overwrites the winner', async (t) => {
  let geminiCalled = false;
  const attempt = submittableAttemptFixture();
  const { register } = await loadGateway(t, {
    attempt,
    updateManySpy: t.mock.fn(async () => ({ count: 0 })), // simulates the REST twin having already claimed this attempt
    generateStructured: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b', '2': 'b', '3': 'b', '4': 'b' } });

  assert.equal(geminiCalled, false, 'the losing side of a race must never spend a Gemini call');
  assert.equal(emitted.filter((e) => e.event === 'evaluation_complete').length, 0, 'the loser must never emit its own finalization');
  assert.equal(emitted[emitted.length - 1].event, 'assessment_error');
  assert.equal(emitted[emitted.length - 1].payload.code, 'ALREADY_FINALIZED', 'Batch 3D-3: a lost race must never look like a retryable transport failure to the frontend');
});

test('submit_answer: the winning claim persists exactly once — ProviderSpecialty outcome applied a single time', async (t) => {
  const attempt = submittableAttemptFixture();
  const feedback = { feedbackAr: 'ملاحظة حقيقية', strengths: ['قوة'], weaknesses: [] };
  const { register, updateSpy, updateManySpy } = await loadGateway(t, {
    attempt,
    generateStructured: async () => ({ data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  });
  const { socket, handlers } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b', '2': 'b', '3': 'b', '4': 'b' } });

  assert.equal(updateManySpy.mock.calls.length, 1, 'exactly one atomic claim attempt');
  const providerSpecialtyUpdates = updateSpy.mock.calls.filter((c: any) => c.arguments[0].data?.hasTakenAssessment !== undefined);
  assert.equal(providerSpecialtyUpdates.length, 1, 'ProviderSpecialty outcome must be applied at most once');
});

test('submit_answer: a genuine unexpected processing exception (not a business rejection) is reported with the retryable SUBMISSION_FAILED code', async (t) => {
  const attempt = submittableAttemptFixture();
  const { register } = await loadGateway(t, {
    attempt,
    updateManySpy: async () => { throw new Error('DB connection dropped mid-write'); }
  });
  const { socket, handlers, emitted } = createMockSocket({ userId: 'user-1' });
  register(socket);

  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b', '2': 'b', '3': 'b', '4': 'b' } });

  assert.equal(emitted[emitted.length - 1].event, 'assessment_error');
  assert.equal(emitted[emitted.length - 1].payload.code, 'SUBMISSION_FAILED', 'Batch 3D-3: this is the one code the frontend treats as a genuine, retryable transport/processing failure');
});
