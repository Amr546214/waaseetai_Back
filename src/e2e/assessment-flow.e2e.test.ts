import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// End-to-end assessment flow against a REAL (throwaway) Postgres and the REAL
// socket.io server + gateway + services. Only WaseetAI is replaced by a local
// fake HTTP server so grading/stream failures can be forced deterministically.
//
// Skipped unless TEST_DATABASE_URL is set. It must point at a disposable
// local database (host localhost/127.0.0.1 and a name containing "e2e"); the
// test refuses anything else. Example:
//   docker run -d --name waseet-e2e-pg -e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e_pass \
//     -e POSTGRES_DB=e2e_test -p 55432:5432 postgres:15-alpine
//   DATABASE_URL=<that url> npx prisma db push --accept-data-loss
//   TEST_DATABASE_URL=<that url> npx tsx --test src/e2e/assessment-flow.e2e.test.ts

const TEST_DB = process.env.TEST_DATABASE_URL;
const enabled = !!TEST_DB && /@(localhost|127\.0\.0\.1)[:/]/.test(TEST_DB) && /e2e/i.test(TEST_DB);
const skip = enabled ? false : 'TEST_DATABASE_URL (disposable local e2e database) not set';

// ── fake WaseetAI ──────────────────────────────────────────────────────────
type StreamMode = 'ok' | 'fail500' | 'hang_after_3';
type SubmitMode = 'ok' | 'fail500';
const fake = {
  streamMode: 'ok' as StreamMode,
  submitMode: 'ok' as SubmitMode,
  streamBodies: [] as any[],
  submitCalls: [] as Array<{ id: string; body: any }>,
  counter: 0,
};
const FAKE_KEY = 'a'; // every question's correct option in the fake grader

function fakeWaseetAi(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (req.url === '/v1/ai/assessments/stream') {
        fake.streamBodies.push(body);
        if (fake.streamMode === 'fail500') { res.writeHead(500).end('{"error":"upstream boom"}'); return; }
        const vendorId = `vendor-att-${++fake.counter}`;
        const n = body.questionCount ?? 20;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (let i = 1; i <= n; i++) {
          if (fake.streamMode === 'hang_after_3' && i === 4) return; // never ends
          sse('question.streamed', { attemptId: vendorId, question: { id: i, textAr: `سؤال ${i}`, options: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: `خيار ${id}` })) } });
        }
        sse('assessment.ready', { attemptId: vendorId, totalQuestions: n, timeLimitMinutes: 15, generationSource: 'TEST' });
        res.end();
        return;
      }
      const m = req.url?.match(/^\/v1\/ai\/assessments\/([^/]+)\/submit$/);
      if (m) {
        fake.submitCalls.push({ id: m[1], body });
        if (fake.submitMode === 'fail500') { res.writeHead(500).end('{"error":"grader down"}'); return; }
        const answers = Object.values(body.submittedAnswers ?? {}) as string[];
        const correct = answers.filter((a) => a === FAKE_KEY).length;
        const score = Math.round((correct / 20) * 100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { attemptId: m[1], score, isPassed: score >= 60, status: 'COMPLETED', feedbackAr: `نتيجتك ${score}%`, strengths: ['قوة اختبارية'], weaknesses: score >= 60 ? [] : ['ضعف اختباري'] } }));
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
}

// ── harness ────────────────────────────────────────────────────────────────
let prisma: any; let fakeServer: http.Server; let appServer: http.Server; let io: any;
let jwtLib: any; let ioClient: any;
const ctx = { userId: '', otherUserId: '', token: '', otherToken: '', port: 0, specialtyIds: [] as string[], psIds: [] as string[], otherPsId: '' };

async function connect(token: string) {
  const socket = ioClient.io(`http://127.0.0.1:${ctx.port}/assessments`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  const events: Array<{ event: string; payload: any }> = [];
  socket.onAny((event: string, payload: any) => events.push({ event, payload }));
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return { socket, events };
}
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout waiting for condition');
};
const has = (events: any[], name: string) => events.filter((e) => e.event === name);

before(async () => {
  if (!enabled) return;
  process.env.DATABASE_URL = TEST_DB!;
  process.env.JWT_SECRET = 'e2e-jwt-secret';
  process.env.WASEET_AI_BEARER_TOKEN = 'e2e-dummy-token';
  fakeServer = fakeWaseetAi();
  await new Promise<void>((r) => fakeServer.listen(0, '127.0.0.1', r));
  process.env.WASEET_AI_BASE_URL = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;
  process.env.WASEET_AI_STREAM_TIMEOUT_MS = '4000';

  ({ prisma } = await import('../config/db'));
  jwtLib = (await import('jsonwebtoken')).default;
  ioClient = await import('socket.io-client');
  const { initSocketServer } = await import('../socket');
  appServer = http.createServer();
  io = initSocketServer(appServer, ['*']);
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
  ctx.port = (appServer.address() as AddressInfo).port;

  const category = await prisma.category.create({ data: { slug: `cat-${Date.now()}`, nameAr: 'تصميم' } });
  const mkUser = async (tag: string) => {
    const user = await prisma.user.create({ data: { accountType: 'PROVIDER_INDIVIDUAL', firstName: 'اختبار', lastName: tag, email: `e2e-${tag}-${Date.now()}@example.test`, activeRole: 'PROVIDER' } });
    const profile = await prisma.providerProfile.create({ data: { userId: user.id } });
    return { user, profile };
  };
  const a = await mkUser('a'); const b = await mkUser('b');
  ctx.userId = a.user.id; ctx.otherUserId = b.user.id;
  const sign = (id: string) => jwtLib.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  ctx.token = sign(a.user.id); ctx.otherToken = sign(b.user.id);
  for (let i = 0; i < 8; i++) {
    const sp = await prisma.specialty.create({ data: { slug: `spec-${i}-${Date.now()}`, categoryId: category.id, nameAr: `تصميم الشعارات ${i}` } });
    ctx.specialtyIds.push(sp.id);
    const ps = await prisma.providerSpecialty.create({ data: { providerProfileId: a.profile.id, specialtyId: sp.id, status: 'PENDING_TEST' } });
    ctx.psIds.push(ps.id);
  }
  const sp = await prisma.specialty.create({ data: { slug: `spec-other-${Date.now()}`, categoryId: category.id, nameAr: 'آخر' } });
  ctx.otherPsId = (await prisma.providerSpecialty.create({ data: { providerProfileId: b.profile.id, specialtyId: sp.id, status: 'PENDING_TEST' } })).id;
});

after(async () => {
  if (!enabled) return;
  io?.close();
  await new Promise((r) => appServer?.close(r as any));
  await new Promise((r) => fakeServer?.close(r as any));
  await prisma?.$disconnect();
});

const startAndFinish = async (psId: string) => {
  const { socket, events } = await connect(ctx.token);
  socket.emit('start_assessment', { providerSpecialtyId: psId, specialtyName: 'CLIENT-SENT-NAME-IGNORED', questionCount: 3 });
  await waitFor(() => has(events, 'assessment_ready').length > 0 || has(events, 'assessment_error').length > 0);
  return { socket, events };
};

// ── tests ──────────────────────────────────────────────────────────────────
test('e2e: start -> save -> questions arrive (no answer key) -> submit -> graded by WaseetAI -> result persisted', { skip }, async () => {
  fake.streamMode = 'ok'; fake.submitMode = 'ok'; fake.streamBodies.length = 0; fake.submitCalls.length = 0;
  const psId = ctx.psIds[0];
  const { socket, events } = await startAndFinish(psId);

  const questions = has(events, 'question_streamed');
  assert.equal(questions.length, 20);
  const ready = has(events, 'assessment_ready')[0].payload;
  assert.equal(ready.totalQuestions, 20);
  assert.equal(ready.generationSource, 'TEST', 'the vendor generationSource is relayed as reported');
  const attemptId = ready.attemptId;
  assert.ok(!String(attemptId).startsWith('vendor-att-'), 'UI sees OUR attempt id, never the vendor id');

  // What WaseetAI received: name from OUR DB, never from the client payload.
  assert.equal(fake.streamBodies.length, 1);
  assert.match(fake.streamBodies[0].specialtyName, /تصميم الشعارات/);
  assert.equal(fake.streamBodies[0].questionCount, 20);

  // Saved: key-less payload + vendor attempt id inside existing JSON columns.
  const row = await prisma.assessmentAttempt.findUnique({ where: { id: attemptId } });
  assert.equal(row.status, 'IN_PROGRESS');
  assert.equal((row.questionsPayload as any[]).length, 20);
  assert.ok(!JSON.stringify(row.questionsPayload).match(/correctAnswer|explanation/));
  assert.match((row.analyzedAssetsSnapshot as any).vendorAttemptId, /^vendor-att-/);

  // Nothing on the wire leaks keys or the vendor id.
  assert.ok(!JSON.stringify(events).match(/correctAnswer|explanation|vendor-att-/));

  // Submit all-correct answers.
  const answers: Record<string, string> = {}; for (let i = 1; i <= 20; i++) answers[String(i)] = FAKE_KEY;
  events.length = 0;
  socket.emit('submit_answer', { attemptId, answers });
  await waitFor(() => has(events, 'evaluation_complete').length + has(events, 'assessment_error').length > 0);
  const result = has(events, 'evaluation_complete')[0]?.payload;
  assert.ok(result, `expected evaluation_complete, got ${JSON.stringify(events)}`);
  assert.equal(result.score, 100);
  assert.equal(result.isPassed, true);
  assert.match(result.feedbackAr, /100%/);
  assert.equal('correctAnswers' in result, false, 'no invented correct-answer count for vendor-graded attempts');
  assert.ok(!JSON.stringify(result).match(/explanation|correctAnswer/));
  assert.equal(fake.submitCalls.length, 1);
  assert.equal(fake.submitCalls[0].id, row.analyzedAssetsSnapshot.vendorAttemptId);

  const done = await prisma.assessmentAttempt.findUnique({ where: { id: attemptId } });
  assert.equal(done.status, 'COMPLETED'); assert.equal(done.score, 100); assert.equal(done.isPassed, true);
  const ps = await prisma.providerSpecialty.findUnique({ where: { id: psId } });
  assert.equal(ps.latestScore, 100); assert.equal(ps.isPassed, true); assert.equal(ps.status, 'APPROVED');

  // Duplicate submissions (sequential + parallel) never regrade or change the result.
  events.length = 0;
  socket.emit('submit_answer', { attemptId, answers: { '1': 'b' } });
  socket.emit('submit_assessment', { attemptId, answers: { '1': 'c' } });
  await waitFor(() => has(events, 'assessment_error').length >= 2);
  assert.ok(has(events, 'assessment_error').every((e) => e.payload.code === 'ALREADY_FINALIZED'));
  assert.equal(fake.submitCalls.length, 1, 'WaseetAI graded exactly once');
  assert.equal((await prisma.assessmentAttempt.findUnique({ where: { id: attemptId } })).score, 100);
  socket.disconnect();
});

test('e2e: concurrent identical submissions are graded once (atomic claim)', { skip }, async () => {
  fake.streamMode = 'ok'; fake.submitMode = 'ok'; fake.submitCalls.length = 0;
  const { socket, events } = await startAndFinish(ctx.psIds[1]);
  const attemptId = has(events, 'assessment_ready')[0].payload.attemptId;
  const answers: Record<string, string> = {}; for (let i = 1; i <= 20; i++) answers[String(i)] = FAKE_KEY;
  events.length = 0;
  socket.emit('submit_answer', { attemptId, answers });
  socket.emit('submit_assessment', { attemptId, answers });
  await waitFor(() => has(events, 'evaluation_complete').length >= 1 && has(events, 'assessment_error').length >= 1);
  assert.equal(fake.submitCalls.length, 1);
  assert.equal(has(events, 'evaluation_complete').length, 1);
  socket.disconnect();
});

test('e2e: WaseetAI grading failure does NOT fail the user or change approval state; retry then succeeds', { skip }, async () => {
  fake.streamMode = 'ok'; fake.submitMode = 'fail500'; fake.submitCalls.length = 0;
  const psId = ctx.psIds[2];
  const before = await prisma.providerSpecialty.findUnique({ where: { id: psId } });
  const { socket, events } = await startAndFinish(psId);
  const attemptId = has(events, 'assessment_ready')[0].payload.attemptId;
  const answers: Record<string, string> = {}; for (let i = 1; i <= 20; i++) answers[String(i)] = FAKE_KEY;

  events.length = 0;
  socket.emit('submit_answer', { attemptId, answers });
  await waitFor(() => has(events, 'assessment_error').length > 0);
  assert.equal(has(events, 'assessment_error')[0].payload.code, 'SUBMISSION_FAILED');
  assert.equal(has(events, 'evaluation_complete').length, 0);
  assert.ok(!JSON.stringify(events).includes('upstream') && !JSON.stringify(events).includes('grader down'), 'no upstream text leaks');

  const att = await prisma.assessmentAttempt.findUnique({ where: { id: attemptId } });
  assert.equal(att.status, 'IN_PROGRESS', 'not FAILED / not COMPLETED');
  assert.equal(att.score, null); assert.equal(att.isPassed, false); assert.equal(att.submittedAnswers, null, 'grading claim released for retry');
  const after = await prisma.providerSpecialty.findUnique({ where: { id: psId } });
  assert.equal(after.status, before.status, 'approval state untouched');
  assert.equal(after.isPassed, before.isPassed); assert.equal(after.hasTakenAssessment, before.hasTakenAssessment); assert.equal(after.latestScore, before.latestScore);

  fake.submitMode = 'ok'; events.length = 0;
  socket.emit('submit_answer', { attemptId, answers });
  await waitFor(() => has(events, 'evaluation_complete').length > 0);
  assert.equal(has(events, 'evaluation_complete')[0].payload.isPassed, true);
  socket.disconnect();
});

test('e2e: a failing (not-passing) grade from WaseetAI is recorded as a real result, a grader outage is not', { skip }, async () => {
  fake.streamMode = 'ok'; fake.submitMode = 'ok';
  const { socket, events } = await startAndFinish(ctx.psIds[3]);
  const attemptId = has(events, 'assessment_ready')[0].payload.attemptId;
  events.length = 0;
  socket.emit('submit_answer', { attemptId, answers: { '1': 'b', '2': 'b' } });
  await waitFor(() => has(events, 'evaluation_complete').length > 0);
  const r = has(events, 'evaluation_complete')[0].payload;
  assert.equal(r.isPassed, false);
  assert.equal((await prisma.assessmentAttempt.findUnique({ where: { id: attemptId } })).status, 'FAILED');
  socket.disconnect();
});

test('e2e: generation failure releases the reservation and leaves approval untouched', { skip }, async () => {
  fake.streamMode = 'fail500';
  const psId = ctx.psIds[4];
  const before = await prisma.providerSpecialty.findUnique({ where: { id: psId } });
  const { socket, events } = await startAndFinish(psId);
  assert.equal(has(events, 'assessment_error')[0].payload.code, 'ASSESSMENT_GENERATION_FAILED');
  assert.ok(!JSON.stringify(events).includes('upstream boom'));
  const rows = await prisma.assessmentAttempt.findMany({ where: { providerSpecialtyId: psId } });
  assert.ok(rows.every((r: any) => r.status === 'CANCELLED'), 'no stuck STREAMING/IN_PROGRESS row');
  const after = await prisma.providerSpecialty.findUnique({ where: { id: psId } });
  assert.equal(after.status, before.status);
  fake.streamMode = 'ok';
  socket.emit('start_assessment', { providerSpecialtyId: psId });
  await waitFor(() => has(events, 'assessment_ready').length > 0);
  socket.disconnect();
});

test('e2e: disconnecting mid-generation aborts it, cancels the reservation, and a new attempt can start', { skip }, async () => {
  fake.streamMode = 'hang_after_3';
  const psId = ctx.psIds[5];
  const { socket, events } = await connect(ctx.token);
  socket.emit('start_assessment', { providerSpecialtyId: psId });
  await waitFor(() => has(events, 'question_streamed').length >= 3);
  socket.disconnect();
  await waitFor(async () => (await prisma.assessmentAttempt.findMany({ where: { providerSpecialtyId: psId } })).every((r: any) => r.status === 'CANCELLED'));
  fake.streamMode = 'ok';
  const again = await startAndFinish(psId);
  assert.equal(has(again.events, 'assessment_ready').length, 1);
  again.socket.disconnect();
});

test('e2e: a second start while an active attempt exists replays the stored questions (no second WaseetAI call)', { skip }, async () => {
  fake.streamMode = 'ok'; fake.streamBodies.length = 0;
  const psId = ctx.psIds[6];
  const first = await startAndFinish(psId);
  const attemptId = has(first.events, 'assessment_ready')[0].payload.attemptId;
  first.socket.disconnect();
  const second = await startAndFinish(psId);
  assert.equal(has(second.events, 'assessment_ready')[0].payload.attemptId, attemptId);
  assert.equal(has(second.events, 'question_streamed').length, 20);
  assert.equal(fake.streamBodies.length, 1);
  assert.ok(!JSON.stringify(second.events).match(/correctAnswer|explanation|vendor-att-/));
  second.socket.disconnect();
});

test('e2e: another user cannot start on, or submit to, someone else\'s attempt', { skip }, async () => {
  fake.streamMode = 'ok'; fake.submitCalls.length = 0;
  const owner = await startAndFinish(ctx.psIds[7]);
  const attemptId = has(owner.events, 'assessment_ready')[0].payload.attemptId;
  const other = await connect(ctx.otherToken);
  other.socket.emit('start_assessment', { providerSpecialtyId: ctx.psIds[7] });
  other.socket.emit('submit_answer', { attemptId, answers: { '1': 'a' } });
  await waitFor(() => has(other.events, 'assessment_error').length >= 2);
  assert.equal(has(other.events, 'evaluation_complete').length, 0);
  assert.equal(fake.submitCalls.length, 0, 'WaseetAI never called for a foreign attempt');
  assert.equal((await prisma.assessmentAttempt.findUnique({ where: { id: attemptId } })).status, 'IN_PROGRESS');
  owner.socket.disconnect(); other.socket.disconnect();
});

test('e2e: an expired attempt is never graded by WaseetAI and never approves the user', { skip }, async () => {
  fake.streamMode = 'ok'; fake.submitMode = 'ok'; fake.submitCalls.length = 0;
  const psId = ctx.psIds[0]; // already finished above -> new attempt allowed
  const { socket, events } = await startAndFinish(psId);
  const attemptId = has(events, 'assessment_ready')[0].payload.attemptId;
  await prisma.assessmentAttempt.update({ where: { id: attemptId }, data: { startedAt: new Date(Date.now() - 60 * 60 * 1000) } });
  events.length = 0;
  socket.emit('submit_answer', { attemptId, answers: { '1': 'a' } });
  await waitFor(() => events.length > 0);
  assert.equal(fake.submitCalls.length, 0);
  assert.equal((await prisma.assessmentAttempt.findUnique({ where: { id: attemptId } })).status, 'EXPIRED');
  socket.disconnect();
});
