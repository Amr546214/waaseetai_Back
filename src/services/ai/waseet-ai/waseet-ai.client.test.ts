import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaseetAiClient, type FetchLike } from './waseet-ai.client';
import { WaseetAiErrorCode } from './waseet-ai.errors';
import { getWaseetAiConfig, WASEET_AI_DEFAULT_BASE_URL, type WaseetAiConfig } from '../../../config/ai/waseet-ai.config';
import { parseSseStream } from './waseet-ai.sse';

// No test in this file performs a real network call. `fetch` is injected as
// a recording mock, and the "token" used below is an obviously synthetic
// test marker built at runtime — it is not, and does not resemble, a real
// WaseetAI credential.

const TEST_TOKEN = ['unit', 'test', 'marker'].join('-');

function config(overrides: Partial<WaseetAiConfig> = {}): () => WaseetAiConfig {
  return () => ({
    baseUrl: 'https://waseet-ai.test',
    bearerToken: TEST_TOKEN,
    restTimeoutMs: 1_000,
    streamTimeoutMs: 1_000,
    ...overrides,
  });
}

interface Recorded { url: string; init: RequestInit }

function jsonFetch(status: number, body: unknown, calls: Recorded[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

function sseFetch(chunks: string[], calls: Recorded[] = [], status = 200): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
  };
}

async function collect<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

// ── configuration detection ─────────────────────────────────────────────

test('config: token missing -> bearerToken undefined, default base URL used', () => {
  const c = getWaseetAiConfig({} as NodeJS.ProcessEnv);
  assert.equal(c.bearerToken, undefined);
  assert.equal(c.baseUrl, WASEET_AI_DEFAULT_BASE_URL);
});

test('config: placeholder token values are treated as not configured; trailing slash stripped', () => {
  for (const v of ['', '   ', '<set-me>', 'changeme']) {
    assert.equal(getWaseetAiConfig({ WASEET_AI_BEARER_TOKEN: v } as NodeJS.ProcessEnv).bearerToken, undefined);
  }
  assert.equal(getWaseetAiConfig({ WASEET_AI_BASE_URL: 'https://x.test//' } as NodeJS.ProcessEnv).baseUrl, 'https://x.test');
});

test('isConfigured() reflects the real process env of this environment without throwing', () => {
  const client = new WaseetAiClient(jsonFetch(200, {}));
  const expected = !!getWaseetAiConfig(process.env).bearerToken;
  assert.equal(client.isConfigured(), expected);
});

test('isConfigured() is false and calls reject NOT_CONFIGURED without any fetch when token is absent', async () => {
  const calls: Recorded[] = [];
  const client = new WaseetAiClient(jsonFetch(200, { success: true, data: {} }, calls), config({ bearerToken: undefined }));
  assert.equal(client.isConfigured(), false);
  await assert.rejects(() => client.suggestMilestones({ title: 't', description: 'd', totalAmount: 100, currency: 'USD' }), (e: any) => e.code === WaseetAiErrorCode.NOT_CONFIGURED);
  await assert.rejects(() => collect(client.streamHelpChat({ question: 'q' })), (e: any) => e.code === WaseetAiErrorCode.NOT_CONFIGURED);
  assert.equal(calls.length, 0);
});

// ── request construction ─────────────────────────────────────────────────

test('REST call: URL, method, auth + tracing headers, JSON body', async () => {
  const calls: Recorded[] = [];
  const client = new WaseetAiClient(
    jsonFetch(200, { success: true, data: { milestones: [{ title: 'a', description: 'b', days: 3, percentage: 100, amount: 100 }] } }, calls),
    config(),
  );
  const res = await client.suggestMilestones({ title: 'T', description: 'D', totalAmount: 100, currency: 'USD' }, { requestId: 'trace-1' });
  assert.equal(res.milestones.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://waseet-ai.test/v1/ai/milestones');
  assert.equal(calls[0].init.method, 'POST');
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['X-Client-Id'], 'waseet_core_backend');
  assert.equal(h['X-Request-Id'], 'trace-1');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { title: 'T', description: 'D', totalAmount: 100, currency: 'USD' });
});

test('submitAssessment encodes attemptId into the path', async () => {
  const calls: Recorded[] = [];
  const client = new WaseetAiClient(
    jsonFetch(200, { success: true, data: { attemptId: 'a/1', score: 70, isPassed: true, status: 'COMPLETED', feedbackAr: 'x', strengths: [], weaknesses: [] } }, calls),
    config(),
  );
  const res = await client.submitAssessment('a/1', { submittedAnswers: { '1': 'a' }, timeSpentSeconds: 30 });
  assert.equal(res.score, 70);
  assert.equal(calls[0].url, 'https://waseet-ai.test/v1/ai/assessments/a%2F1/submit');
});

test('avatarChat returns text + base64 audio', async () => {
  const client = new WaseetAiClient(jsonFetch(200, { success: true, data: { text: 'مرحبا', audio: { mimeType: 'audio/mp3', base64Audio: 'AAAA' } } }), config());
  const res = await client.avatarChat({ message: 'hi' });
  assert.equal(res.text, 'مرحبا');
  assert.equal(res.audio?.base64Audio, 'AAAA');
});

// ── error handling ───────────────────────────────────────────────────────

test('non-2xx statuses map to normalized codes and never leak the token', async () => {
  const cases: Array<[number, WaseetAiErrorCode]> = [
    [400, WaseetAiErrorCode.BAD_REQUEST],
    [401, WaseetAiErrorCode.AUTHENTICATION_ERROR],
    [403, WaseetAiErrorCode.AUTHENTICATION_ERROR],
    [404, WaseetAiErrorCode.NOT_FOUND],
    [429, WaseetAiErrorCode.RATE_LIMITED],
    [503, WaseetAiErrorCode.PROVIDER_UNAVAILABLE],
  ];
  for (const [status, code] of cases) {
    const client = new WaseetAiClient(jsonFetch(status, { error: `upstream says ${TEST_TOKEN}` }), config());
    await assert.rejects(
      () => client.analyzeProject({ title: 't', description: 'd', budget: 1, deadlineDays: 1, currency: 'USD' }),
      (e: any) => {
        assert.equal(e.name, 'WaseetAiError');
        assert.equal(e.code, code);
        assert.equal(e.status, status);
        assert.ok(!e.message.includes(TEST_TOKEN), 'message must not contain token or upstream body');
        assert.ok(!JSON.stringify({ ...e, message: e.message }).includes(TEST_TOKEN));
        return true;
      },
    );
  }
});

test('success:false envelope, malformed JSON, and contract mismatch -> INVALID_RESPONSE', async () => {
  const bodies: unknown[] = [{ success: false, data: null }, 'not json', { success: true, data: { unexpected: true } }];
  for (const body of bodies) {
    const client = new WaseetAiClient(jsonFetch(200, body), config());
    await assert.rejects(() => client.suggestMilestones({ title: 't', description: 'd', totalAmount: 1, currency: 'USD' }), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);
  }
});

test('network failure -> PROVIDER_UNAVAILABLE; abort/timeout -> TIMEOUT', async () => {
  const failing = new WaseetAiClient(async () => { throw new TypeError('fetch failed'); }, config());
  await assert.rejects(() => failing.avatarChat({ message: 'x' }), (e: any) => e.code === WaseetAiErrorCode.PROVIDER_UNAVAILABLE);

  const hanging: FetchLike = (_url, init) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const slow = new WaseetAiClient(hanging, config());
  await assert.rejects(() => slow.avatarChat({ message: 'x' }, { timeoutMs: 20 }), (e: any) => e.code === WaseetAiErrorCode.TIMEOUT);
});

test('callUnverified throws CONTRACT_UNVERIFIED without any network call', async () => {
  const calls: Recorded[] = [];
  const client = new WaseetAiClient(jsonFetch(200, {}, calls), config());
  await assert.rejects(() => client.callUnverified('AI-10'), (e: any) => e.code === WaseetAiErrorCode.CONTRACT_UNVERIFIED);
  assert.equal(calls.length, 0);
});

// ── SSE ──────────────────────────────────────────────────────────────────

test('streamHelpChat: parses named events split across chunks, incl. split UTF-8', async () => {
  const calls: Recorded[] = [];
  const arabic = 'مرحبا';
  const bytes = new TextEncoder().encode(`event: text.delta\ndata: {"chunk":"${arabic}"}\n\n`);
  // Split mid multi-byte character to prove decoder streaming is correct.
  const splitAt = bytes.length - 8;
  const client = new WaseetAiClient(async (url, init) => {
    calls.push({ url, init });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: generation.started\ndata: {"status":"started"}\n\n: heartbeat\n\n'));
        c.enqueue(bytes.slice(0, splitAt));
        c.enqueue(bytes.slice(splitAt));
        c.enqueue(enc.encode('event: citations\ndata: [{"docId":"d1","title":"FAQ"}]\n\nevent: generation.completed\ndata: {"status":"completed"}\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  }, config());

  const events = await collect(client.streamHelpChat({ question: 'كيف أبدأ؟' }));
  assert.deepEqual(events, [
    { type: 'started' },
    { type: 'delta', chunk: arabic },
    { type: 'citations', citations: [{ docId: 'd1', title: 'FAQ' }] },
    { type: 'completed' },
  ]);
  assert.equal(calls[0].url, 'https://waseet-ai.test/v1/ai/help/chat');
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, 'text/event-stream');
});

test('streamProjectDescription: accepts event name inside JSON data (no event: field)', async () => {
  const client = new WaseetAiClient(
    sseFetch([
      'data: {"event":"text.delta","chunk":"a"}\r\n\r\n',
      'data: {"type":"text.delta","chunk":"b"}\n\n',
      'data: {"event":"generation.completed","status":"completed"}\n\n',
    ]),
    config(),
  );
  const events = await collect(client.streamProjectDescription({ title: 't', category: 'c', language: 'ar', modelTier: 'LIGHT' }));
  assert.deepEqual(events, [{ type: 'delta', chunk: 'a' }, { type: 'delta', chunk: 'b' }, { type: 'completed' }]);
});

test('stream without completion event -> INVALID_RESPONSE; non-2xx -> mapped error', async () => {
  const truncated = new WaseetAiClient(sseFetch(['event: text.delta\ndata: {"chunk":"a"}\n\n']), config());
  await assert.rejects(() => collect(truncated.streamHelpChat({ question: 'q' })), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);

  const unauthorized = new WaseetAiClient(sseFetch([], [], 401), config());
  await assert.rejects(() => collect(unauthorized.streamHelpChat({ question: 'q' })), (e: any) => e.code === WaseetAiErrorCode.AUTHENTICATION_ERROR);
});

test('parseSseStream: non-JSON data preserved as string, [DONE] mapped to done', async () => {
  async function* src() {
    yield new TextEncoder().encode('data: hello\n\ndata: [DONE]\n\n');
  }
  const events = [];
  for await (const e of parseSseStream(src())) events.push(e);
  assert.deepEqual(events, [{ event: 'message', data: 'hello' }, { event: 'done', data: null }]);
});

// ── AI-21 help: the REAL contract, verified live 2026-09-30 ─────────────
// Frames below reproduce the structure observed from the live service
// (`event:` + `data:` lines, `help:answer_start` then `help:error`). The
// message text is a synthetic stand-in — the real upstream text is never
// copied into our errors anyway.

test('streamHelpChat (live-verified framing): help:answer_start + help:error → started, then STREAM_ERROR with humanSupportFallback and no upstream text', async () => {
  const upstreamText = `upstream says ${TEST_TOKEN}`;
  const client = new WaseetAiClient(
    sseFetch([
      'event: help:answer_start\ndata: {"status":"started","citationsCount":0}\n\n',
      `event: help:error\ndata: {"message":"${upstreamText}","human_support_fallback":true}\n\n`,
    ]),
    config(),
  );
  const seen: unknown[] = [];
  await assert.rejects(
    async () => { for await (const e of client.streamHelpChat({ question: 'q' })) seen.push(e); },
    (e: any) => {
      assert.equal(e.code, WaseetAiErrorCode.STREAM_ERROR);
      assert.equal(e.humanSupportFallback, true);
      assert.ok(!e.message.includes(upstreamText));
      assert.ok(!JSON.stringify({ ...e, message: e.message }).includes(TEST_TOKEN));
      return true;
    },
  );
  assert.deepEqual(seen, [{ type: 'started', citationsCount: 0 }]);
});

test('streamHelpChat: inferred help:answer_chunk / help:answer_complete names and documented names both work (multiple chunks)', async () => {
  const client = new WaseetAiClient(
    sseFetch([
      'event: help:answer_start\ndata: {"status":"started","citationsCount":1}\n\n',
      'event: help:answer_chunk\ndata: {"chunk":"أ"}\n\nevent: text.delta\ndata: {"chunk":"ب"}\n\n',
      'event: help:answer_chunk\ndata: {"chunk":"ج"}\n\n',
      'event: help:answer_complete\ndata: {}\n\n',
    ]),
    config(),
  );
  const events = await collect(client.streamHelpChat({ question: 'q' }));
  assert.deepEqual(events, [
    { type: 'started', citationsCount: 1 },
    { type: 'delta', chunk: 'أ' },
    { type: 'delta', chunk: 'ب' },
    { type: 'delta', chunk: 'ج' },
    { type: 'completed' },
  ]);
});

test('streamHelpChat: a malformed text event (no string chunk / non-JSON) → INVALID_RESPONSE, not silently dropped', async () => {
  for (const frame of ['event: help:answer_chunk\ndata: {"chunk":42}\n\n', 'event: text.delta\ndata: not-json\n\n']) {
    const client = new WaseetAiClient(sseFetch([frame, 'event: help:answer_complete\ndata: {}\n\n']), config());
    await assert.rejects(() => collect(client.streamHelpChat({ question: 'q' })), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);
  }
});

test('streamHelpChat: sends {question, history} with the upstream-validated history shape; unknown events surface as unknown', async () => {
  const calls: Recorded[] = [];
  const client = new WaseetAiClient(sseFetch(['event: help:telemetry\ndata: {"x":1}\n\nevent: help:answer_complete\ndata: {}\n\n'], calls), config());
  const events = await collect(client.streamHelpChat({ question: 'q', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }));
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { question: 'q', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
  assert.deepEqual(events, [{ type: 'unknown', event: 'help:telemetry', data: { x: 1 } }, { type: 'completed' }]);
});

test('streamHelpChat: an external abort (disconnect/cancel) aborts the upstream fetch; stopping iteration early also releases it', async () => {
  let upstreamSignal: AbortSignal | undefined;
  const client = new WaseetAiClient(async (_url, init) => {
    upstreamSignal = init.signal ?? undefined;
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: help:answer_chunk\ndata: {"chunk":"a"}\n\n'));
        init.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      },
    });
    return new Response(stream, { status: 200 });
  }, config());

  const gen = client.streamHelpChat({ question: 'q' });
  const first = await gen.next();
  assert.deepEqual(first.value, { type: 'delta', chunk: 'a' });
  await gen.return(undefined);
  assert.equal(upstreamSignal?.aborted, true);

  const external = new AbortController();
  external.abort();
  await assert.rejects(() => collect(client.streamHelpChat({ question: 'q' }, { signal: external.signal })), (e: any) => e.code === WaseetAiErrorCode.TIMEOUT);
});

// ── TTS: contract observed live (2026-09-30, one controlled call) ─────────
// HTTP 200, application/json: {success, requestId, data:{audio:{mimeType,
// base64Audio, sizeBytes, durationEstimateSec}, metadata:{voice, dialect,
// style, modelUsed, projectAliasUsed, mimeType, sizeBytes,
// durationEstimateSec}}}; base64Audio decodes to a RIFF/WAVE 24 kHz mono
// 16-bit PCM file. Fixture below mirrors that STRUCTURE with synthetic values.

function syntheticWav24kMono(samples = 64): Buffer {
  const data = Buffer.alloc(samples * 2, 1);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24_000, 24); h.writeUInt32LE(48_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('synthesizeSpeech: parses the live-observed envelope (data.audio.base64Audio + metadata) into WAV bytes', async () => {
  const wav = syntheticWav24kMono();
  const calls: Recorded[] = [];
  const observedShape = {
    success: true,
    requestId: 'req-synthetic-01',
    data: {
      audio: { mimeType: 'audio/wav', base64Audio: wav.toString('base64'), sizeBytes: wav.length, durationEstimateSec: 0.01 },
      metadata: { voice: 'Puck', dialect: 'egyptian', style: 'synthetic style', modelUsed: 'synthetic-model', projectAliasUsed: 'synthetic', mimeType: 'audio/wav', sizeBytes: wav.length, durationEstimateSec: 0.01 },
    },
  };
  const client = new WaseetAiClient(jsonFetch(200, observedShape, calls), config());
  const out = await client.synthesizeSpeech({ text: 'مرحبا', dialect: 'egyptian', voice: 'Puck', model: 'gemini-3.8-flash-lite-tts', speakingRate: 'normal', mimeType: 'audio/wav' });
  assert.deepEqual(out, wav);
  assert.equal(out.readUInt32LE(24), 24_000);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/v1/ai/tts/synthesize'));
  assert.deepEqual(Object.keys(JSON.parse(String(calls[0].init.body))), ['text', 'dialect', 'voice', 'model', 'speakingRate', 'mimeType']);
});

// ── contracts verified live 2026-10-02 (mocked here, shapes taken from the live responses) ──

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test('requestDraft: POSTs /v1/ai/request-draft and validates the verified response shape', async () => {
  const calls: Recorded[] = [];
  const draft = { suggestedTitle: 't', suggestedDescription: 'd', suggestedSubSpecialties: ['a'], recommendedMinBudget: 600, recommendedMaxBudget: 1800, suggestedDurationDays: 25, complexityRating: 'Medium', personalizedNote: 'n', aiMatchScoreEstimate: 90 };
  const client = new WaseetAiClient(jsonFetch(200, { success: true, data: draft }, calls), config());
  assert.deepEqual(await client.requestDraft({ title: 'x', description: 'y', specialtyName: 'z', currency: 'USD' }), draft);
  assert.equal(calls[0].url, 'https://waseet-ai.test/v1/ai/request-draft');
});

test('requestDraft: a response missing the budget range is INVALID_RESPONSE', async () => {
  const client = new WaseetAiClient(jsonFetch(200, { success: true, data: { suggestedTitle: 't', suggestedDescription: 'd', suggestedSubSpecialties: [] } }), config());
  await assert.rejects(() => client.requestDraft({}), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);
});

test('suggestSkills / summarizePerformance / suggestProposal validate their verified shapes', async () => {
  const skills = new WaseetAiClient(jsonFetch(200, { success: true, data: { suggestedSkills: ['React'] } }), config());
  assert.deepEqual((await skills.suggestSkills({ providerId: 'p', specialtyName: 's' })).suggestedSkills, ['React']);
  const bad = new WaseetAiClient(jsonFetch(200, { success: true, data: { suggestedSkills: [1] } }), config());
  await assert.rejects(() => bad.suggestSkills({ providerId: 'p', specialtyName: 's' }), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);

  const perf = { executionQuality: 93, onTimeDelivery: 93, communication: 98, clientSatisfaction: 93, onTimeCompletionRate: 93, repeatClientRate: 42, highRatingServicesRate: 93, conflictFreeDeliveryRate: 100 };
  const p = new WaseetAiClient(jsonFetch(200, { success: true, data: perf }), config());
  assert.deepEqual(await p.summarizePerformance({ providerId: 'p', totalProjectsCompleted: 1, onTimeProjectsCount: 1, repeatClientsCount: 0, totalClientsCount: 1, fiveStarReviewsCount: 1, totalReviewsCount: 1, disputedProjectsCount: 0 }), perf);
  const pBad = new WaseetAiClient(jsonFetch(200, { success: true, data: { ...perf, communication: 'x' } }), config());
  await assert.rejects(() => pBad.summarizePerformance({} as any), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);

  const prop = new WaseetAiClient(jsonFetch(200, { success: true, data: { suggestedTitle: 't', suggestedMessage: 'm', qualityScore: 95, qualityTag: 'Excellent', suggestedAdvantages: ['a'] } }), config());
  assert.equal((await prop.suggestProposal({ projectId: 'p', currentTitle: 't', currentMessage: 'm' })).qualityScore, 95);
});

test('text suggest/enhance streams relay text.delta chunks and require generation.completed', async () => {
  const calls: Recorded[] = [];
  const ok = new WaseetAiClient(sseFetch([frame('text.delta', { chunk: 'أ' }), frame('text.delta', { chunk: 'ب' }), frame('generation.completed', { status: 'completed' })], calls), config());
  const evs = await collect(ok.streamTextEnhancement({ description: 'نص' }));
  assert.deepEqual(evs.filter((e) => e.type === 'delta').map((e: any) => e.chunk), ['أ', 'ب']);
  assert.equal(calls[0].url, 'https://waseet-ai.test/v1/ai/text/enhance/stream');

  const noEnd = new WaseetAiClient(sseFetch([frame('text.delta', { chunk: 'أ' })]), config());
  await assert.rejects(() => collect(noEnd.streamTextSuggestion({ title: 'عنوان' })), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);
});

test('streamAssessmentQuestions maps question.streamed/assessment.ready and never exposes an answer key', async () => {
  const q = (id: number) => frame('question.streamed', { attemptId: 'att-1', question: { id, textAr: `س${id}`, options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] } });
  const client = new WaseetAiClient(sseFetch([q(1), q(2), frame('assessment.ready', { attemptId: 'att-1', totalQuestions: 2, timeLimitMinutes: 15, generationSource: 'GEMINI' })]), config());
  const evs = await collect(client.streamAssessmentQuestions({ providerSpecialtyId: 'ps', specialtyName: 'تصميم', questionCount: 2 }));
  assert.deepEqual(evs.map((e) => e.type), ['question', 'question', 'assessment_ready', 'completed']);
  assert.ok(!JSON.stringify(evs).includes('correct'));
  assert.deepEqual((evs[2] as any).totalQuestions, 2);
});

test('streamAssessmentQuestions: a malformed question event fails loudly', async () => {
  const client = new WaseetAiClient(sseFetch([frame('question.streamed', { attemptId: 'att-1', question: { id: 'x' } })]), config());
  await assert.rejects(() => collect(client.streamAssessmentQuestions({ providerSpecialtyId: 'ps' })), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);
});

test('matrix endpoints probed as unusable stay CONTRACT_UNVERIFIED and never touch the network', async () => {
  let called = false;
  const client = new WaseetAiClient((async () => { called = true; throw new Error('no'); }) as any, config());
  for (const id of ['AI-13', 'AI-14', 'AI-15', 'AI-18', 'AI-19', 'AI-11', 'AI-12'] as const) {
    await assert.rejects(() => client.callUnverified(id), (e: any) => e.code === WaseetAiErrorCode.CONTRACT_UNVERIFIED);
  }
  assert.equal(called, false);
});
