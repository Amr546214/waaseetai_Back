import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WaseetAiError, WaseetAiErrorCode } from '../services/ai/waseet-ai/waseet-ai.errors';

// Help AI Assistant / dashboard Avatar gateway, now backed by WaseetAI
// (AI-21). No real Socket.IO server and NO network: a plain mock socket
// captures handlers/emits, and `waseetAiClient` and the auth resolver are
// replaced via t.mock.module. (The legacy `help:audio` OpenAI TTS path was
// removed; voice is served by POST /api/help-assistant/tts.)

const SECRET_MARKER = ['never', 'leak', 'marker'].join('-');

function createMockSocket(opts: { id?: string } = {}) {
	const handlers: Record<string, (...args: any[]) => any> = {};
	const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
	const emitted: Array<{ event: string; payload: any }> = [];
	const socket: any = {
		id: opts.id ?? `socket-${Math.random()}`,
		connected: true,
		handshake: { auth: {}, headers: {} },
		on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
		once: (event: string, handler: (...args: any[]) => any) => { (onceHandlers[event] ||= []).push(handler); },
		off: (event: string, handler?: (...args: any[]) => any) => {
			if (!onceHandlers[event]) return;
			onceHandlers[event] = handler ? onceHandlers[event].filter((h) => h !== handler) : [];
		},
		emit: (event: string, payload?: any) => { emitted.push({ event, payload }); },
	};
	return {
		socket,
		handlers,
		emitted,
		events: () => emitted.map((e) => e.event),
		triggerDisconnect: () => { socket.connected = false; (onceHandlers['disconnect'] || []).forEach((h) => h()); },
	};
}

type StreamEvt = { type: 'started' } | { type: 'delta'; chunk: string } | { type: 'citations'; citations: any[]; searchSuggestionsHtml?: unknown } | { type: 'completed' };

function fakeStream(events: StreamEvt[], opts: { failAt?: number; error?: unknown; signal?: AbortSignal; pauseAt?: number; pause?: Promise<void> } = {}) {
	return (async function* () {
		for (let i = 0; i < events.length; i++) {
			if (opts.pauseAt === i && opts.pause) await opts.pause;
			if (opts.signal?.aborted) throw new WaseetAiError(WaseetAiErrorCode.TIMEOUT, 'cancelled');
			if (opts.failAt === i) throw opts.error ?? new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, 'down');
			yield events[i];
		}
	})();
}

const OK_STREAM: StreamEvt[] = [{ type: 'started' }, { type: 'delta', chunk: 'الضمان ' }, { type: 'delta', chunk: 'يحمي ' }, { type: 'delta', chunk: 'الطرفين.' }, { type: 'completed' }];

async function loadGateway(t: TestContext, opts: {
	auth?: any;
	configured?: boolean;
	stream?: (body: any, options: any) => AsyncGenerator<any, void, void>;
} = {}) {
	const calls = { stream: [] as Array<{ body: any; options: any }> };
	const mocks: Array<{ restore: () => void }> = [];
	mocks.push(t.mock.module('./help-assistant-auth', {
		namedExports: { resolveHelpAssistantUser: async () => opts.auth ?? { ok: true, userId: `u-${Math.random()}`, role: 'client' } },
	}));
	mocks.push(t.mock.module('../services/ai/waseet-ai/waseet-ai.client', {
		namedExports: {
			waseetAiClient: {
				isConfigured: () => opts.configured ?? true,
				streamHelpChat: (body: any, options: any) => {
					calls.stream.push({ body, options });
					return (opts.stream ?? (() => fakeStream(OK_STREAM)))(body, options);
				},
			},
		},
	}));
	const mod = await import(`./help-assistant-chat.gateway.ts?fixture=${Date.now()}-${Math.random()}`);
	const restore = () => mocks.forEach((m) => m.restore());
	return { register: mod.registerHelpAssistantChatGateway as (socket: any) => void, calls, mod, restore };
}

// ── auth ────────────────────────────────────────────────────────────────

test('help:ask: an unauthenticated socket (dashboard Avatar without a session) is rejected, WaseetAI never called', async (t) => {
	const { register, calls } = await loadGateway(t, { auth: { ok: false, reason: 'UNAUTHENTICATED' } });
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'كيف يعمل الضمان؟', clientRequestId: 'r1' });
	assert.equal(calls.stream.length, 0);
	assert.deepEqual(s.events(), ['help:error']);
	assert.equal(s.emitted[0].payload.code, 'AUTH_REQUIRED');
	assert.equal(s.emitted[0].payload.clientRequestId, 'r1');
});

test('help:ask: a suspended/pending account is rejected with FORBIDDEN', async (t) => {
	const { register, calls } = await loadGateway(t, { auth: { ok: false, reason: 'FORBIDDEN' } });
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	assert.equal(calls.stream.length, 0);
	assert.equal(s.emitted[0].payload.code, 'FORBIDDEN');
});

test('help:ask: an authenticated request streams start → multiple chunks → complete, echoing clientRequestId', async (t) => {
	const { register, calls } = await loadGateway(t);
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'كيف يعمل الضمان؟', clientRequestId: 'req-1' });

	assert.deepEqual(s.events(), ['help:answer_start', 'help:answer_chunk', 'help:answer_chunk', 'help:answer_chunk', 'help:answer_complete']);
	assert.deepEqual(s.emitted.filter((e) => e.event === 'help:answer_chunk').map((e) => e.payload.chunk), ['الضمان ', 'يحمي ', 'الطرفين.']);
	for (const e of s.emitted) assert.equal(e.payload.clientRequestId, 'req-1');
	assert.equal(calls.stream.length, 1);
});

test('help:ask: a stream without an explicit started event still emits answer_start before the first chunk', async (t) => {
	const { register } = await loadGateway(t, { stream: () => fakeStream([{ type: 'delta', chunk: 'أ' }, { type: 'completed' }]) });
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	assert.deepEqual(s.events(), ['help:answer_start', 'help:answer_chunk', 'help:answer_complete']);
});

test('help:ask: citations are relayed as plain {docId,title}', async (t) => {
	const { register } = await loadGateway(t, {
		stream: () => fakeStream([{ type: 'started' }, { type: 'citations', citations: [{ docId: 'd1', title: 'سياسة الضمان', extra: 'x' }] }, { type: 'delta', chunk: 'نص' }, { type: 'completed' }]),
	});
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	const c = s.emitted.find((e) => e.event === 'help:citations');
	assert.deepEqual(c?.payload.citations, [{ docId: 'd1', title: 'سياسة الضمان' }]);
});

test('help:citations forwards bounded provider suggestions as text without raw objects or overflow', async t => {
  const html = '<div class="suggestions">Search suggestions</div>';
  for (const value of [html, 'x'.repeat(64000), { html }, 'x'.repeat(64001)]) {
    const { register, restore } = await loadGateway(t, { stream: () => fakeStream([
      { type: 'delta', chunk: 'إجابة' }, { type: 'citations', citations: [{ docId: 'web-1', title: 'Source', raw: 'provider-object' }], searchSuggestionsHtml: value }, { type: 'completed' },
    ]) });
    const s = createMockSocket(); register(s.socket);
    await s.handlers['help:ask']({ question: 'اشرح API', webSearch: true });
    const event = s.emitted.find(item => item.event === 'help:citations');
    assert.deepEqual(event?.payload.citations, [{ docId: 'web-1', title: 'Source' }]);
    if (typeof value === 'string' && value.length <= 64000) assert.equal(event?.payload.searchSuggestionsHtml, value);
    else assert.equal('searchSuggestionsHtml' in event!.payload, false);
    assert.equal(JSON.stringify(s.emitted).includes('provider-object'), false);
    restore();
  }
});

// ── role + payload minimisation ─────────────────────────────────────────

test('help:ask: every dashboard role uses the same real engine; role is never sent upstream nor taken from the payload', async (t) => {
	for (const role of ['client', 'provider', 'marketer', 'admin']) {
		const { register, calls, restore } = await loadGateway(t, { auth: { ok: true, userId: `u-${role}-${Math.random()}`, role } });
		const s = createMockSocket();
		register(s.socket);
		await s.handlers['help:ask']({ question: 'كيف أبدأ؟', role: 'admin', userId: 'spoofed', accountType: 'SUPER_ADMIN' });
		assert.equal(s.events().at(-1), 'help:answer_complete', `role ${role} served`);
		assert.deepEqual(Object.keys(calls.stream[0].body), ['skin', 'mode', 'question'], 'only character selection, answer mode and question go upstream');
		assert.equal(calls.stream[0].body.mode, 'general');
		assert.equal(calls.stream[0].body.skin, 'scout');
		assert.equal(calls.stream[0].body.question, 'كيف أبدأ؟');
		restore();
	}
});

test('help:ask: legacy {question,answer} history is converted to the upstream-validated {role,content} shape and bounded', async (t) => {
	const { register, calls } = await loadGateway(t);
	const s = createMockSocket();
	register(s.socket);
	const history = [
		...Array.from({ length: 5 }, (_, i) => ({ question: `س${i}`, answer: `ج${i}` })),
		{ question: 'ط'.repeat(5000), answer: 'x' },
		{ bogus: true },
	];
	await s.handlers['help:ask']({ question: 'سؤال أخير', history });
	const sent = calls.stream[0].body.history;
	// last 3 raw items → only the one valid turn (س4/ج4) survives; oversized + bogus dropped
	assert.deepEqual(sent, [{ role: 'user', content: 'س4' }, { role: 'assistant', content: 'ج4' }]);
	for (const m of sent) assert.ok(m.role === 'user' || m.role === 'assistant');
});

// ── failures ────────────────────────────────────────────────────────────

test('help:ask: an unresolved upstream failure has an availability error, never the removed knowledge-base refusal', async (t) => {
	const { register } = await loadGateway(t, {
		stream: () => fakeStream([{ type: 'started' }, { type: 'completed' }], { failAt: 1, error: new WaseetAiError(WaseetAiErrorCode.STREAM_ERROR, 'x', { humanSupportFallback: true }) }),
	});
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال خارج قاعدة المعرفة' });
	assert.deepEqual(s.events(), ['help:answer_start', 'help:error']);
	const err = s.emitted[1].payload;
	assert.equal(err.code, 'UNAVAILABLE');
	assert.equal(err.humanSupportFallback, true);
	assert.equal(s.emitted.some((e) => e.event === 'help:answer_chunk'), false);
});

test('help:ask: upstream in-stream error WITHOUT the human-support flag → UNAVAILABLE (service failure), never reported as a missing policy', async (t) => {
	const { register } = await loadGateway(t, {
		stream: () => fakeStream([{ type: 'started' }, { type: 'completed' }], { failAt: 1, error: new WaseetAiError(WaseetAiErrorCode.STREAM_ERROR, 'x', { humanSupportFallback: false }) }),
	});
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال خارج قاعدة المعرفة' });
	assert.deepEqual(s.events(), ['help:answer_start', 'help:error']);
	const err = s.emitted[1].payload;
	assert.equal(err.code, 'UNAVAILABLE');
	assert.equal(err.humanSupportFallback, true);
	assert.equal(s.emitted.some((e) => e.event === 'help:answer_chunk'), false);
});

test('help:ask: an upstream failure mid-stream emits an honest error after the partial chunks (never complete)', async (t) => {
	const { register } = await loadGateway(t, { stream: () => fakeStream(OK_STREAM, { failAt: 2 }) });
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	assert.deepEqual(s.events(), ['help:answer_start', 'help:answer_chunk', 'help:error']);
	assert.equal(s.emitted.at(-1)!.payload.code, 'UNAVAILABLE');
	assert.equal(s.events().includes('help:answer_complete'), false);
});

test('help:ask: a malformed upstream event (INVALID_RESPONSE from the client) → UNAVAILABLE error', async (t) => {
	const { register } = await loadGateway(t, {
		stream: () => fakeStream(OK_STREAM, { failAt: 1, error: new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'malformed') }),
	});
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	assert.equal(s.emitted.at(-1)!.event, 'help:error');
	assert.equal(s.emitted.at(-1)!.payload.code, 'UNAVAILABLE');
});

test('help:ask: an upstream timeout → TIMEOUT error code', async (t) => {
	const { register } = await loadGateway(t, {
		stream: () => fakeStream(OK_STREAM, { failAt: 0, error: new WaseetAiError(WaseetAiErrorCode.TIMEOUT, 'timeout') }),
	});
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	assert.equal(s.emitted.at(-1)!.payload.code, 'TIMEOUT');
});

test('help:ask: an empty "completed" stream is an honest failure, not a blank success', async (t) => {
	const { register } = await loadGateway(t, { stream: () => fakeStream([{ type: 'started' }, { type: 'completed' }]) });
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	assert.equal(s.emitted.at(-1)!.event, 'help:error');
});

test('help:ask: WaseetAI not configured → honest unavailable message, no call', async (t) => {
	const { register, calls } = await loadGateway(t, { configured: false });
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	assert.equal(calls.stream.length, 0);
	assert.equal(s.emitted[0].payload.code, 'NOT_CONFIGURED');
	assert.equal(s.emitted[0].payload.humanSupportFallback, true);
});

test('help:ask: empty and oversized questions are rejected without calling WaseetAI', async (t) => {
	const { register, calls } = await loadGateway(t);
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: '   ' });
	await s.handlers['help:ask']({ question: 'س'.repeat(600) });
	assert.equal(calls.stream.length, 0);
	assert.deepEqual(s.emitted.map((e) => e.payload.code), ['INVALID_INPUT', 'INVALID_INPUT']);
});

test('help:ask: rate limit applies per verified user id', async (t) => {
	const userId = `rl-${Math.random()}`;
	const { register } = await loadGateway(t, { auth: { ok: true, userId, role: 'provider' } });
	let last: any;
	for (let i = 0; i < 31; i++) {
		const s = createMockSocket();
		register(s.socket);
		await s.handlers['help:ask']({ question: `سؤال ${i}` });
		last = s.emitted.at(-1);
	}
	assert.equal(last.event, 'help:error');
	assert.equal(last.payload.code, 'RATE_LIMITED');
});

// ── cancellation ────────────────────────────────────────────────────────

test('help:ask: a socket disconnect aborts the in-flight upstream stream and emits nothing further', async (t) => {
	let release!: () => void;
	const pause = new Promise<void>((r) => { release = r; });
	let captured: AbortSignal | undefined;
	const { register } = await loadGateway(t, {
		stream: (_b, options) => { captured = options.signal; return fakeStream(OK_STREAM, { signal: options.signal, pauseAt: 2, pause }); },
	});
	const s = createMockSocket();
	register(s.socket);
	const p = s.handlers['help:ask']({ question: 'سؤال طويل' });
	await new Promise((r) => setImmediate(r));
	s.triggerDisconnect();
	release();
	await p;
	assert.equal(captured?.aborted, true);
	assert.equal(s.events().includes('help:error'), false);
	assert.equal(s.events().includes('help:answer_complete'), false);
});

test('help:cancel with the matching clientRequestId aborts the stream; a mismatched id is ignored', async (t) => {
	let release!: () => void;
	const pause = new Promise<void>((r) => { release = r; });
	let captured: AbortSignal | undefined;
	const { register } = await loadGateway(t, {
		stream: (_b, options) => { captured = options.signal; return fakeStream(OK_STREAM, { signal: options.signal, pauseAt: 2, pause }); },
	});
	const s = createMockSocket();
	register(s.socket);
	const p = s.handlers['help:ask']({ question: 'سؤال', clientRequestId: 'keep' });
	await new Promise((r) => setImmediate(r));
	s.handlers['help:cancel']({ clientRequestId: 'other' });
	assert.equal(captured?.aborted, false);
	s.handlers['help:cancel']({ clientRequestId: 'keep' });
	release();
	await p;
	assert.equal(captured?.aborted, true);
	assert.equal(s.events().includes('help:answer_complete'), false);
});

// ── no credential / raw error leakage ───────────────────────────────────

test('help:ask: emitted payloads never contain upstream error text, causes or credentials', async (t) => {
	const upstream = new WaseetAiError(WaseetAiErrorCode.AUTHENTICATION_ERROR, `Bearer ${SECRET_MARKER}`, { status: 401, cause: new Error(SECRET_MARKER) });
	const { register } = await loadGateway(t, { stream: () => fakeStream(OK_STREAM, { failAt: 0, error: upstream }) });
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال' });
	const serialized = JSON.stringify(s.emitted);
	assert.equal(serialized.includes(SECRET_MARKER), false);
	assert.equal(serialized.includes('Bearer'), false);
	assert.deepEqual(Object.keys(s.emitted.at(-1)!.payload).sort(), ['clientRequestId', 'code', 'humanSupportFallback', 'message']);
});

test('help:ask: a malicious clientRequestId is replaced by a server id', async (t) => {
	const { register } = await loadGateway(t);
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال', clientRequestId: '<script>alert(1)</script>' });
	const id = s.emitted[0].payload.clientRequestId;
	assert.match(id, /^[0-9a-f-]{36}$/);
});

// ── legacy socket voice removed ─────────────────────────────────────────

test('help:ask: no socket audio path — a client-sent speak flag is ignored and no help:audio* event is ever emitted', async (t) => {
	const { register, calls } = await loadGateway(t);
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'سؤال', speak: true, clientRequestId: 'v1' });
	assert.equal(s.events().at(-1), 'help:answer_complete');
	assert.equal(s.events().some((e) => e.startsWith('help:audio')), false);
	assert.equal('speak' in calls.stream[0].body, false);
});

test('help:ask: greeting intents (like "عامل ايه" or "السلام عليكم") are answered gracefully without calling upstream', async (t) => {
	const { register, calls } = await loadGateway(t);
	const s = createMockSocket();
	register(s.socket);
	await s.handlers['help:ask']({ question: 'عامل ايه', clientRequestId: 'g1' });
	assert.equal(calls.stream.length, 0);
	assert.deepEqual(s.events(), ['help:answer_start', 'help:answer_chunk', 'help:answer_complete']);
	assert.match(s.emitted[1].payload.chunk, /أهلاً وسهلاً بك/);
	assert.equal(s.emitted[1].payload.clientRequestId, 'g1');
});

test('help:ask forwards the selected character for real questions and does not consume a greeting followed by a question', async (t) => {
  const { register, calls } = await loadGateway(t);
  const s = createMockSocket();
  register(s.socket);
  for (const skin of ['scout', 'classic']) {
    await s.handlers['help:ask']({ question: 'أهلاً، إزاي أنشر مشروع؟', skin, clientRequestId: `skin_${skin}` });
    assert.equal(calls.stream.at(-1)?.body.skin, skin);
    assert.equal(calls.stream.at(-1)?.body.question, 'أهلاً، إزاي أنشر مشروع؟');
  }
  assert.equal(calls.stream.length, 2);
});

test('help:ask rejects invalid character values before upstream and greets the selected character', async (t) => {
  const { register, calls } = await loadGateway(t);
  const s = createMockSocket();
  register(s.socket);
  await s.handlers['help:ask']({ question: 'عامل ايه', skin: 'classic', dialect: 'egyptian', clientRequestId: 'classic_hello' });
  assert.match(s.emitted.find(e => e.event === 'help:answer_chunk')?.payload.chunk, /أنا بيبو/);
  await s.handlers['help:ask']({ question: 'سؤال حقيقي', skin: 'invalid', clientRequestId: 'invalid_skin' });
  assert.equal(s.emitted.at(-1)?.payload.code, 'INVALID_INPUT');
  assert.equal(calls.stream.length, 0);
});

test('help:ask answers dialect identity with the selected character and keeps real questions on AI', async t => {
  const { register, calls } = await loadGateway(t);
  for (const [skin, dialect, question, name] of [
    ['scout', 'egyptian', 'انت مين؟', 'نديم'], ['classic', 'gulf', 'وش اسمك؟', 'بيبو'],
    ['scout', 'english', 'Who are you?', 'Nadeem'], ['classic', 'english', "What's your name?", 'Bebo'],
  ] as const) {
    const s = createMockSocket(); register(s.socket);
    await s.handlers['help:ask']({ question, skin, dialect });
    assert.ok(s.emitted.find(e => e.event === 'help:answer_chunk')?.payload.chunk.includes(name));
    assert.equal(s.events().at(-1), 'help:answer_complete');
  }
  assert.equal(calls.stream.length, 0);
  for (const question of ['ما عاصمة اليابان؟', 'أهلاً، اشرح لي JavaScript', 'انت مين وازاي أتعلم البرمجة؟']) {
    const s = createMockSocket(); register(s.socket);
    await s.handlers['help:ask']({ question });
    assert.equal(calls.stream.at(-1)?.body.question, question);
    assert.equal(calls.stream.at(-1)?.body.mode, 'general');
  }
  const s = createMockSocket(); register(s.socket);
  await s.handlers['help:ask']({ question: 'متى أفتح نزاع على الضمان؟', mode: 'general' });
  assert.equal(calls.stream.at(-1)?.body.mode, 'policy');
  assert.equal(calls.stream.length, 4);
});

test('help:ask forwards optional web search booleans, preserves policy and rejects non-boolean flags', async t => {
  const { register, calls } = await loadGateway(t);
  const s = createMockSocket(); register(s.socket);
  for (const webSearch of [true, false]) {
    await s.handlers['help:ask']({ question: 'اشرح JavaScript', webSearch });
    assert.equal(calls.stream.at(-1)?.body.webSearch, webSearch);
    assert.equal(calls.stream.at(-1)?.body.mode, 'general');
  }
  await s.handlers['help:ask']({ question: 'متى أفتح نزاع؟', mode: 'general', webSearch: true });
  assert.equal(calls.stream.at(-1)?.body.mode, 'policy');
  assert.equal(calls.stream.at(-1)?.body.webSearch, true);
  await s.handlers['help:ask']({ question: 'اشرح JavaScript' });
  assert.equal('webSearch' in calls.stream.at(-1)!.body, false);
  for (const webSearch of ['true', 1, null]) {
    await s.handlers['help:ask']({ question: 'اشرح JavaScript', webSearch });
    assert.equal(s.emitted.at(-1)?.payload.code, 'INVALID_INPUT');
  }
  assert.equal(calls.stream.length, 4);
});
