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
    specialtyRow: { status: 'UNDER_AI_REVIEW', isActive: true, isPassed: false, passedAt: null, quizScore: null } as any,
    recentAttempts: [] as any[],
    onCreate: null as any,
    approvedCount: 1,
    attempt: null,
    updateManyResult: () => ({ count: 1 }),
    updates: [] as any[],
    claimWheres: [] as any[],
    failFirstUpdate: false,
    updateManys: [] as any[],
    txUpdates: [] as any[],
    creates: [] as any[],
    findManys: [] as any[],
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
      findMany: async (args: any) => { state.findManys.push(args); return state.recentAttempts; },
      create: async (args: any) => { state.creates.push(args); const row = { id: 'reserved-1', ...args.data }; state.onCreate?.(row); return row; },
      update: async (args: any) => { state.txUpdates.push({ model: 'attempt', ...args }); return {}; }
    },
    providerSpecialty: {
      findUnique: async () => state.specialtyRow,
      update: async (args: any) => { state.txUpdates.push({ model: 'specialty', ...args }); return {}; },
      count: async () => state.approvedCount
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
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => e.statusCode === 404);
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
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, 'user-2'), (e: any) => e.statusCode === 404);
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, undefined), (e: any) => e.statusCode === 404);
});

test('submit: already finalized attempt is rejected before any WaseetAI call', async () => {
  resetState({ attempt: attemptFixture({ status: 'COMPLETED' }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, 'user-1'), (e: any) => e.statusCode === 409);
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
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1'), (e: any) => e.statusCode === 409);
  assert.equal(state.txUpdates.length, 0);
});

test('submit: a fresh grading claim by another transport is not re-graded', async () => {
  resetState({
    attempt: attemptFixture({ submittedAnswers: { answers: {}, gradingClaimedAt: new Date().toISOString() } }),
    client: { submitAssessment: async () => { throw new Error('must not be called'); } }
  });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', {}, 'user-1'), (e: any) => e.statusCode === 409);
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
  assert.equal(specUpdate.data.status, 'UNDER_AI_REVIEW', 'a pass is never an automatic approval');
  assert.equal(specUpdate.data.isPassed, true);
  assert.ok(!('badgeGrantedAt' in specUpdate.data));
  assert.equal(res.awaitingAdminApproval, true);
  assert.equal(res.specialtyApproved, false);
  assert.equal(state.userUpdates.length, 0, 'tier is not changed at pass');
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
  assert.equal(state.txUpdates.find((u: any) => u.model === 'specialty').data.status, 'UNDER_AI_REVIEW');
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
    await assert.rejects(() => aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1'), (e: any) => e.statusCode === 409);
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

test('assessment files (WaseetAI-linked) have no internal LlmClient reference and no kill switch', () => {
  for (const f of ['./ai-assessment.service.ts', '../controllers/ai-assessment.controller.ts', '../sockets/assessment.gateway.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/gemini/i.test(src), `${f} must not reference Gemini`);
    assert.ok(!/AI_ASSESSMENT_GENERATION_ENABLED|AI_ASSESSMENT_UNAVAILABLE/.test(src), `${f} must not keep the kill switch`);
  }
});

// ── #20: review flags (advisory only) and per-answer receive times ────────────────────────────────────────────────────────────────────────

test('record answer: stores the first answer time of a question (server clock), never moves it, ignores unknown questions / foreign attempts', async () => {
  resetState({ claimExisting: attemptFixture() });
  const { recordAssessmentAnswer } = await loadSvc();
  assert.equal(await recordAssessmentAnswer('user-1', 'att-1', '2', 'b', new Date(1000)), true);
  const stored = state.txUpdates.find((u: any) => u.model === 'attempt').data.analyzedAssetsSnapshot;
  assert.deepEqual(stored.answerLog, [{ q: '2', a: 'b', t: 1000 }]);
  assert.equal(stored.vendorAttemptId, 'vendor-9', 'the vendor attempt id next to it is preserved');
  // a second report for the same question changes nothing (first-answer time is kept)
  resetState({ claimExisting: attemptFixture({ analyzedAssetsSnapshot: { vendorAttemptId: 'vendor-9', answerLog: [{ q: '2', a: 'b', t: 1000 }] } }) });
  assert.equal(await recordAssessmentAnswer('user-1', 'att-1', '2', 'c', new Date(5000)), true);
  assert.equal(state.txUpdates.length, 0);
  // unknown question / no such attempt for this user
  resetState({ claimExisting: attemptFixture() });
  assert.equal(await recordAssessmentAnswer('user-1', 'att-1', '99', 'a'), false);
  resetState({ claimExisting: null });
  assert.equal(await recordAssessmentAnswer('user-2', 'att-1', '1', 'a'), false);
  assert.equal(state.txUpdates.length, 0);
});

test('submit: a too-fast, uniform attempt is MARKED for review (flags stored with the measurements) and is still graded normally — score/status untouched', async () => {
  resetState({
    attempt: attemptFixture({ startedAt: new Date(Date.now() - 20 * 1000), questionsPayload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(vq),
      analyzedAssetsSnapshot: { provider: 'WASEET_AI', vendorAttemptId: 'vendor-9', answerLog: [1, 2, 3, 4, 5].map(i => ({ q: String(i), a: 'a', t: Date.now() - 20000 + i * 500 })) } }),
    client: { submitAssessment: async () => gradedOk({ score: 35, isPassed: false }) }
  });
  const { aiAssessmentService } = await loadSvc();
  const answers = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => [String(i), 'a']));
  const res = await aiAssessmentService.submitAssessment('att-1', answers, 'user-1');
  assert.equal(res.score, 35);
  assert.equal(res.status, 'FAILED');
  const data = state.txUpdates.find((u: any) => u.model === 'attempt').data;
  assert.equal(data.score, 35);
  assert.equal(data.status, 'FAILED');
  const review = data.analyzedAssetsSnapshot.review;
  assert.equal(review.flagged, true);
  assert.deepEqual(review.flags.map((f: any) => f.code).sort(), ['FAST_ANSWERS', 'TOTAL_TIME_TOO_SHORT', 'UNIFORM_ANSWERS']);
  assert.equal(data.analyzedAssetsSnapshot.vendorAttemptId, 'vendor-9');
  assert.equal(review.measured.totalSeconds >= 19, true);
});

test('submit: a normal attempt (enough time, varied answers, slow answers) is not marked; legacy attempts are evaluated too', async () => {
  const qs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(vq);
  const varied: Record<string, string> = { '1': 'a', '2': 'c', '3': 'b', '4': 'd', '5': 'a', '6': 'b', '7': 'd', '8': 'c', '9': 'b', '10': 'a' };
  const start = Date.now() - 300 * 1000;
  resetState({
    attempt: attemptFixture({ startedAt: new Date(start), questionsPayload: qs, analyzedAssetsSnapshot: { vendorAttemptId: 'vendor-9', answerLog: qs.map((q, i) => ({ q: String(q.id), a: 'a', t: start + (i + 1) * 20000 })) } }),
    client: { submitAssessment: async () => gradedOk() }
  });
  const { aiAssessmentService } = await loadSvc();
  await aiAssessmentService.submitAssessment('att-1', varied, 'user-1');
  const review = state.txUpdates.find((u: any) => u.model === 'attempt').data.analyzedAssetsSnapshot.review;
  assert.equal(review.flagged, false);
  assert.deepEqual(review.flags, []);

  resetState({ attempt: legacyAttempt({ startedAt: new Date(Date.now() - 10 * 1000) }) });
  await aiAssessmentService.submitAssessment('att-1', { '1': 'b', '2': 'b', '3': 'b', '4': 'b' }, 'user-1');
  const legacy = state.updateManys.find((u: any) => u.data?.analyzedAssetsSnapshot);
  assert.equal(legacy.data.analyzedAssetsSnapshot.review.flags.some((f: any) => f.code === 'TOTAL_TIME_TOO_SHORT'), true);
  assert.equal(legacy.data.status, 'COMPLETED');
});

// ── claim eligibility, retake policy, outcome policy ─────────────────────────

const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3600 * 1000;
const noWaseet = { createAssessment: async () => { throw new Error('WaseetAI must not be called'); } };

for (const [label, row] of [
  ['APPROVED', { status: 'APPROVED', isActive: true, isPassed: true }],
  ['passed and awaiting admin', { status: 'UNDER_AI_REVIEW', isActive: true, isPassed: true }],
  ['inactive', { status: 'UNDER_AI_REVIEW', isActive: false, isPassed: false }],
  ['LOCKED_OUT', { status: 'LOCKED_OUT', isActive: true, isPassed: false }]
] as const) {
  test(`claim: ${label} specialty is refused with a coded 409, nothing is created and WaseetAI is never called`, async () => {
    resetState({ specialtyRow: row, client: noWaseet });
    const { aiAssessmentService } = await loadSvc();
    await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => e.code === 'ASSESSMENT_NOT_ELIGIBLE' && e.statusCode === 409);
    assert.equal(state.creates.length, 0);
    assert.equal(state.updates.length, 0);
  });
}

test('claim: an unknown specialty row is a coded 404 SPECIALTY_NOT_FOUND', async () => {
  resetState({ specialtyRow: null, client: noWaseet });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => e.code === 'SPECIALTY_NOT_FOUND' && e.statusCode === 404);
  assert.equal(state.creates.length, 0);
});

test('claim: a REJECTED, active, not-passed specialty with no recent attempts may start', async () => {
  resetState({ specialtyRow: { status: 'REJECTED', isActive: true, isPassed: false }, client: { createAssessment: async () => ({ attemptId: 'v', timeLimitMinutes: 15, questions: [vq(1)] }) } });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.generateAssessment('spec-1', 'user-1');
  assert.equal(res.attemptId, 'reserved-1');
});

test('claim: retake within the 24h cooldown -> 429 ASSESSMENT_COOLDOWN with retryAfterSeconds, nothing created', async () => {
  resetState({ recentAttempts: [{ completedAt: ago(2 * HOUR), createdAt: ago(3 * HOUR) }], client: noWaseet });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => {
    const expected = 22 * 3600;
    return e.code === 'ASSESSMENT_COOLDOWN' && e.statusCode === 429 && typeof e.retryAfterSeconds === 'number' && Math.abs(e.retryAfterSeconds - expected) <= 5;
  });
  assert.equal(state.creates.length, 0);
});

test('claim: after the cooldown has elapsed a new attempt is allowed', async () => {
  resetState({ recentAttempts: [{ completedAt: ago(25 * HOUR), createdAt: ago(26 * HOUR) }], client: { createAssessment: async () => ({ attemptId: 'v', timeLimitMinutes: 15, questions: [vq(1)] }) } });
  const { aiAssessmentService } = await loadSvc();
  await aiAssessmentService.generateAssessment('spec-1', 'user-1');
  assert.equal(state.creates.length, 1);
});

test('claim: 5 counted attempts in 30 days -> 429 ASSESSMENT_ATTEMPT_LIMIT, even when the last one is old', async () => {
  const recent = Array.from({ length: 5 }, (_, i) => ({ completedAt: ago((30 + i) * HOUR), createdAt: ago((31 + i) * HOUR) }));
  resetState({ recentAttempts: recent, client: noWaseet });
  const { aiAssessmentService } = await loadSvc();
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => e.code === 'ASSESSMENT_ATTEMPT_LIMIT' && e.statusCode === 429);
  assert.equal(state.creates.length, 0);
});

test('claim: only COMPLETED/FAILED/EXPIRED in the last 30 days are counted (CANCELLED / released generations do not consume a try)', async () => {
  resetState({ client: { createAssessment: async () => ({ attemptId: 'v', timeLimitMinutes: 15, questions: [vq(1)] }) } });
  const { aiAssessmentService } = await loadSvc();
  await aiAssessmentService.generateAssessment('spec-1', 'user-1');
  const where = state.findManys[0].where;
  assert.deepEqual(where.status.in.slice().sort(), ['COMPLETED', 'EXPIRED', 'FAILED']);
  assert.ok(!where.status.in.includes('CANCELLED') && !where.status.in.includes('STREAMING') && !where.status.in.includes('IN_PROGRESS'));
  const days = (Date.now() - where.createdAt.gte.getTime()) / (24 * HOUR);
  assert.ok(days > 29.9 && days < 30.1);
  assert.equal(where.providerSpecialtyId, 'spec-1');
});

test('claim: an active attempt is reused even if the cooldown / attempt limit / pass flag would otherwise refuse (never blocked)', async () => {
  resetState({
    specialtyRow: { status: 'UNDER_AI_REVIEW', isActive: true, isPassed: false },
    recentAttempts: Array.from({ length: 6 }, () => ({ completedAt: ago(HOUR), createdAt: ago(2 * HOUR) })),
    claimExisting: { id: 'active-1', questionsPayload: [vq(1), vq(2)], analyzedAssetsSnapshot: null },
    client: noWaseet
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.generateAssessment('spec-1', 'user-1');
  assert.equal(res.attemptId, 'active-1');
  assert.equal(state.creates.length, 0);
  assert.equal(state.findManys.length, 0, 'the retake policy is not even evaluated for a reused attempt');
});

test('claim: a second start while the first is still STREAMING -> GENERATION_IN_PROGRESS, no second row', async () => {
  resetState({ onCreate: (row: any) => { state.claimExisting = { id: row.id, questionsPayload: row.questionsPayload, analyzedAssetsSnapshot: null }; } , client: noWaseet });
  const { claimAssessmentGeneration, aiAssessmentService } = await loadSvc();
  const first = await claimAssessmentGeneration('spec-1', 'profile-1', 'specialty-1');
  assert.equal(first.claimed, true);
  await assert.rejects(() => aiAssessmentService.generateAssessment('spec-1', 'user-1'), (e: any) => e.code === 'GENERATION_IN_PROGRESS');
  const second = await claimAssessmentGeneration('spec-1', 'profile-1', 'specialty-1');
  assert.equal(second.claimed, false);
  assert.equal(second.attemptId, 'reserved-1');
  assert.equal(state.creates.length, 1);
});

// outcome policy matrix (graded through the real submit pipeline)
const specUpdateOf = () => state.txUpdates.find((u: any) => u.model === 'specialty').data;

for (const [from, to] of [['UNDER_AI_REVIEW', 'UNDER_AI_REVIEW'], ['REJECTED', 'UNDER_AI_REVIEW'], ['APPROVED', 'APPROVED']] as const) {
  test(`outcome: PASS on ${from} -> ${to}; records isPassed/quizScore, never writes badgeGrantedAt, never touches the tier`, async () => {
    resetState({
      specialtyRow: { status: from, isPassed: from === 'APPROVED', passedAt: null, quizScore: null },
      attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk({ score: 77, isPassed: true }) }
    });
    const { aiAssessmentService } = await loadSvc();
    const res = await aiAssessmentService.submitAssessment('att-1', { '1': 'a' }, 'user-1');
    const d = specUpdateOf();
    assert.equal(d.status, to);
    assert.equal(d.isPassed, true);
    assert.equal(d.quizScore, 77);
    assert.equal(d.latestScore, 77);
    assert.equal(d.hasTakenAssessment, true);
    assert.ok(d.passedAt instanceof Date);
    assert.ok(!('badgeGrantedAt' in d));
    assert.equal(res.specialtyStatus, to);
    assert.equal(res.specialtyApproved, from === 'APPROVED');
    assert.equal(res.awaitingAdminApproval, from !== 'APPROVED');
    assert.equal(state.userUpdates.length, 0);
  });
}

test('outcome: PASS keeps an existing passedAt (first pass time is not moved)', async () => {
  const first = new Date('2026-01-01T00:00:00Z');
  resetState({ specialtyRow: { status: 'UNDER_AI_REVIEW', isPassed: true, passedAt: first, quizScore: 70 }, attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk() } });
  const { aiAssessmentService } = await loadSvc();
  await aiAssessmentService.submitAssessment('att-1', {}, 'user-1');
  assert.equal(specUpdateOf().passedAt, first);
});

test('outcome: FAIL on APPROVED leaves status/isPassed/passedAt/badge/quizScore untouched; only hasTakenAssessment + latestScore change', async () => {
  resetState({
    specialtyRow: { status: 'APPROVED', isPassed: true, passedAt: new Date(), quizScore: 90 },
    attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk({ score: 20, isPassed: false }) }
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', {}, 'user-1');
  assert.deepEqual(specUpdateOf(), { hasTakenAssessment: true, latestScore: 20 });
  assert.equal(res.specialtyStatus, 'APPROVED');
  assert.equal(res.specialtyApproved, true);
  assert.equal(state.userUpdates.length, 0);
});

test('outcome: FAIL on a specialty that already passed (awaiting admin) is not downgraded either', async () => {
  resetState({
    specialtyRow: { status: 'UNDER_AI_REVIEW', isPassed: true, passedAt: new Date(), quizScore: 80 },
    attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk({ score: 10, isPassed: false }) }
  });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', {}, 'user-1');
  assert.deepEqual(specUpdateOf(), { hasTakenAssessment: true, latestScore: 10 });
  assert.equal(res.specialtyStatus, 'UNDER_AI_REVIEW');
});

test('outcome: FAIL on a non-approved specialty -> REJECTED, isPassed false, badge cleared', async () => {
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk({ score: 10, isPassed: false }) } });
  const { aiAssessmentService } = await loadSvc();
  const res = await aiAssessmentService.submitAssessment('att-1', {}, 'user-1');
  const d = specUpdateOf();
  assert.equal(d.status, 'REJECTED');
  assert.equal(d.isPassed, false);
  assert.equal(d.passedAt, null);
  assert.equal(d.badgeGrantedAt, null);
  assert.equal(res.specialtyApproved, false);
  assert.equal(res.awaitingAdminApproval, false);
});

test('assessmentResultMessage: a pass never claims approval unless the specialty is really approved', async () => {
  const { assessmentResultMessage } = await loadSvc();
  const awaiting = assessmentResultMessage({ isPassed: true, specialtyApproved: false, awaitingAdminApproval: true });
  assert.match(awaiting, /بعد قرار الإدارة/);
  assert.ok(!/تم اعتماد التخصص|شارة اعتماد/.test(awaiting));
  assert.ok(!/بعد قرار الإدارة/.test(assessmentResultMessage({ isPassed: true, specialtyApproved: true })));
  assert.match(assessmentResultMessage({ isPassed: false, specialtyApproved: true }), /لم يتأثر/);
  assert.match(assessmentResultMessage({ isPassed: false, specialtyApproved: false }), /إعادة المحاولة/);
});

test('static: the controller and gateway never announce an approval / badge on a pass', () => {
  for (const f of ['../controllers/ai-assessment.controller.ts', '../sockets/assessment.gateway.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!src.includes('تم اعتماد التخصص'), `${f}: no approval wording`);
    assert.ok(!src.includes('شارة اعتماد الجدارة'), `${f}: no badge wording`);
    assert.ok(!/'APPROVED'/.test(src), `${f}: no APPROVED status literal`);
  }
});

// ── REST controller status codes (never a 500 for business refusals) ─────────

async function runCtl(name: 'generateAssessmentController' | 'submitAssessmentController', req: any) {
  const ctl = await import('../controllers/ai-assessment.controller.ts');
  const out: any = {};
  const res: any = { status: (c: number) => { out.status = c; return res; }, json: (b: any) => { out.body = b; return res; } };
  await ctl[name](req, res);
  return out;
}
const genReq = { body: { providerSpecialtyId: 'spec-1' }, params: {}, user: { id: 'user-1' } };
const subReq = (userId = 'user-1') => ({ params: { attemptId: 'att-1' }, body: { answers: { '1': 'a' } }, user: { id: userId } });

test('REST generate: not-eligible -> 409 with code; cooldown -> 429 with code + retryAfterSeconds; attempt limit -> 429; unknown specialty -> 404', async () => {
  resetState({ specialtyRow: { status: 'APPROVED', isActive: true, isPassed: true }, client: noWaseet });
  let r = await runCtl('generateAssessmentController', genReq);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ASSESSMENT_NOT_ELIGIBLE');
  assert.equal(r.body.success, false);

  resetState({ recentAttempts: [{ completedAt: ago(HOUR), createdAt: ago(2 * HOUR) }], client: noWaseet });
  r = await runCtl('generateAssessmentController', genReq);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'ASSESSMENT_COOLDOWN');
  assert.ok(r.body.retryAfterSeconds > 0);

  resetState({ recentAttempts: Array.from({ length: 5 }, () => ({ completedAt: ago(48 * HOUR), createdAt: ago(49 * HOUR) })), client: noWaseet });
  r = await runCtl('generateAssessmentController', genReq);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'ASSESSMENT_ATTEMPT_LIMIT');
  assert.equal(r.body.retryAfterSeconds, undefined);

  resetState({ providerSpecialty: null, client: noWaseet });
  r = await runCtl('generateAssessmentController', genReq);
  assert.equal(r.status, 404);
});

test('REST generate: concurrent start -> 409 GENERATION_IN_PROGRESS; WaseetAI generation failure stays 503', async () => {
  resetState({ claimExisting: { id: 'other', questionsPayload: [], analyzedAssetsSnapshot: null }, client: noWaseet });
  let r = await runCtl('generateAssessmentController', genReq);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'GENERATION_IN_PROGRESS');

  resetState({ client: { createAssessment: async () => { throw new Error('down'); } } });
  const orig = console.error; console.error = () => {};
  try { r = await runCtl('generateAssessmentController', genReq); } finally { console.error = orig; }
  assert.equal(r.status, 503);
});

test('REST submit: unknown / not-owner attempt -> 404, double submit -> 409, grading failure -> 503, pass message is honest', async () => {
  resetState({ attempt: null, client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  let r = await runCtl('submitAssessmentController', subReq('user-2'));
  assert.equal(r.status, 404);

  resetState({ attempt: attemptFixture({ status: 'COMPLETED' }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  r = await runCtl('submitAssessmentController', subReq());
  assert.equal(r.status, 409);

  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => { throw new Error('timeout'); } } });
  const orig = console.error; console.error = () => {};
  try { r = await runCtl('submitAssessmentController', subReq()); } finally { console.error = orig; }
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'ASSESSMENT_GRADING_FAILED');

  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => gradedOk() } });
  r = await runCtl('submitAssessmentController', subReq());
  assert.equal(r.status, 200);
  assert.equal(r.body.data.awaitingAdminApproval, true);
  assert.ok(!/تم اعتماد التخصص|شارة اعتماد/.test(r.body.message));
});
