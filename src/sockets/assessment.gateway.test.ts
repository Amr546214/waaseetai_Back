import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Assessment socket gateway on top of WaseetAI. `prisma` and `waseetAiClient`
// are mocked (module-level, delegating to a per-test `state`); the real
// ai-assessment.service runs underneath. No DB/network.

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
    client: {},
    ...over
  });
}

const prismaMock: any = {
  providerSpecialty: { findFirst: async () => state.providerSpecialty },
  assessmentAttempt: {
    findFirst: async () => state.attempt,
    update: async (args: any) => {
      state.updates.push(args);
      if (state.failFirstUpdate && state.updates.length === 1) throw new Error('db write failed');
      return {};
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
    user: { update: async () => ({}) }
  })
};
mock.module('../config/db', { namedExports: { prisma: prismaMock } });
mock.module('../services/ai/waseet-ai/waseet-ai.client', {
  namedExports: {
    waseetAiClient: {
      createAssessment: (...a: any[]) => state.client.createAssessment(...a),
      submitAssessment: (...a: any[]) => state.client.submitAssessment(...a),
      streamAssessmentQuestions: (...a: any[]) => state.client.streamAssessmentQuestions(...a)
    }
  }
});

let gwPromise: Promise<any> | null = null;
const getRegister = async () => (await (gwPromise ||= import('./assessment.gateway.ts'))).registerAssessmentGateway as (socket: any, io?: any) => void;

function createMockSocket(opts: { userId?: string } = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const socket: any = {
    id: 'socket-test-1',
    userId: opts.userId,
    on: (e: string, h: any) => { handlers[e] = h; },
    once: (e: string, h: any) => { (onceHandlers[e] ||= []).push(h); },
    off: (e: string, h?: any) => { if (onceHandlers[e]) onceHandlers[e] = h ? onceHandlers[e].filter((x) => x !== h) : []; },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); },
    join: () => {}
  };
  return { socket, handlers, emitted, triggerDisconnect: () => (onceHandlers['disconnect'] || []).forEach((h) => h()) };
}

const vq = (id: number) => ({ id, textAr: `سؤال ${id}`, options: [{ id: 'a', text: 'أ' }, { id: 'b', text: 'ب' }, { id: 'c', text: 'ج' }, { id: 'd', text: 'د' }] });

function attemptFixture(over: Partial<any> = {}) {
  return {
    id: 'db-attempt-uuid-1',
    providerSpecialtyId: 'spec-1',
    providerProfileId: 'profile-1',
    totalQuestions: 4,
    status: 'IN_PROGRESS',
    startedAt: new Date(),
    timeLimitMinutes: 15,
    submittedAnswers: null,
    questionsPayload: [1, 2, 3, 4].map(vq),
    analyzedAssetsSnapshot: { provider: 'WASEET_AI', vendorAttemptId: 'vendor-9' },
    providerSpecialty: { specialty: { nameAr: 'تطوير الويب' }, providerProfile: { userId: 'user-1' } },
    ...over
  };
}

async function setup(userId: string | null) {
  const register = await getRegister();
  const m = createMockSocket({ userId: userId ?? undefined });
  register(m.socket);
  return m;
}

const START = { providerSpecialtyId: 'spec-1' };

// ── start_assessment ─────────────────────────────────────────────────────

test('start_assessment: unauthenticated socket is rejected, no claim, no WaseetAI call', async () => {
  resetState({ client: { streamAssessmentQuestions: () => { throw new Error('must not be called'); } } });
  const { handlers, emitted } = await setup(null);
  await handlers['start_assessment'](START);
  assert.equal(emitted[0].event, 'assessment_error');
  assert.equal(state.creates.length, 0);
});

test('start_assessment: a specialty the user does not own is rejected', async () => {
  resetState({ providerSpecialty: null, client: { streamAssessmentQuestions: () => { throw new Error('must not be called'); } } });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment'](START);
  assert.equal(emitted[0].event, 'assessment_error');
  assert.equal(state.creates.length, 0);
});

test('start_assessment: relays WaseetAI questions in order on the UI socket events, key-less, with the reported generationSource', async () => {
  let reqBody: any;
  resetState({
    client: {
      streamAssessmentQuestions: async function* (body: any) {
        reqBody = body;
        for (let i = 1; i <= 3; i++) yield { type: 'question', attemptId: 'v-1', question: vq(i) };
        yield { type: 'assessment_ready', attemptId: 'v-1', totalQuestions: 3, timeLimitMinutes: 15, generationSource: 'VENDOR_SRC' };
        yield { type: 'completed' };
      }
    }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment']({ ...START, specialtyName: 'client supplied name must be ignored' });

  assert.deepEqual(reqBody, { providerSpecialtyId: 'spec-1', specialtyName: 'تطوير الويب', questionCount: 20, timeLimitMinutes: 15 });
  const events = emitted.map((e) => e.event);
  assert.deepEqual(events, ['question_streamed', 'question_streamed', 'question_streamed', 'assessment_ready']);
  assert.deepEqual(emitted.slice(0, 3).map((e) => [e.payload.questionIndex, e.payload.question.id]), [[1, 1], [2, 2], [3, 3]]);
  assert.equal(emitted[0].payload.attemptId, 'reserved-1');
  assert.ok(!JSON.stringify(emitted).includes('correctAnswer'));
  const ready = emitted[3].payload;
  assert.equal(ready.attemptId, 'reserved-1');
  assert.equal(ready.totalQuestions, 3);
  assert.equal(ready.generationSource, 'VENDOR_SRC', 'relayed verbatim, never relabelled');

  const persisted = state.updates[0].data;
  assert.equal(persisted.status, 'IN_PROGRESS');
  assert.equal(persisted.analyzedAssetsSnapshot.vendorAttemptId, 'v-1');
  assert.ok(!JSON.stringify(persisted.questionsPayload).includes('correctAnswer'));
});

test('start_assessment: generationSource is omitted when WaseetAI reports none', async () => {
  resetState({
    client: {
      streamAssessmentQuestions: async function* () {
        yield { type: 'question', attemptId: 'v-1', question: vq(1) };
        yield { type: 'assessment_ready', attemptId: 'v-1', totalQuestions: 1, timeLimitMinutes: 15 };
      }
    }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment'](START);
  const ready = emitted.find((e) => e.event === 'assessment_ready')!;
  assert.ok(!('generationSource' in ready.payload));
});

test('start_assessment: WaseetAI failure emits assessment_error and releases the reservation', async () => {
  resetState({
    client: { streamAssessmentQuestions: async function* () { yield { type: 'question', attemptId: 'v-1', question: vq(1) }; throw new Error('upstream'); } }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment'](START);
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'assessment_error');
  assert.equal(last.payload.code, 'ASSESSMENT_GENERATION_FAILED');
  assert.ok(!emitted.some((e) => e.event === 'assessment_ready'));
  assert.deepEqual(state.updates.map((u: any) => u.data.status), ['CANCELLED']);
});

test('start_assessment: claim lost while generation in flight -> error, no WaseetAI call', async () => {
  resetState({ claimExisting: { id: 'other', questionsPayload: [], analyzedAssetsSnapshot: null }, client: { streamAssessmentQuestions: () => { throw new Error('must not be called'); } } });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment'](START);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'assessment_error');
});

test('start_assessment: claim lost with finished questions replays them (keys stripped) without calling WaseetAI', async () => {
  resetState({
    claimExisting: { id: 'other', questionsPayload: [{ ...vq(1), correctAnswer: 'b', explanation: 'x' }, vq(2)], analyzedAssetsSnapshot: { generationSource: 'GEMINI' } },
    client: { streamAssessmentQuestions: () => { throw new Error('must not be called'); } }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment'](START);
  assert.deepEqual(emitted.map((e) => e.event), ['question_streamed', 'question_streamed', 'assessment_ready']);
  assert.ok(!JSON.stringify(emitted).includes('correctAnswer'));
  assert.equal(emitted[2].payload.attemptId, 'other');
  assert.equal(emitted[2].payload.generationSource, 'GEMINI', 'stored source of a pre-existing attempt is replayed as stored');
});

test('start_assessment: disconnect aborts the WaseetAI stream and releases the reservation', async () => {
  let aborted = false;
  let started!: () => void;
  const startedP = new Promise<void>((r) => { started = r; });
  resetState({
    client: {
      streamAssessmentQuestions: async function* (_b: any, o: any) {
        started();
        await new Promise<void>((_, rej) => o.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }));
        yield { type: 'completed' };
      }
    }
  });
  const m = await setup('user-1');
  const run = m.handlers['start_assessment'](START);
  await startedP;
  m.triggerDisconnect();
  await run;
  assert.equal(aborted, true);
  assert.deepEqual(state.updates.map((u: any) => u.data.status), ['CANCELLED']);
});

// ── submit ───────────────────────────────────────────────────────────────

test('submit_answer: unauthenticated socket is rejected', async () => {
  resetState();
  const { handlers, emitted } = await setup(null);
  await handlers['submit_answer']({ attemptId: 'a', answers: {} });
  assert.equal(emitted[0].payload.code, 'AUTH_REQUIRED');
});

test('submit_answer: an attempt not owned by the user is NOT_FOUND, never graded', async () => {
  resetState({ attempt: null, client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { handlers, emitted } = await setup('user-2');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });
  assert.equal(emitted[0].payload.code, 'NOT_FOUND');
});

test('submit_answer: more than 30 submissions within the window are rate-limited', async () => {
  resetState({ attempt: null });
  const { handlers, emitted } = await setup('rate-limited-user');
  for (let i = 0; i < 35; i++) await handlers['submit_answer']({ attemptId: 'x', answers: {} });
  assert.ok(emitted.some((e) => e.payload?.code === 'RATE_LIMITED'));
});

test('submit_answer: graded by WaseetAI; evaluation_complete carries its score/pass/feedback and no invented correct count', async () => {
  resetState({
    attempt: attemptFixture(),
    client: { submitAssessment: async () => ({ attemptId: 'vendor-9', score: 72.5, isPassed: true, status: 'COMPLETED', feedbackAr: 'جيد', strengths: ['س'], weaknesses: ['ض'] }) }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b' } });
  const evt = emitted.find((e) => e.event === 'evaluation_complete')!;
  assert.equal(evt.payload.score, 72.5);
  assert.equal(evt.payload.scorePercentage, 72.5);
  assert.equal(evt.payload.status, 'PASSED');
  assert.equal(evt.payload.specialtyStatus, 'UNDER_AI_REVIEW');
  assert.equal(evt.payload.specialtyApproved, false);
  assert.equal(evt.payload.awaitingAdminApproval, true);
  assert.equal(evt.payload.feedbackAr, 'جيد');
  assert.deepEqual(evt.payload.strengths, ['س']);
  assert.ok(!('correctAnswers' in evt.payload));
  assert.equal(state.txUpdates.find((u: any) => u.model === 'specialty').data.latestScore, 72.5);
  assert.equal(state.txUpdates.find((u: any) => u.model === 'specialty').data.status, 'UNDER_AI_REVIEW');
});

test('submit_answer: WaseetAI not-passed result is reported as FAILED', async () => {
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => ({ attemptId: 'v', score: 10, isPassed: false, status: 'COMPLETED', feedbackAr: 'ضعيف', strengths: [], weaknesses: [] }) } });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });
  assert.equal(emitted.find((e) => e.event === 'evaluation_complete')!.payload.status, 'FAILED');
});

test('submit_answer: grading failure emits retryable SUBMISSION_FAILED, no result, claim released', async () => {
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => { throw new Error('timeout'); } } });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'a' } });
  assert.ok(!emitted.some((e) => e.event === 'evaluation_complete'));
  assert.equal(emitted[emitted.length - 1].payload.code, 'SUBMISSION_FAILED');
  assert.equal(state.txUpdates.length, 0);
  assert.ok(state.updateManys.some((u: any) => u.data.submittedAnswers !== undefined && u.data.score === undefined));
});

test('submit_answer: a finalized attempt is ALREADY_FINALIZED (terminal, not retryable)', async () => {
  resetState({ attempt: attemptFixture({ status: 'COMPLETED' }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });
  assert.equal(emitted[0].payload.code, 'ALREADY_FINALIZED');
});

test('submit_answer: losing the atomic claim to the REST twin spends no WaseetAI call', async () => {
  resetState({ attempt: attemptFixture(), updateManyResult: () => ({ count: 0 }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_assessment']({ attemptId: 'db-attempt-uuid-1', answers: {} });
  assert.equal(emitted[0].payload.code, 'ALREADY_FINALIZED');
});

test('submit_answer: late submission is EXPIRED by our timing, never graded, no specialty result', async () => {
  resetState({ attempt: attemptFixture({ startedAt: new Date(Date.now() - 17 * 60 * 1000) }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });
  const evt = emitted.find((e) => e.event === 'evaluation_complete')!;
  assert.equal(evt.payload.status, 'EXPIRED');
  assert.equal(evt.payload.score, 0);
  assert.equal(state.txUpdates.length, 0);
});

test('submit_answer: legacy local-key attempt is still graded locally with factual feedback', async () => {
  resetState({
    attempt: attemptFixture({
      questionsPayload: [1, 2, 3, 4].map((i) => ({ ...vq(i), correctAnswer: 'b', explanation: 'x' })),
      analyzedAssetsSnapshot: { items: [], generationSource: 'GEMINI' }
    }),
    client: { submitAssessment: async () => { throw new Error('must not be called'); } }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'b', '2': 'b', '3': 'b', '4': 'a' } });
  const evt = emitted.find((e) => e.event === 'evaluation_complete')!;
  assert.equal(evt.payload.score, 75);
  assert.equal(evt.payload.correctAnswers, 3);
  assert.equal(evt.payload.isPassed, true);
  assert.deepEqual(evt.payload.strengths, []);
});

// ── restored guarantees (fast mocked twins of the e2e suite) ─────────────

test('start_assessment: the active-attempt lookup only matches IN_PROGRESS/STREAMING — a COMPLETED historical attempt can never block a new assessment', async () => {
  resetState({
    client: {
      streamAssessmentQuestions: async function* () {
        yield { type: 'question', attemptId: 'v-1', question: vq(1) };
        yield { type: 'assessment_ready', attemptId: 'v-1', totalQuestions: 1, timeLimitMinutes: 15 };
      }
    }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment'](START);
  assert.deepEqual(state.claimWheres[0].where.status.in.slice().sort(), ['IN_PROGRESS', 'STREAMING']);
  assert.equal(state.claimWheres[0].where.providerSpecialtyId, 'spec-1');
  assert.equal(state.creates.length, 1, 'a fresh reservation is created');
  assert.equal(state.creates[0].data.status, 'STREAMING');
  assert.deepEqual(state.creates[0].data.questionsPayload, []);
  assert.ok(emitted.some((e) => e.event === 'assessment_ready'));
});

test('start_assessment: a persist failure after a successful stream releases the reservation to CANCELLED so a retry is never blocked', async () => {
  resetState({
    failFirstUpdate: true,
    client: {
      streamAssessmentQuestions: async function* () {
        yield { type: 'question', attemptId: 'v-1', question: vq(1) };
        yield { type: 'assessment_ready', attemptId: 'v-1', totalQuestions: 1, timeLimitMinutes: 15 };
      }
    }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment'](START);
  assert.ok(!emitted.some((e) => e.event === 'assessment_ready'));
  const last = emitted[emitted.length - 1];
  assert.equal(last.event, 'assessment_error');
  assert.equal(last.payload.code, 'ASSESSMENT_GENERATION_FAILED');
  assert.deepEqual(state.updates.map((u: any) => u.data.status), ['IN_PROGRESS', 'CANCELLED']);
});

test('start_assessment: a user issuing more than 30 requests within the window is rate-limited on the next one', async () => {
  resetState({ providerSpecialty: null });
  const { handlers, emitted } = await setup(`rate-limit-start-${Math.random()}`);
  for (let i = 0; i < 30; i++) await handlers['start_assessment'](START);
  emitted.length = 0;
  await handlers['start_assessment'](START);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'assessment_error');
  assert.match(emitted[0].payload.message, /تجاوز الحد المسموح/);
});

test('start_assessment: missing providerSpecialtyId is rejected before ownership lookup or claim', async () => {
  resetState();
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment']({});
  assert.equal(emitted[0].event, 'assessment_error');
  assert.equal(state.creates.length, 0);
});

test('submit_answer: a missing attemptId is INVALID_REQUEST, nothing graded', async () => {
  resetState({ client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_answer']({ answers: {} });
  assert.equal(emitted[0].payload.code, 'INVALID_REQUEST');
});

for (const status of ['EXPIRED', 'CANCELLED', 'FAILED']) {
  test(`submit_answer: an already-${status} attempt cannot be scored through the socket — rejected before any WaseetAI call`, async () => {
    resetState({ attempt: attemptFixture({ status }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
    const { handlers, emitted } = await setup('user-1');
    await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'a' } });
    assert.equal(emitted[0].payload.code, 'ALREADY_FINALIZED');
    assert.ok(!emitted.some((e) => e.event === 'evaluation_complete'));
    assert.equal(state.updateManys.length, 0);
    assert.equal(state.txUpdates.length, 0);
  });
}

test('submit_answer: a late submission persists EXPIRED once and grants no specialty result', async () => {
  resetState({ attempt: attemptFixture({ startedAt: new Date(Date.now() - 17 * 60 * 1000) }), client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const { handlers } = await setup('user-1');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });
  assert.equal(state.updateManys.length, 1);
  assert.equal(state.updateManys[0].data.status, 'EXPIRED');
  assert.equal(state.txUpdates.length, 0);
});

test('submit_answer: the winning claim persists exactly once — attempt and ProviderSpecialty outcome applied a single time', async () => {
  resetState({
    attempt: attemptFixture(),
    client: { submitAssessment: async () => ({ attemptId: 'vendor-9', score: 80, isPassed: true, status: 'COMPLETED', feedbackAr: 'جيد', strengths: [], weaknesses: [] }) }
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'a' } });
  assert.equal(state.txUpdates.filter((u: any) => u.model === 'attempt').length, 1);
  assert.equal(state.txUpdates.filter((u: any) => u.model === 'specialty').length, 1);
  assert.equal(emitted.filter((e) => e.event === 'evaluation_complete').length, 1);
  const json = JSON.stringify(emitted);
  assert.ok(!json.includes('correctAnswer') && !json.includes('explanation'));
});

test('submit_answer: a genuine unexpected exception (not a business rejection) is reported with the retryable SUBMISSION_FAILED code', async () => {
  resetState({ client: { submitAssessment: async () => { throw new Error('must not be called'); } } });
  const origFind = prismaMock.assessmentAttempt.findFirst;
  prismaMock.assessmentAttempt.findFirst = async () => { throw new Error('connection reset'); };
  try {
    const { handlers, emitted } = await setup('user-1');
    await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'assessment_error');
    assert.equal(emitted[0].payload.code, 'SUBMISSION_FAILED');
  } finally {
    prismaMock.assessmentAttempt.findFirst = origFind;
  }
});

// ── eligibility parity with REST, honest pass wording ────────────────────────

const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3600 * 1000;
const noStream = { streamAssessmentQuestions: () => { throw new Error('WaseetAI must not be called'); } };

for (const [label, row, code] of [
  ['APPROVED', { status: 'APPROVED', isActive: true, isPassed: true }, 'ASSESSMENT_NOT_ELIGIBLE'],
  ['passed awaiting admin', { status: 'UNDER_AI_REVIEW', isActive: true, isPassed: true }, 'ASSESSMENT_NOT_ELIGIBLE'],
  ['inactive', { status: 'UNDER_AI_REVIEW', isActive: false, isPassed: false }, 'ASSESSMENT_NOT_ELIGIBLE'],
  ['LOCKED_OUT', { status: 'LOCKED_OUT', isActive: true, isPassed: false }, 'ASSESSMENT_NOT_ELIGIBLE']
] as const) {
  test(`start_assessment: ${label} specialty emits assessment_error ${code}; nothing created, WaseetAI not called`, async () => {
    resetState({ specialtyRow: row, client: noStream });
    const { handlers, emitted } = await setup('user-1');
    await handlers['start_assessment'](START);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'assessment_error');
    assert.equal(emitted[0].payload.code, code);
    assert.ok(emitted[0].payload.message.length > 0);
    assert.equal(state.creates.length, 0);
  });
}

test('start_assessment: cooldown emits ASSESSMENT_COOLDOWN with retryAfterSeconds; attempt cap emits ASSESSMENT_ATTEMPT_LIMIT', async () => {
  resetState({ recentAttempts: [{ completedAt: ago(HOUR), createdAt: ago(2 * HOUR) }], client: noStream });
  let m = await setup('user-1');
  await m.handlers['start_assessment'](START);
  assert.equal(m.emitted[0].payload.code, 'ASSESSMENT_COOLDOWN');
  assert.ok(m.emitted[0].payload.retryAfterSeconds > 0);
  assert.equal(state.creates.length, 0);

  resetState({ recentAttempts: Array.from({ length: 5 }, () => ({ completedAt: ago(48 * HOUR), createdAt: ago(49 * HOUR) })), client: noStream });
  m = await setup('user-1');
  await m.handlers['start_assessment'](START);
  assert.equal(m.emitted[0].payload.code, 'ASSESSMENT_ATTEMPT_LIMIT');
  assert.ok(!('retryAfterSeconds' in m.emitted[0].payload));
});

test('start_assessment: an active attempt is replayed even when the cooldown would apply', async () => {
  resetState({
    recentAttempts: [{ completedAt: ago(HOUR), createdAt: ago(2 * HOUR) }],
    claimExisting: { id: 'active-1', questionsPayload: [vq(1)], analyzedAssetsSnapshot: null },
    client: noStream
  });
  const { handlers, emitted } = await setup('user-1');
  await handlers['start_assessment'](START);
  assert.deepEqual(emitted.map((e) => e.event), ['question_streamed', 'assessment_ready']);
  assert.equal(state.creates.length, 0);
});

test('start_assessment: a second start while the first is STREAMING gets the in-progress error and no second row', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let startedFirst!: () => void;
  const started = new Promise<void>((r) => { startedFirst = r; });
  resetState({
    onCreate: (row: any) => { state.claimExisting = { id: row.id, questionsPayload: [], analyzedAssetsSnapshot: null }; },
    client: {
      streamAssessmentQuestions: async function* () {
        startedFirst();
        await gate;
        yield { type: 'question', attemptId: 'v-1', question: vq(1) };
        yield { type: 'assessment_ready', attemptId: 'v-1', totalQuestions: 1, timeLimitMinutes: 15 };
      }
    }
  });
  const a = await setup('user-1');
  const b = await setup('user-1');
  const first = a.handlers['start_assessment'](START);
  await started;
  await b.handlers['start_assessment'](START);
  assert.equal(b.emitted.length, 1);
  assert.equal(b.emitted[0].event, 'assessment_error');
  assert.equal(state.creates.length, 1);
  release();
  await first;
  assert.ok(a.emitted.some((e) => e.event === 'assessment_ready'));
});

test('submit_answer: a pass never says APPROVED / badge; evaluation_complete carries awaitingAdminApproval and an honest message', async () => {
  resetState({ attempt: attemptFixture(), client: { submitAssessment: async () => ({ attemptId: 'v', score: 90, isPassed: true, status: 'COMPLETED', feedbackAr: 'ممتاز', strengths: [], weaknesses: [] }) } });
  const { handlers, emitted } = await setup(`parity-${Math.random()}`);
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: { '1': 'a' } });
  const p = emitted.find((e) => e.event === 'evaluation_complete')!.payload;
  assert.equal(p.status, 'PASSED');
  assert.equal(p.awaitingAdminApproval, true);
  assert.equal(p.specialtyApproved, false);
  assert.match(p.message, /بعد قرار الإدارة/);
  const json = JSON.stringify(emitted);
  assert.ok(!json.includes('APPROVED') && !json.includes('شارة اعتماد') && !json.includes('تم اعتماد التخصص'));
});

test('submit_answer: pass on an already APPROVED specialty reports specialtyApproved without awaiting admin; a fail there does not downgrade', async () => {
  resetState({ specialtyRow: { status: 'APPROVED', isPassed: true, passedAt: new Date(), quizScore: 90 }, attempt: attemptFixture(),
    client: { submitAssessment: async () => ({ attemptId: 'v', score: 10, isPassed: false, status: 'COMPLETED', feedbackAr: 'x', strengths: [], weaknesses: [] }) } });
  const { handlers, emitted } = await setup(`parity-${Math.random()}`);
  await handlers['submit_answer']({ attemptId: 'db-attempt-uuid-1', answers: {} });
  const p = emitted.find((e) => e.event === 'evaluation_complete')!.payload;
  assert.equal(p.status, 'FAILED');
  assert.equal(p.specialtyApproved, true);
  assert.deepEqual(state.txUpdates.find((u: any) => u.model === 'specialty').data, { hasTakenAssessment: true, latestScore: 10 });
});
