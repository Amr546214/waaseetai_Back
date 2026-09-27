import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './ai/gemini/gemini.errors';

// F12 (AI Assessment REST) — Batch: F12+F13+F14 assessment pipeline
// migration to the shared Gemini foundation. `prisma`, `geminiClient`, and
// `aiAssessmentAnalyzerService` are all mocked; no real DB/network call
// happens.

function providerSpecialtyFixture(overrides: Partial<any> = {}) {
  return {
    id: 'spec-1',
    specialtyId: 'specialty-1',
    providerProfileId: 'profile-1',
    subSpecialties: ['React'],
    specialty: { nameAr: 'تطوير الويب', name: 'web', category: { nameAr: 'تقنية' } },
    providerProfile: { user: {}, portfolioItems: [], certificates: [] },
    workSamples: [],
    ...overrides
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

async function loadService(t: TestContext, opts: {
  providerSpecialty?: any;
  attempt?: any;
  generate20Questions?: (input: any) => Promise<any>;
  generateStructured?: (prompt: string, options: any) => Promise<any>;
  createSpy?: any;
  updateManySpy?: any;
  topLevelUpdateSpy?: any;
  claimExistingAttempt?: any;
  queryRawSpy?: any;
}) {
  // Batch 3D-2: the generation claim reserves the AssessmentAttempt row
  // (tx.assessmentAttempt.create) inside the same locked transaction that
  // checks for an existing active attempt (tx.assessmentAttempt.findFirst) —
  // both mocked here. `topLevelUpdateSpy` is the separate, non-transactional
  // `prisma.assessmentAttempt.update` used afterward to fill in the real
  // generated data (or release the reservation to CANCELLED on failure).
  const createSpy = opts.createSpy ?? t.mock.fn(async (args: any) => ({ id: 'reserved-attempt-1', ...args.data }));
  const claimFindFirstSpy = t.mock.fn(async () => (opts.claimExistingAttempt !== undefined ? opts.claimExistingAttempt : null));
  const queryRawSpy = opts.queryRawSpy ?? t.mock.fn(async () => []);
  const updateSpy = t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const topLevelUpdateSpy = opts.topLevelUpdateSpy ?? t.mock.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  // Batch 3D-1: the atomic claim uses updateMany, conditioned on the
  // attempt's current status matching the submittable list. Defaults to a
  // successful claim (count: 1); tests simulating a lost race pass their own
  // spy that returns { count: 0 }.
  const updateManySpy = opts.updateManySpy ?? t.mock.fn(async () => ({ count: 1 }));
  const tx = {
    $queryRaw: queryRawSpy,
    assessmentAttempt: { update: updateSpy, create: createSpy, findFirst: claimFindFirstSpy },
    providerSpecialty: { update: updateSpy, count: async () => 0 },
    user: { update: async () => ({}) }
  };
  const prismaMock: any = {
    providerSpecialty: { findFirst: async () => (opts.providerSpecialty === undefined ? providerSpecialtyFixture() : opts.providerSpecialty) },
    assessmentAttempt: {
      create: createSpy,
      findUnique: async () => (opts.attempt === undefined ? null : opts.attempt),
      update: topLevelUpdateSpy,
      updateMany: updateManySpy
    },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

  const geminiClientMock = {
    generateStructured: opts.generateStructured ?? (async () => { throw new Error('generateStructured not stubbed for this test'); })
  };
  t.mock.module('./ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

  const analyzerMock = {
    generate20Questions: opts.generate20Questions ?? (async () => ({
      questions: Array.from({ length: 20 }, (_, i) => validQuestion(i + 1)),
      subSpecialtiesSnapshot: ['React'],
      analyzedAssetsSnapshot: [],
      generationSource: 'GEMINI'
    })),
    generateFallback20Questions: () => Array.from({ length: 20 }, (_, i) => validQuestion(i + 1))
  };
  t.mock.module('./ai-assessment-analyzer.service', { namedExports: { aiAssessmentAnalyzerService: analyzerMock } });

  const moduleUrl = `./ai-assessment.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { aiAssessmentService } = await import(moduleUrl);
  return { aiAssessmentService, createSpy, updateSpy, updateManySpy, topLevelUpdateSpy, queryRawSpy, claimFindFirstSpy };
}

test('generateAssessment: a real Gemini success reserves the attempt before Gemini runs, then persists real snapshot metadata + generationSource and returns sanitized questions', async (t) => {
  const { aiAssessmentService, createSpy, topLevelUpdateSpy } = await loadService(t, {});

  const result = await aiAssessmentService.generateAssessment('spec-1', 'user-1');

  assert.equal(result.generationSource, 'GEMINI');
  assert.equal(result.questions.length, 20);
  assert.equal('correctAnswer' in result.questions[0], false, 'correctAnswer must be stripped before reaching the frontend');
  assert.equal('explanation' in result.questions[0], false, 'explanation must be stripped before reaching the frontend');

  // The reservation (Batch 3D-2) is created BEFORE Gemini, with an empty
  // placeholder payload — the real data only lands via the follow-up update.
  const reserveArgs = createSpy.mock.calls[0].arguments[0].data;
  assert.equal(reserveArgs.status, 'STREAMING');
  assert.deepEqual(reserveArgs.questionsPayload, []);

  const updateArgs = topLevelUpdateSpy.mock.calls[0].arguments[0].data;
  assert.deepEqual(updateArgs.subSpecialtiesSnapshot, ['React']);
  assert.equal(updateArgs.analyzedAssetsSnapshot.generationSource, 'GEMINI');
  assert.equal(result.attemptId, 'reserved-attempt-1');
});

test('generateAssessment: a static-fallback generation is honestly persisted and returned as STATIC_FALLBACK', async (t) => {
  const { aiAssessmentService, topLevelUpdateSpy } = await loadService(t, {
    generate20Questions: async () => ({
      questions: Array.from({ length: 20 }, (_, i) => validQuestion(i + 1)),
      subSpecialtiesSnapshot: ['React'],
      analyzedAssetsSnapshot: [],
      generationSource: 'STATIC_FALLBACK'
    })
  });

  const result = await aiAssessmentService.generateAssessment('spec-1', 'user-1');

  assert.equal(result.generationSource, 'STATIC_FALLBACK');
  assert.equal(topLevelUpdateSpy.mock.calls[0].arguments[0].data.analyzedAssetsSnapshot.generationSource, 'STATIC_FALLBACK');
});

test('generateAssessment: throws when the provider specialty is not owned by the current user, without generating anything or attempting a claim', async (t) => {
  let called = false;
  const { aiAssessmentService, claimFindFirstSpy } = await loadService(t, {
    providerSpecialty: null,
    generate20Questions: async () => { called = true; throw new Error('should never be called'); }
  });

  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'someone-else'));
  assert.equal(called, false);
  assert.equal(claimFindFirstSpy.mock.calls.length, 0, 'a caller who does not own the specialty must never reach the generation claim at all');
});

// ── Batch 3D-2: assessment generation integrity (duplicate generation) ───

test('generateAssessment: the active-attempt lookup only matches IN_PROGRESS/STREAMING — a COMPLETED historical attempt can never block a new legitimate assessment', async (t) => {
  const { aiAssessmentService, claimFindFirstSpy } = await loadService(t, {});

  await aiAssessmentService.generateAssessment('spec-1', 'user-1');

  const claimWhere = claimFindFirstSpy.mock.calls[0].arguments[0].where;
  assert.deepEqual(claimWhere.status.in, ['IN_PROGRESS', 'STREAMING']);
  assert.equal(claimWhere.status.in.includes('COMPLETED'), false);
});

test('generateAssessment: an existing active attempt with real questions already generated is reused — no second Gemini call, no second attempt row', async (t) => {
  let geminiCalled = false;
  const { aiAssessmentService, createSpy } = await loadService(t, {
    claimExistingAttempt: {
      id: 'socket-owned-attempt-1',
      questionsPayload: Array.from({ length: 20 }, (_, i) => validQuestion(i + 1)),
      analyzedAssetsSnapshot: { generationSource: 'GEMINI' }
    },
    generate20Questions: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });

  const result = await aiAssessmentService.generateAssessment('spec-1', 'user-1');

  assert.equal(geminiCalled, false, 'reusing an already-generated attempt must never spend a second Gemini call');
  assert.equal(createSpy.mock.calls.length, 0, 'no second AssessmentAttempt row may be created');
  assert.equal(result.attemptId, 'socket-owned-attempt-1');
  assert.equal(result.questions.length, 20);
  assert.equal(result.generationSource, 'GEMINI');
  assert.equal('correctAnswer' in result.questions[0], false, 'reused questions must still be sanitized');
});

test('generateAssessment: an existing active attempt still generating (no questions yet) is rejected with a distinguishable code — no Gemini call, no second attempt row', async (t) => {
  let geminiCalled = false;
  const { aiAssessmentService, createSpy } = await loadService(t, {
    claimExistingAttempt: { id: 'socket-owned-attempt-1', questionsPayload: [], analyzedAssetsSnapshot: null },
    generate20Questions: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });

  await assert.rejects(
    () => aiAssessmentService.generateAssessment('spec-1', 'user-1'),
    (err: any) => {
      assert.equal(err.code, 'GENERATION_IN_PROGRESS');
      return true;
    }
  );
  assert.equal(geminiCalled, false);
  assert.equal(createSpy.mock.calls.length, 0);
});

test('generateAssessment: a persist failure after a successful claim releases the reservation to CANCELLED, so a retry is never permanently blocked', async (t) => {
  const failingUpdateSpy = { mock: { calls: [] as any[] } } as any;
  let callCount = 0;
  const topLevelUpdateSpy = async (args: any) => {
    callCount++;
    failingUpdateSpy.mock.calls.push({ arguments: [args] });
    if (callCount === 1) throw new Error('DB write failed');
    return { id: args.where.id, ...args.data };
  };
  const { aiAssessmentService } = await loadService(t, { topLevelUpdateSpy });

  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'));

  const cancelCall = failingUpdateSpy.mock.calls.find((c: any) => c.arguments[0].data.status === 'CANCELLED');
  assert.ok(cancelCall, 'the reservation must be released to CANCELLED, not left stuck in STREAMING, so a retry can claim a fresh attempt');
});

function attemptFixture(overrides: Partial<any> = {}) {
  return {
    id: 'attempt-1',
    providerSpecialtyId: 'spec-1',
    providerProfileId: 'profile-1',
    status: 'IN_PROGRESS',
    startedAt: new Date(),
    timeLimitMinutes: 15,
    score: null,
    isPassed: false,
    feedbackAr: null,
    strengths: [],
    weaknesses: [],
    completedAt: null,
    questionsPayload: Array.from({ length: 4 }, (_, i) => validQuestion(i + 1)),
    providerSpecialty: {
      providerProfileId: 'profile-1',
      specialty: { nameAr: 'تطوير الويب' },
      providerProfile: { userId: 'user-1' }
    },
    ...overrides
  };
}

test('submitAssessment: a real validated Gemini feedback success is used and persisted', async (t) => {
  const feedback = { feedbackAr: 'ملاحظة حقيقية', strengths: ['قوة'], weaknesses: [] };
  const { aiAssessmentService, updateSpy } = await loadService(t, {
    attempt: attemptFixture(),
    generateStructured: async (_prompt, options) => {
      assert.equal(options.validate(feedback), true);
      return { data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  const result = await aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1');

  assert.equal(result.feedbackAr, 'ملاحظة حقيقية');
  assert.equal(result.isPassed, true);
  const updateArgs = updateSpy.mock.calls.find((c: any) => c.arguments[0].data.feedbackAr)?.arguments[0];
  assert.equal(updateArgs.data.feedbackAr, 'ملاحظة حقيقية');
});

test('submitAssessment: Gemini feedback failure falls back to the deterministic real-outcome feedback (score/pass are always real, never fabricated)', async (t) => {
  const { aiAssessmentService } = await loadService(t, {
    attempt: attemptFixture(),
    generateStructured: async () => { throw new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'unavailable'); }
  });

  const result = await aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1');

  assert.equal(result.isPassed, true);
  assert.equal(result.score, 100);
  assert.match(result.feedbackAr, /ممتاز/);
});

test('submitAssessment: passes an explicit, non-truncating maxOutputTokens (live-Gemini truncation regression)', async (t) => {
  const feedback = { feedbackAr: 'ملاحظة حقيقية', strengths: ['قوة'], weaknesses: [] };
  const { aiAssessmentService } = await loadService(t, {
    attempt: attemptFixture(),
    generateStructured: async (_prompt, options) => {
      assert.equal(typeof options.maxOutputTokens, 'number');
      assert.ok(options.maxOutputTokens > 0, 'maxOutputTokens must be a defined positive number');
      assert.ok(options.maxOutputTokens >= 1000, 'must retain enough headroom to avoid the observed live truncation at 500');
      return { data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  });

  await aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1');
});

test('submitAssessment: throws when the attempt does not belong to the calling user', async (t) => {
  const { aiAssessmentService } = await loadService(t, { attempt: attemptFixture({ providerSpecialty: { ...attemptFixture().providerSpecialty, providerProfile: { userId: 'someone-else' } } }) });

  await assert.rejects(() => aiAssessmentService.submitAssessment('attempt-1', {}, 'user-1'));
});

// ── Batch 3D-1: assessment submission integrity ─────────────────────────

test('submitAssessment: a COMPLETED attempt cannot be re-scored — rejected before any Gemini call', async (t) => {
  let geminiCalled = false;
  const { aiAssessmentService } = await loadService(t, {
    attempt: attemptFixture({ status: 'COMPLETED', score: 100, isPassed: true }),
    generateStructured: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });

  await assert.rejects(() => aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1'));
  assert.equal(geminiCalled, false);
});

test('submitAssessment: an already-EXPIRED attempt cannot be scored — rejected before any Gemini call', async (t) => {
  let geminiCalled = false;
  const { aiAssessmentService } = await loadService(t, {
    attempt: attemptFixture({ status: 'EXPIRED' }),
    generateStructured: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });

  await assert.rejects(() => aiAssessmentService.submitAssessment('attempt-1', { '1': 'b' }, 'user-1'));
  assert.equal(geminiCalled, false);
});

test('submitAssessment: a late submission (elapsed past the 15+1 minute grace period) is marked EXPIRED, never scored, never calls Gemini', async (t) => {
  let geminiCalled = false;
  const startedAt = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
  const { aiAssessmentService, updateManySpy } = await loadService(t, {
    attempt: attemptFixture({ startedAt }),
    generateStructured: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });

  const result = await aiAssessmentService.submitAssessment('attempt-1', { '1': 'b' }, 'user-1');

  assert.equal(result.status, 'EXPIRED');
  assert.equal(result.isPassed, false);
  assert.equal(result.score, 0);
  assert.equal(geminiCalled, false, 'an expired attempt must never trigger a Gemini feedback call');
  // The claim's data must set status EXPIRED, not COMPLETED/FAILED, and must
  // never touch ProviderSpecialty (asserted implicitly: no providerSpecialty
  // update spy call is possible here since updateMany, not $transaction, was used).
  const claimArgs = updateManySpy.mock.calls[0].arguments[0];
  assert.equal(claimArgs.data.status, 'EXPIRED');
});

test('submitAssessment: losing the atomic claim to a concurrent submission (e.g. the socket twin) rejects safely, calls no Gemini, and never overwrites the winner', async (t) => {
  let geminiCalled = false;
  const { aiAssessmentService } = await loadService(t, {
    attempt: attemptFixture(),
    updateManySpy: t.mock.fn(async () => ({ count: 0 })), // simulates the socket twin having already claimed this attempt
    generateStructured: async () => { geminiCalled = true; throw new Error('must not be called'); }
  });

  await assert.rejects(
    () => aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1'),
    /already finalized by a concurrent submission/
  );
  assert.equal(geminiCalled, false, 'the losing side of a race must never spend a Gemini call');
});

test('submitAssessment: the winning claim persists exactly once — ProviderSpecialty outcome applied a single time', async (t) => {
  const feedback = { feedbackAr: 'ملاحظة حقيقية', strengths: ['قوة'], weaknesses: [] };
  const { aiAssessmentService, updateSpy, updateManySpy } = await loadService(t, {
    attempt: attemptFixture(),
    generateStructured: async () => ({ data: feedback, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  });

  await aiAssessmentService.submitAssessment('attempt-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1');

  assert.equal(updateManySpy.mock.calls.length, 1, 'exactly one atomic claim attempt');
  const providerSpecialtyUpdates = updateSpy.mock.calls.filter((c: any) => c.arguments[0].data?.hasTakenAssessment !== undefined);
  assert.equal(providerSpecialtyUpdates.length, 1, 'ProviderSpecialty outcome must be applied at most once');
});
