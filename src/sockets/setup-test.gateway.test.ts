import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';

// Setup test on WaseetAI. prisma and waseetAiClient are mocked; no network.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const tokenFor = (userId: string) => jwt.sign({ userId }, process.env.JWT_SECRET!);

const state: any = {};
function resetState(over: Partial<any> = {}) {
  Object.assign(state, {
    profile: { id: 'profile-1', userId: 'u', mainSpecialty: 'تطوير الويب', industry: null, subSpecialties: ['React', 'Node'], setupTestStatus: 'PENDING', setupTestBannedUntil: null },
    updates: [] as any[],
    streamCalls: [] as any[],
    submitCalls: [] as any[],
    stream: null,
    submit: null,
    ...over
  });
}

const prismaMock: any = {
  providerProfile: {
    findUnique: async () => state.profile,
    update: async (args: any) => { state.updates.push(args); return {}; }
  }
};
mock.module('../config/db', { namedExports: { prisma: prismaMock } });
mock.module('../services/ai/waseet-ai/waseet-ai.client', {
  namedExports: {
    waseetAiClient: {
      streamAssessmentQuestions: (body: any, opts: any) => { state.streamCalls.push({ body, opts }); return state.stream(body, opts); },
      submitAssessment: async (id: string, body: any, opts: any) => { state.submitCalls.push({ id, body, opts }); return state.submit(id, body, opts); }
    }
  }
});

let gwPromise: Promise<any> | null = null;
const getGateway = async () => (await (gwPromise ||= import('./setup-test.gateway.ts')));

const vq = (id: number) => ({ id, textAr: `سؤال ${id}`, options: ['a', 'b', 'c', 'd'].map((o) => ({ id: o, text: `خيار ${o}` })) });
function goodStream(n = 15, attemptId = 'vendor-1') {
  return async function* () {
    for (let i = 1; i <= n; i++) yield { type: 'question', attemptId, question: vq(100 + i) };
    yield { type: 'assessment_ready', attemptId, totalQuestions: n, timeLimitMinutes: 15 };
  };
}

async function setup() {
  const { SetupTestGateway } = await getGateway();
  const handlers: Record<string, (...args: any[]) => any> = {};
  const onceHandlers: Record<string, Array<() => void>> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  const socket: any = {
    on: (e: string, h: any) => { handlers[e] = h; },
    once: (e: string, h: any) => { (onceHandlers[e] ||= []).push(h); },
    off: (e: string, h: any) => { if (onceHandlers[e]) onceHandlers[e] = onceHandlers[e].filter((x) => x !== h); },
    emit: (event: string, payload: any) => { emitted.push({ event, payload }); }
  };
  new SetupTestGateway().register(socket);
  return { handlers, emitted, triggerDisconnect: () => (onceHandlers['disconnect'] || []).forEach((h) => h()) };
}

let uid = 0;
const newUser = () => { const id = `user-${++uid}`; return { id, token: tokenFor(id) }; };
const events = (e: any[]) => e.map((x) => x.event);

async function startTest(m: any, token: string) {
  await m.handlers['setup_test:init']({ token });
  await m.handlers['setup_test:get_question']({ token });
}

test('happy path: 15 questions one by one, no key, single grading call, profile updated with vendor score', async () => {
  resetState({
    stream: goodStream(15),
    submit: async () => ({ attemptId: 'vendor-1', score: 73.5, isPassed: false, status: 'COMPLETED', feedbackAr: 'x', strengths: [], weaknesses: [] })
  });
  const m = await setup();
  const { token } = newUser();
  await startTest(m, token);

  assert.deepEqual(events(m.emitted).slice(0, 3), ['setup_test:generating', 'setup_test:ready', 'setup_test:question']);
  assert.equal(m.emitted[1].payload.totalQuestions, 15);
  const call = state.streamCalls[0].body;
  assert.equal(call.providerSpecialtyId, 'profile-1');
  assert.equal(call.questionCount, 15);
  assert.equal(call.timeLimitMinutes, 15);
  assert.match(call.specialtyName, /تطوير الويب/);
  assert.match(call.specialtyName, /React/);
  assert.deepEqual(Object.keys(call).sort(), ['providerSpecialtyId', 'questionCount', 'specialtyName', 'timeLimitMinutes']);
  assert.equal(JSON.stringify(call).includes(token), false);

  for (let i = 0; i < 15; i++) {
    const q = m.emitted.filter((e) => e.event === 'setup_test:question').pop()!.payload;
    assert.equal(q.index, i);
    assert.equal(q.total, 15);
    assert.equal(q.id, String(101 + i));
    assert.deepEqual(q.options, ['خيار a', 'خيار b', 'خيار c', 'خيار d']);
    assert.equal(state.submitCalls.length, 0);
    await m.handlers['setup_test:answer']({ token, questionId: q.id, selectedIndex: i % 4 });
  }

  assert.equal(state.submitCalls.length, 1);
  const s = state.submitCalls[0];
  assert.equal(s.id, 'vendor-1');
  assert.equal(Object.keys(s.body.submittedAnswers).length, 15);
  assert.equal(s.body.submittedAnswers['101'], 'a');
  assert.equal(s.body.submittedAnswers['102'], 'b');
  assert.equal(s.body.submittedAnswers['104'], 'd');
  assert.equal(s.body.submittedAnswers['105'], 'a');
  assert.equal(typeof s.body.timeSpentSeconds, 'number');
  assert.deepEqual(state.updates.at(-1), { where: { id: 'profile-1' }, data: { setupTestScore: 73.5, setupTestStatus: 'COMPLETED' } });

  const result = m.emitted.at(-1)!;
  assert.equal(result.event, 'setup_test:result');
  assert.equal(result.payload.score, 73.5);
  assert.equal(result.payload.total, 15);
  assert.equal('correct' in result.payload, false);
  assert.equal('passed' in result.payload, false);

  // every emitted payload is free of key-like fields
  for (const e of m.emitted) {
    const s2 = JSON.stringify(e.payload);
    assert.doesNotMatch(s2, /correct|explanation|isCorrect|isPassed/i);
  }
  // session finished: further answers do nothing
  const before = m.emitted.length;
  await m.handlers['setup_test:answer']({ token, questionId: '115', selectedIndex: 0 });
  assert.equal(m.emitted.length, before);
});

test('wrong question id / out-of-range index are ignored', async () => {
  resetState({ stream: goodStream(15), submit: async () => ({ score: 1, isPassed: false }) });
  const m = await setup();
  const { token } = newUser();
  await startTest(m, token);
  const n = m.emitted.length;
  await m.handlers['setup_test:answer']({ token, questionId: '999', selectedIndex: 0 });
  await m.handlers['setup_test:answer']({ token, questionId: '101', selectedIndex: 9 });
  await m.handlers['setup_test:answer']({ token, questionId: '101', selectedIndex: 1.5 });
  assert.equal(m.emitted.length, n);
});

test('grading failure writes nothing, emits retryable error, and re-sending the last answer retries once more', async () => {
  let calls = 0;
  resetState({
    stream: goodStream(3),
    submit: async () => {
      if (++calls === 1) throw new Error('vendor down');
      return { score: 40, isPassed: false };
    }
  });
  const m = await setup();
  const { token } = newUser();
  await startTest(m, token);
  for (let i = 0; i < 3; i++) await m.handlers['setup_test:answer']({ token, questionId: String(101 + i), selectedIndex: 0 });

  assert.equal(state.updates.length, 0);
  const err = m.emitted.at(-1)!;
  assert.equal(err.event, 'setup_test:error');
  assert.equal(err.payload.retryable, true);
  assert.match(err.payload.message, /[؀-ۿ]/);
  assert.equal(m.emitted.some((e) => e.event === 'setup_test:result'), false);

  await m.handlers['setup_test:answer']({ token, questionId: '103', selectedIndex: 2 });
  assert.equal(state.submitCalls.length, 2);
  assert.equal(state.submitCalls[1].body.submittedAnswers['103'], 'c');
  assert.equal(Object.keys(state.submitCalls[1].body.submittedAnswers).length, 3);
  assert.deepEqual(state.updates.at(-1).data, { setupTestScore: 40, setupTestStatus: 'COMPLETED' });
  assert.equal(m.emitted.at(-1)!.event, 'setup_test:result');
});

test('an invalid vendor score is treated as a grading failure (nothing written)', async () => {
  resetState({ stream: goodStream(2), submit: async () => ({ score: 140, isPassed: true }) });
  const m = await setup();
  const { token } = newUser();
  await startTest(m, token);
  for (let i = 0; i < 2; i++) await m.handlers['setup_test:answer']({ token, questionId: String(101 + i), selectedIndex: 0 });
  assert.equal(state.updates.length, 0);
  assert.equal(m.emitted.at(-1)!.event, 'setup_test:error');
});

test('generation failure: error, no session, no profile writes', async () => {
  resetState({ stream: async function* () { throw new Error('boom'); } });
  const m = await setup();
  const { token } = newUser();
  await startTest(m, token);
  assert.deepEqual(events(m.emitted), ['setup_test:generating', 'setup_test:error']);
  assert.equal(state.updates.length, 0);
  assert.equal(state.submitCalls.length, 0);
});

test('inconsistent stream (ready total mismatch) is a generation failure', async () => {
  resetState({
    stream: async function* () {
      yield { type: 'question', attemptId: 'v', question: vq(1) };
      yield { type: 'assessment_ready', attemptId: 'v', totalQuestions: 5, timeLimitMinutes: 15 };
    }
  });
  const m = await setup();
  const { token } = newUser();
  await startTest(m, token);
  assert.equal(m.emitted.at(-1)!.event, 'setup_test:error');
  assert.equal(m.emitted.some((e) => e.event === 'setup_test:ready'), false);
});

test('invalid token and missing token are auth errors with no work done', async () => {
  resetState({ stream: goodStream(15) });
  const m = await setup();
  await m.handlers['setup_test:init']({ token: 'bad' });
  await m.handlers['setup_test:init']({});
  assert.deepEqual(events(m.emitted), ['setup_test:error', 'setup_test:error']);
  assert.equal(state.streamCalls.length, 0);
});

test('missing profile and missing specialty produce errors without calling WaseetAI', async () => {
  resetState({ profile: null, stream: goodStream(15) });
  let m = await setup();
  await m.handlers['setup_test:init']({ token: newUser().token });
  assert.equal(m.emitted.at(-1)!.event, 'setup_test:error');

  resetState({ profile: { id: 'p', mainSpecialty: null, industry: null, subSpecialties: [], setupTestStatus: 'PENDING' }, stream: goodStream(15) });
  m = await setup();
  await m.handlers['setup_test:init']({ token: newUser().token });
  assert.equal(m.emitted.at(-1)!.event, 'setup_test:error');
  assert.equal(state.streamCalls.length, 0);
});

test('industry is used when mainSpecialty is empty', async () => {
  resetState({ profile: { id: 'p', mainSpecialty: null, industry: 'التسويق', subSpecialties: [], setupTestStatus: 'PENDING' }, stream: goodStream(15) });
  const m = await setup();
  await m.handlers['setup_test:init']({ token: newUser().token });
  assert.equal(state.streamCalls[0].body.specialtyName, 'التسويق');
});

test('rate limit: blocked before any DB or WaseetAI work', async () => {
  resetState({ stream: goodStream(15) });
  const m = await setup();
  const { token } = newUser();
  for (let i = 0; i < 30; i++) await m.handlers['setup_test:init']({ token });
  const callsBefore = state.streamCalls.length;
  const n = m.emitted.length;
  await m.handlers['setup_test:init']({ token });
  assert.equal(m.emitted.length, n + 1);
  assert.equal(m.emitted.at(-1)!.event, 'setup_test:error');
  assert.equal(state.streamCalls.length, callsBefore);
});

test('disconnect aborts the WaseetAI stream; no ready, no session, no error emitted', async () => {
  let signal: AbortSignal | undefined;
  resetState({
    stream: (_b: any, opts: any) => {
      signal = opts.signal;
      return (async function* () {
        await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve()));
        throw new Error('aborted');
      })();
    }
  });
  const m = await setup();
  const { token } = newUser();
  const p = m.handlers['setup_test:init']({ token });
  await new Promise((r) => setTimeout(r, 10));
  m.triggerDisconnect();
  await p;
  assert.equal(signal?.aborted, true);
  assert.deepEqual(events(m.emitted), ['setup_test:generating']);
  await m.handlers['setup_test:get_question']({ token });
  assert.equal(events(m.emitted).includes('setup_test:question'), false);
  assert.equal(state.updates.length, 0);
});

test('banned profile is reset to PENDING before the test starts (as originally)', async () => {
  resetState({
    profile: { id: 'profile-1', mainSpecialty: 'X', subSpecialties: [], setupTestStatus: 'BANNED', setupTestBannedUntil: new Date() },
    stream: goodStream(15)
  });
  const m = await setup();
  await m.handlers['setup_test:init']({ token: newUser().token });
  assert.deepEqual(state.updates[0], {
    where: { id: 'profile-1' },
    data: { setupTestStatus: 'PENDING', setupTestBannedUntil: null, setupTestCheatAttempts: 0 }
  });
  assert.equal(m.emitted.at(-1)!.event, 'setup_test:ready');
});

test('anti_cheat is accepted as a no-op', async () => {
  resetState({});
  const m = await setup();
  await m.handlers['setup_test:anti_cheat']({ token: 'x', type: 'VISIBILITY_HIDDEN' });
  assert.equal(m.emitted.length, 0);
});

test('static: no Gemini reference, no static question bank, no isPassed use', () => {
  const src = readFileSync(new URL('./setup-test.gateway.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /gemini|generateStructured|correctOptionIndex|fallbackQuestions|isPassed/i);
});
