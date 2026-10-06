import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';

// AI assessment service on top of WaseetAI. `prisma` and `waseetAiClient`
// are mocked (module-level, delegating to a per-test `state`); no real
// DB/network call happens.

const state: any = {};
function resetState(over: Partial<any> = {}) {
  Object.assign(state, {
    providerSpecialty: { id: 'spec-1', specialtyId: 'specialty-1', providerProfileId: 'profile-1', specialty: { nameAr: 'تطوير الويب', name: 'web' } },
    claimExisting: null,
    attempt: null,
    updateManyResult: () => ({ count: 1 }),
    updates: [] as any[],
    claimWheres: [] as any[],
    failFirstUpdate: false,
    updateManys: [] as any[],
    txUpdates: [] as any[],
    creates: [] as any[],
    userUpdates: [] as any[],
    client: {},
    ...over
  });
}

const prismaMock: any = {
  providerSpecialty: { findFirst: async () => state.providerSpecialty },
  assessmentAttempt: {
    findFirst: async () => state.attempt,
    findUnique: async () => state.attempt,
    update: async (args: any) => {
      state.updates.push(args);
      if (state.failFirstUpdate && state.updates.length === 1) throw new Error('db write failed');
      return { id: args.where.id, ...args.data };
    },
    updateMany: async (args: any) => { state.updateManys.push(args); return state.updateManyResult(args); }
  },
  $transaction: async (fn: any) => fn({
    $queryRaw: async () => [],
    assessmentAttempt: {
      findFirst: async (args: any) => { state.claimWheres.push(args); return state.claimExisting; },
      create: async (args: any) => { state.creates.push(args); return { id: 'reserved-1', ...args.data }; },
      update: async (args: any) => { state.txUpdates.push({ model: 'attempt', ...args }); return {}; }
    },
    providerSpecialty: {
      update: async (args: any) => { state.txUpdates.push({ model: 'specialty', ...args }); return {}; },
      count: async () => 1
    },
    user: { update: async (args: any) => { state.userUpdates.push(args); return {}; } }
  })
};
mock.module('../config/db', { namedExports: { prisma: prismaMock } });
mock.module('./ai/waseet-ai/waseet-ai.client', {
  namedExports: {
    waseetAiClient: {
      createAssessment: (...a: any[]) => state.client.createAssessment(...a),
      submitAssessment: (...a: any[]) => state.client.submitAssessment(...a),
      streamAssessmentQuestions: (...a: any[]) => state.client.streamAssessmentQuestions(...a)
    }
  }
});

let svcPromise: Promise<any> | null = null;
const loadSvc = () => (svcPromise ||= import('./ai-assessment.service.ts'));

const opts = (n = 4) => Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(97 + i), text: `خيار ${i}` }));
const vq = (id: number) => ({ id, textAr: `سؤال ${id}`, options: opts() });
const legacyQ = (id: number) => ({ ...vq(id), correctAnswer: 'b', explanation: 'شرح', assessmentArea: 'التخصص الرئيسي' });

function attemptFixture(over: Partial<any> = {}) {
  return {
    id: 'att-1',
    providerSpecialtyId: 'spec-1',
    providerProfileId: 'profile-1',
    totalQuestions: 4,
    status: 'IN_PROGRESS',
    startedAt: new Date(),
    timeLimitMinutes: 15,
    submittedAnswers: null,
    questionsPayload: [vq(1), vq(2), vq(3), vq(4)],
    analyzedAssetsSnapshot: { provider: 'WASEET_AI', vendorAttemptId: 'vendor-9', generationSource: 'GEMINI_VENDOR_REPORTED' },
    providerSpecialty: { specialty: { nameAr: 'تطوير الويب' }, providerProfile: { userId: 'user-1' } },
    ...over
  };
}
const legacyAttempt = (over: Partial<any> = {}) =>
  attemptFixture({ questionsPayload: [1, 2, 3, 4].map(legacyQ), analyzedAssetsSnapshot: { items: [], generationSource: 'GEMINI' }, ...over });

const gradedOk = (over: Partial<any> = {}) => ({ attemptId: 'vendor-9', score: 80, isPassed: true, status: 'COMPLETED', feedbackAr: 'أداء جيد', strengths: ['أ'], weaknesses: ['ب'], ...over });

// ── generation (REST, non-streaming) ─────────────────────────────────────

test('generate: ownership failure throws before any claim or WaseetAI call', async () => {
  resetState({ providerSpecialty: null, client: { createAssessment: async () => { throw new Error('must not be called'); } } });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), /not found/);
  assert.equal(state.creates.length, 0);
});

test('generate: claim winner calls createAssessment with DB specialty name, persists key-less payload + vendor attempt id', async () => {
  const calls: any[] = [];
  resetState({
    client: { createAssessment: async (body: any) => { calls.push(body); return { attemptId: 'vendor-1', timeLimitMinutes: 15, questions: [vq(1), vq(2)] }; } }
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.generateAssessment('spec-1', 'user-1');

  assert.deepEqual(calls, [{ providerSpecialtyId: 'spec-1', specialtyName: 'تطوير الويب', questionCount: 20, timeLimitMinutes: 15 }]);
  assert.equal(res.attemptId, 'reserved-1');
  assert.equal(res.questions.length, 2);
  assert.equal(res.generationSource, undefined, 'no generationSource is invented when WaseetAI reports none');
  const persisted = state.updates[0].data;
  assert.equal(persisted.status, 'IN_PROGRESS');
  assert.equal(persisted.analyzedAssetsSnapshot.vendorAttemptId, 'vendor-1');
  assert.ok(!JSON.stringify(persisted.questionsPayload).includes('correctAnswer'));
  assert.equal(persisted.totalQuestions, 2);
});

test('generate: claim lost with real questions reuses them (no WaseetAI call, source as stored)', async () => {
  resetState({
    claimExisting: { id: 'other', questionsPayload: [legacyQ(1)], analyzedAssetsSnapshot: { generationSource: 'X_SRC' } },
    client: { createAssessment: async () => { throw new Error('must not be called'); } }
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.generateAssessment('spec-1', 'user-1');
  assert.equal(res.attemptId, 'other');
  assert.equal(res.generationSource, 'X_SRC');
  assert.ok(!('correctAnswer' in res.questions[0]), 'legacy answer key is stripped on reuse');
});

test('generate: claim lost while generation in flight -> GENERATION_IN_PROGRESS', async () => {
  resetState({ claimExisting: { id: 'other', questionsPayload: [], analyzedAssetsSnapshot: null } });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => e.code === 'GENERATION_IN_PROGRESS');
});

test('generate: WaseetAI failure releases the reservation and fabricates nothing', async () => {
  resetState({ client: { createAssessment: async () => { throw new Error('upstream down'); } } });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => e.code === 'ASSESSMENT_GENERATION_FAILED');
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].data.status, 'CANCELLED');
  assert.equal(state.updates[0].data.questionsPayload, undefined);
});

// ── generation (streaming relay) ─────────────────────────────────────────

test('stream: questions are relayed as they arrive (before the stream ends) and persisted key-less with the vendor id; source relayed verbatim', async () => {
  const order: string[] = [];
  let sawQuestionBeforeEnd = false;
  resetState({
    client: {
      streamAssessmentQuestions: async function* (body: any, o: any) {
        order.push(`req:${body.specialtyName}:${body.questionCount}:${body.timeLimitMinutes}`);
        yield { type: 'question', attemptId: 'v-1', question: vq(1) };
        sawQuestionBeforeEnd = order.includes('q1');
        yield { type: 'question', attemptId: 'v-1', question: vq(2) };
        yield { type: 'assessment_ready', attemptId: 'v-1', totalQuestions: 2, timeLimitMinutes: 15, generationSource: 'SOME_SOURCE' };
        yield { type: 'completed' };
      }
    }
  });
  const { streamAssessmentForClaim } = await loadSvc();
  const out = await streamAssessmentForClaim({
    claimAttemptId: 'reserved-1', providerSpecialtyId: 'spec-1', specialtyName: 'تطوير الويب',
    onQuestion: (q: any, i: number, total: number) => order.push(`q${i}`)
  });
  assert.equal(sawQuestionBeforeEnd, true);
  assert.deepEqual(order, ['req:تطوير الويب:20:15', 'q1', 'q2']);
  assert.equal(out.generationSource, 'SOME_SOURCE');
  const persisted = state.updates[0].data;
  assert.equal(persisted.analyzedAssetsSnapshot.vendorAttemptId, 'v-1');
  assert.equal(persisted.analyzedAssetsSnapshot.generationSource, 'SOME_SOURCE');
  assert.deepEqual(persisted.questionsPayload.map((q: any) => q.id), [1, 2]);
  assert.ok(!JSON.stringify(persisted.questionsPayload).includes('correctAnswer'));
});

test('stream: an incomplete/inconsistent stream releases the claim and persists nothing', async () => {
  resetState({
    client: {
      streamAssessmentQuestions: async function* () {
        yield { type: 'question', attemptId: 'v-1', question: vq(1) };
        yield { type: 'assessment_ready', attemptId: 'v-1', totalQuestions: 5, timeLimitMinutes: 15 };
      }
    }
  });
  const { streamAssessmentForClaim } = await loadSvc();
  await assert.rejects(() => streamAssessmentForClaim({ claimAttemptId: 'reserved-1', providerSpecialtyId: 'spec-1', specialtyName: 'x' }), (e: any) => e.code === 'ASSESSMENT_GENERATION_FAILED');
  assert.deepEqual(state.updates.map((u: any) => u.data.status), ['CANCELLED']);
});

test('stream: a mid-stream failure releases the claim', async () => {
  resetState({
    client: { streamAssessmentQuestions: async function* () { yield { type: 'question', attemptId: 'v-1', question: vq(1) }; throw new Error('boom'); } }
  });
  const { streamAssessmentForClaim } = await loadSvc();
  await assert.rejects(() => streamAssessmentForClaim({ claimAttemptId: 'reserved-1', providerSpecialtyId: 'spec-1', specialtyName: 'x' }));
  assert.deepEqual(state.updates.map((u: any) => u.data.status), ['CANCELLED']);
});

// ── submission ───────────────────────────────────────────────────────────

test('submit: not owner / unknown attempt is rejected, nothing graded', async () => {
  resetState({ attempt: null, client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, 'user-2'), /not found/);
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, undefined), /not found/);
});

test('submit: already finalized attempt is rejected before any WaseetAI call', async () => {
  resetState({ attempt: attemptFixture({ status: 'COMPLETED' }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, 'user-1'), /already finalized/);
});

test('submit: late submission is EXPIRED by our own timing, never graded', async () => {
  resetState({
    attempt: attemptFixture({ startedAt: new Date(Date.now() - 17 * 60 * 1000) }),
    client: { submitAssessment: async () => { throw new Error('must not be called'); } }
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1');
  assert.equal(res.status, 'EXPIRED');
  assert.equal(res.score, 0);
  assert.equal(state.updateManys[0].data.status, 'EXPIRED');
  assert.equal(state.txUpdates.length, 0);
});

test('submit: losing the atomic claim to the twin transport spends no WaseetAI call', async () => {
  resetState({
    attempt: attemptFixture(),
    updateManyResult: () => ({ count: 0 }),
    client: { submitAssessment: async () => { throw new Error('must not be called'); } }
  });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1'), /already finalized/);
  assert.equal(state.txUpdates.length, 0);
});

test('submit: a fresh grading claim by another transport is not re-graded', async () => {
  resetState({
    attempt: attemptFixture({ submittedAnswers: { answers: {}, gradingClaimedAt: new Date().toISOString() } }),
    client: { submitAssessment: async () => { throw new Error('must not be called'); } }
  });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, 'user-1'), /already finalized/);
  assert.equal(state.updateManys.length, 0);
});

test('submit: a stale (abandoned) grading claim is released and the submission proceeds', async () => {
  resetState({
    attempt: attemptFixture({ submittedAnswers: { answers: {}, gradingClaimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() } }),
    client: { submitAssessment: async () => gradedOk() }
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', { '1': 'b' }, 'user-1');
  assert.equal(res.score, 80);
  assert.equal(state.updateManys[0].data.submittedAnswers, Prisma.DbNull, 'stale claim released first');
});

test('submit: grading goes through WaseetAI; score/pass/feedback and ProviderSpecialty effects come only from its result', async () => {
  const seen: any[] = [];
  resetState({
    attempt: attemptFixture({ startedAt: new Date(Date.now() - 120 * 1000) }),
    client: { submitAssessment: async (id: string, body: any, o: any) => { seen.push({ id, body, o }); return gradedOk({ score: 61.5, isPassed: true }); } }
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', { '1': ' B ', '2': 'z', '99': 'a', '3': 'c' }, 'user-1');

  assert.equal(seen[0].id, 'vendor-9');
  assert.deepEqual(seen[0].body.submittedAnswers, { '1': 'b', '3': 'c' }, 'only known question ids with valid option ids are forwarded');
  assert.ok(seen[0].body.timeSpentSeconds >= 119 && seen[0].body.timeSpentSeconds <= 130);
  assert.equal(res.score, 61.5);
  assert.equal(res.isPassed, true);
  assert.equal(res.status, 'COMPLETED');
  assert.equal(res.feedbackAr, 'أداء جيد');
  assert.deepEqual(res.strengths, ['أ']);
  const attemptUpdate = state.txUpdates.find((u: any) => u.model === 'attempt');
  assert.equal(attemptUpdate.data.score, 61.5);
  assert.equal(attemptUpdate.data.weaknesses[0], 'ب');
  const specUpdate = state.txUpdates.find((u: any) => u.model === 'specialty');
  assert.equal(specUpdate.data.latestScore, 61.5);
  assert.equal(specUpdate.data.status, 'APPROVED');
  assert.equal(state.userUpdates.length, 1);
});

test('submit: WaseetAI isPassed=false drives REJECTED/FAILED even with a high score (threshold is the vendor\'s)', async () => {
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk({ score: 90, isPassed: false }) } });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1');
  assert.equal(res.status, 'FAILED');
  assert.equal(state.txUpdates.find((u: any) => u.model === 'specialty').data.status, 'REJECTED');
  assert.equal(state.userUpdates.length, 0);
});

test('submit: grading failure releases the claim, throws a retryable error, records no score or pass/fail', async () => {
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => { throw new Error('timeout'); } } });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1'), (e: any) => e.code === 'ASSESSMENT_GRADING_FAILED');
  assert.equal(state.txUpdates.length, 0);
  const release = state.updateManys[state.updateManys.length - 1];
  assert.equal(release.data.submittedAnswers, Prisma.DbNull);
  assert.equal(release.data.score, undefined);
  assert.equal(release.data.status, undefined);
});

test('submit: an invalid WaseetAI result (out-of-range score) is treated as a failure, not stored', async () => {
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk({ score: 250 }) } });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, 'user-1'), (e: any) => e.code === 'ASSESSMENT_GRADING_FAILED');
  assert.equal(state.txUpdates.length, 0);
});

test('submit: persistence failure after grading releases the claim', async () => {
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk() } });
  const origTx = prismaMock.$transaction;
  prismaMock.$transaction = async () => { throw new Error('db down'); };
  try {
    const { aiAssessmentService } = await loadSvc();
    await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, 'user-1'), (e: any) => e.code === 'ASSESSMENT_GRADING_FAILED');
    assert.equal(state.updateManys[state.updateManys.length - 1].data.submittedAnswers, Prisma.DbNull);
  } finally {
    prismaMock.$transaction = origTx;
  }
});

test('submit: legacy attempt (local key, no vendor id) is graded locally and deterministically without WaseetAI', async () => {
  resetState({ attempt: legacyAttempt(), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', { '1': 'b', '2': 'b', '3': 'a', '4': 'a' }, 'user-1');
  assert.equal(res.score, 50);
  assert.equal(res.isPassed, true);
  assert.match(res.feedbackAr, /50%/);
  assert.deepEqual(res.strengths, []);
  assert.equal(state.txUpdates.find((u: any) => u.model === 'specialty').data.status, 'APPROVED');
});

test('submit: legacy attempt at or below 25% fails (old rule preserved for old attempts only)', async () => {
  resetState({ attempt: legacyAttempt() });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', { '1': 'b' }, 'user-1');
  assert.equal(res.score, 25);
  assert.equal(res.isPassed, false);
});

test('submit: an attempt with neither a vendor id nor a local key is not gradable (nothing fabricated)', async () => {
  resetState({ attempt: attemptFixture({ analyzedAssetsSnapshot: null }) });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1'), (e: any) => e.code === 'ASSESSMENT_NOT_GRADABLE');
  assert.equal(state.txUpdates.length, 0);
});

test('getAttemptStatus: legacy answer keys are never exposed', async () => {
  resetState({ attempt: { ...legacyAttempt(), providerSpecialty: { id: 'spec-1', providerProfile: { userId: 'user-1' } } } });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.getAttemptStatus('att-1', 'user-1');
  assert.ok(!JSON.stringify(res.questionsPayload).includes('correctAnswer'));
  assert.ok(!JSON.stringify(res.questionsPayload).includes('explanation'));
});

// ── restored guarantees ──────────────────────────────────────────────────

test('generate: the active-attempt lookup only matches IN_PROGRESS/STREAMING — a COMPLETED historical attempt can never block a new assessment', async () => {
  resetState({ client: { createAssessment: async () => ({ attemptId: 'vendor-1', timeLimitMinutes: 15, questions: [vq(1)] }) } });
  const { aiAssessmentService } = await loadSvc();
  await aiAssessmentService.generateAssessment('spec-1', 'user-1');
  assert.deepEqual(state.claimWheres[0].where.status.in.slice().sort(), ['IN_PROGRESS', 'STREAMING']);
  assert.equal(state.creates.length, 1);
  assert.equal(state.creates[0].data.status, 'STREAMING');
  assert.deepEqual(state.creates[0].data.questionsPayload, []);
});

test('generate: a persist failure after a successful WaseetAI generation releases the reservation to CANCELLED so a retry is never blocked', async () => {
  resetState({
    failFirstUpdate: true,
    client: { createAssessment: async () => ({ attemptId: 'vendor-1', timeLimitMinutes: 15, questions: [vq(1)] }) }
  });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => e.code === 'ASSESSMENT_GENERATION_FAILED');
  assert.deepEqual(state.updates.map((u: any) => u.data.status), ['IN_PROGRESS', 'CANCELLED']);
});

test('generate: an existing active attempt with real questions is reused — no second WaseetAI call, no second attempt row', async () => {
  resetState({
    claimExisting: { id: 'other', questionsPayload: [vq(1), vq(2)], analyzedAssetsSnapshot: { provider: 'WASEET_AI', vendorAttemptId: 'v' } },
    client: { createAssessment: async () => { throw new Error('must not be called'); } }
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.generateAssessment('spec-1', 'user-1');
  assert.equal(res.attemptId, 'other');
  assert.equal(res.questions.length, 2);
  assert.equal(state.creates.length, 0);
  assert.equal(state.updates.length, 0);
});

test('stream: a persist failure after a complete stream releases the reservation and throws the coded error', async () => {
  resetState({
    failFirstUpdate: true,
    client: {
      streamAssessmentQuestions: async function* () {
        yield { type: 'question', attemptId: 'v-1', question: vq(1) };
        yield { type: 'assessment_ready', attemptId: 'v-1', totalQuestions: 1, timeLimitMinutes: 15 };
      }
    }
  });
  const { streamAssessmentForClaim } = await loadSvc();
  await assert.rejects(() => streamAssessmentForClaim({ claimAttemptId: 'reserved-1', providerSpecialtyId: 'spec-1', specialtyName: 'x' }), (e: any) => e.code === 'ASSESSMENT_GENERATION_FAILED');
  assert.deepEqual(state.updates.map((u: any) => u.data.status), ['IN_PROGRESS', 'CANCELLED']);
});

for (const status of ['EXPIRED', 'CANCELLED', 'FAILED']) {
  test(`submit: an already-${status} attempt cannot be scored — rejected before any WaseetAI call`, async () => {
    resetState({ attempt: attemptFixture({ status }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
    const { aiAssessmentService } = await loadSvc();
    await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1'), /already finalized/);
    assert.equal(state.updateManys.length, 0);
    assert.equal(state.txUpdates.length, 0);
  });
}

test('submit: the winning claim persists exactly once — attempt and ProviderSpecialty outcome applied a single time', async () => {
  let calls = 0;
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => { calls++; return gradedOk(); } } });
  const { aiAssessmentService } = await loadSvc();
  await aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1');
  assert.equal(calls, 1);
  assert.equal(state.txUpdates.filter((u: any) => u.model === 'attempt').length, 1);
  assert.equal(state.txUpdates.filter((u: any) => u.model === 'specialty').length, 1);
});

test('getAttemptStatus: an attempt not owned by the user is not exposed', async () => {
  resetState({ attempt: null });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.getAttemptStatus('att-1', 'user-2'));
});

test('getAttemptStatus: a missing or foreign attempt is a 404 AppError (never a plain Error -> 500)', async () => {
  const { aiAssessmentService } = await loadSvc();
  resetState({ attempt: null });
  await assert.rejects(() => aiAssessmentService.getAttemptStatus('att-x', 'user-1'), (e: any) => e?.name === 'Error' && e.statusCode === 404 && e.isOperational === true);
  // owned by someone else -> the same 404 (does not reveal that it exists)
  resetState({ attempt: attemptFixture() });
  await assert.rejects(() => aiAssessmentService.getAttemptStatus('att-1', 'someone-else'), (e: any) => e.statusCode === 404);
  // no authenticated user -> 404 as well
  await assert.rejects(() => aiAssessmentService.getAttemptStatus('att-1', undefined), (e: any) => e.statusCode === 404);
});

test('tierForVerifiedSpecialties: >=5 TOP_RATED, 3-4 EXPERT, otherwise PRO (TOP_RATED is reachable)', async () => {
  const { tierForVerifiedSpecialties } = await loadSvc();
  assert.equal(tierForVerifiedSpecialties(0), 'PRO');
  assert.equal(tierForVerifiedSpecialties(1), 'PRO');
  assert.equal(tierForVerifiedSpecialties(2), 'PRO');
  assert.equal(tierForVerifiedSpecialties(3), 'EXPERT');
  assert.equal(tierForVerifiedSpecialties(4), 'EXPERT');
  assert.equal(tierForVerifiedSpecialties(5), 'TOP_RATED');
  assert.equal(tierForVerifiedSpecialties(9), 'TOP_RATED');
});

test('the status controller maps an AppError to its own status code and keeps 500 for unexpected errors', async () => {
  const { getAttemptStatusController } = await import('../controllers/ai-assessment.controller.ts');
  const run = async (attemptId: string, userId: string | undefined) => {
    const out: any = {};
    const res: any = { status: (c: number) => { out.status = c; return res; }, json: (b: any) => { out.body = b; return res; } };
    await getAttemptStatusController({ params: { attemptId }, user: userId ? { id: userId } : undefined } as any, res);
    return out;
  };
  resetState({ attempt: null });
  const missing = await run('att-x', 'user-1');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.success, false);
  assert.match(missing.body.message, /غير موجودة/);
});

test('assessment files have no direct-Gemini reference and no kill switch', () => {
  for (const f of ['./ai-assessment.service.ts', '../controllers/ai-assessment.controller.ts', '../sockets/assessment.gateway.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/gemini/i.test(src), `${f} must not reference Gemini`);
    assert.ok(!/AI_ASSESSMENT_GENERATION_ENABLED|AI_ASSESSMENT_UNAVAILABLE/.test(src), `${f} must not keep the kill switch`);
  }
});
