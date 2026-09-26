import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Implementation Batch 2, Part A — Help AI Assistant gateway. No real
// Socket.IO server is used — a plain mock socket captures registered
// handlers/emitted events (same convention as ai-review.gateway.test.ts).
// `geminiClient` is mocked via t.mock.module; no real network call happens.

function createMockSocket(opts: { userId?: string; id?: string } = {}) {
	const handlers: Record<string, (...args: any[]) => any> = {};
	const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
	const emitted: Array<{ event: string; payload: any }> = [];

	const socket: any = {
		id: opts.id ?? 'socket-test-1',
		userId: opts.userId,
		on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
		once: (event: string, handler: (...args: any[]) => any) => {
			(onceHandlers[event] ||= []).push(handler);
		},
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
		triggerDisconnect: () => { (onceHandlers['disconnect'] || []).forEach((h) => h()); },
	};
}

function fakeStream(chunks: string[], opts: { throwAfter?: number; error?: Error; checkSignal?: AbortSignal } = {}) {
	return (async function* () {
		for (let i = 0; i < chunks.length; i++) {
			if (opts.checkSignal?.aborted) {
				const abortError: any = new Error('aborted');
				abortError.name = 'AbortError';
				throw abortError;
			}
			if (opts.throwAfter !== undefined && i === opts.throwAfter) {
				throw opts.error || new Error('stream failed');
			}
			yield chunks[i];
		}
		return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
	})();
}

async function loadGateway(t: TestContext, opts: {
	isConfigured?: boolean;
	generateStream?: (prompt: string, options: any) => AsyncGenerator<string, any, void>;
}) {
	const generateStreamSpy = opts.generateStream ?? (() => fakeStream(['رد ']));
	const geminiClientMock = {
		isConfigured: () => opts.isConfigured ?? true,
		generateStream: generateStreamSpy,
	};
	t.mock.module('../services/ai/gemini/gemini.client', { namedExports: { geminiClient: geminiClientMock } });

	const moduleUrl = `./help-assistant-chat.gateway.ts?fixture=${Date.now()}-${Math.random()}`;
	const mod = await import(moduleUrl);
	return mod.registerHelpAssistantChatGateway as (socket: any) => void;
}

test('help:ask: an empty question is rejected without calling Gemini', async (t) => {
	let called = false;
	const register = await loadGateway(t, { generateStream: () => { called = true; return fakeStream([]); } });
	const { socket, handlers, emitted } = createMockSocket({ userId: `user-${Date.now()}` });
	register(socket);

	await handlers['help:ask']({ question: '   ' });

	assert.equal(called, false);
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].event, 'help:error');
});

test('help:ask: an oversized question is rejected without calling Gemini', async (t) => {
	let called = false;
	const register = await loadGateway(t, { generateStream: () => { called = true; return fakeStream([]); } });
	const { socket, handlers, emitted } = createMockSocket({ userId: `user-${Date.now()}` });
	register(socket);

	await handlers['help:ask']({ question: 'س'.repeat(600) });

	assert.equal(called, false);
	assert.equal(emitted[0].event, 'help:error');
	assert.match(emitted[0].payload.message, /طويل جداً/);
});

test('help:ask: a guest (no userId) still gets a real Gemini answer — soft-auth, never rejected', async (t) => {
	const register = await loadGateway(t, { generateStream: () => fakeStream(['أهلاً ', 'بك']) });
	const { socket, handlers, emitted } = createMockSocket({ userId: undefined, id: `guest-${Date.now()}-${Math.random()}` });
	register(socket);

	await handlers['help:ask']({ question: 'كيف يعمل حساب الضمان؟' });

	const events = emitted.map((e) => e.event);
	assert.deepEqual(events, ['help:answer_start', 'help:answer_chunk', 'help:answer_chunk', 'help:answer_complete']);
});

test('help:ask: an authenticated user gets a real Gemini answer', async (t) => {
	const register = await loadGateway(t, { generateStream: () => fakeStream(['إجابة حقيقية']) });
	const { socket, handlers, emitted } = createMockSocket({ userId: `user-${Date.now()}-${Math.random()}` });
	register(socket);

	await handlers['help:ask']({ question: 'كيف تعمل النزاعات؟' });

	assert.equal(emitted[0].event, 'help:answer_start');
	assert.equal(emitted[emitted.length - 1].event, 'help:answer_complete');
});

test('help:ask: chunks are emitted in order and never carry a raw provider object', async (t) => {
	const register = await loadGateway(t, { generateStream: () => fakeStream(['جزء1 ', 'جزء2 ', 'جزء3']) });
	const { socket, handlers, emitted } = createMockSocket({ userId: `user-${Date.now()}-${Math.random()}` });
	register(socket);

	await handlers['help:ask']({ question: 'ما هي عمولة الوسيط؟' });

	const chunks = emitted.filter((e) => e.event === 'help:answer_chunk').map((e) => e.payload.chunk);
	assert.deepEqual(chunks, ['جزء1 ', 'جزء2 ', 'جزء3']);
	for (const c of chunks) assert.equal(typeof c, 'string');
});

test('help:ask: an empty Gemini stream is treated as an honest failure, not a blank success', async (t) => {
	const register = await loadGateway(t, { generateStream: () => fakeStream([]) });
	const { socket, handlers, emitted } = createMockSocket({ userId: `user-${Date.now()}-${Math.random()}` });
	register(socket);

	await handlers['help:ask']({ question: 'سؤال عام عن المنصة' });

	const last = emitted[emitted.length - 1];
	assert.equal(last.event, 'help:error');
	assert.equal(last.payload.humanSupportFallback, true);
});

test('help:ask: Gemini not configured returns an honest unavailable message with a human-support fallback flag', async (t) => {
	const register = await loadGateway(t, { isConfigured: false });
	const { socket, handlers, emitted } = createMockSocket({ userId: `user-${Date.now()}-${Math.random()}` });
	register(socket);

	await handlers['help:ask']({ question: 'سؤال عام' });

	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].event, 'help:error');
	assert.equal(emitted[0].payload.humanSupportFallback, true);
});

test('help:ask: a mid-stream Gemini failure emits an honest error, never a fabricated answer', async (t) => {
	const register = await loadGateway(t, {
		generateStream: () => fakeStream(['جزء ناقص', 'جزء ثانٍ'], { throwAfter: 1, error: new Error('provider crashed') }),
	});
	const { socket, handlers, emitted } = createMockSocket({ userId: `user-${Date.now()}-${Math.random()}` });
	register(socket);

	await handlers['help:ask']({ question: 'سؤال عن الحساب' });

	const last = emitted[emitted.length - 1];
	assert.equal(last.event, 'help:error');
	assert.equal(last.payload.humanSupportFallback, true);
});

test('help:ask: rate limit blocks a request past the threshold, keyed by userId', async (t) => {
	const register = await loadGateway(t, { generateStream: () => fakeStream(['رد']) });
	const uid = `rl-user-${Date.now()}-${Math.random()}`;
	const { socket, handlers } = createMockSocket({ userId: uid });
	register(socket);

	let lastEmitted: any;
	for (let i = 0; i < 31; i++) {
		const { socket: s, handlers: h, emitted: e } = createMockSocket({ userId: uid });
		register(s);
		await h['help:ask']({ question: `سؤال رقم ${i}` });
		lastEmitted = e;
	}

	const last = lastEmitted[lastEmitted.length - 1];
	assert.equal(last.event, 'help:error');
	assert.match(last.payload.message, /تجاوز الحد المسموح/);
});

test('help:ask: two different guest sockets are rate-limited independently, keyed by socket.id', async (t) => {
	const register = await loadGateway(t, { generateStream: () => fakeStream(['رد']) });
	const guestA = createMockSocket({ userId: undefined, id: `guest-a-${Date.now()}-${Math.random()}` });
	const guestB = createMockSocket({ userId: undefined, id: `guest-b-${Date.now()}-${Math.random()}` });
	register(guestA.socket);
	register(guestB.socket);

	for (let i = 0; i < 30; i++) {
		await guestA.handlers['help:ask']({ question: `سؤال ${i}` });
	}
	guestA.emitted.length = 0;

	await guestB.handlers['help:ask']({ question: 'سؤال جديد' });

	assert.equal(guestB.emitted[guestB.emitted.length - 1].event, 'help:answer_complete');
});

test('help:ask: a socket disconnect aborts the in-flight Gemini stream', async (t) => {
	let capturedSignal: AbortSignal | undefined;
	const register = await loadGateway(t, {
		generateStream: (_prompt, options) => {
			capturedSignal = options.signal;
			return fakeStream(['a', 'b', 'c'], { checkSignal: options.signal });
		},
	});
	const { socket, handlers, emitted, triggerDisconnect } = createMockSocket({ userId: `user-${Date.now()}-${Math.random()}` });
	register(socket);

	const handlerPromise = handlers['help:ask']({ question: 'سؤال طويل يحتاج وقتاً' });
	triggerDisconnect();
	await handlerPromise;

	assert.ok(capturedSignal, 'a signal must be passed to generateStream');
	assert.equal(capturedSignal!.aborted, true);
	assert.equal(emitted[emitted.length - 1].event, 'help:error');
});

test('help:ask: the system prompt grounds Gemini in the curated Waseet knowledge and forbids inventing capabilities', async (t) => {
	let capturedSystemInstruction = '';
	const register = await loadGateway(t, {
		generateStream: (_prompt, options) => {
			capturedSystemInstruction = options.systemInstruction;
			return fakeStream(['رد']);
		},
	});
	const { socket, handlers } = createMockSocket({ userId: `user-${Date.now()}-${Math.random()}` });
	register(socket);

	await handlers['help:ask']({ question: 'كيف يعمل حساب الضمان؟' });

	assert.match(capturedSystemInstruction, /لا تخترع أي ميزة/);
	assert.match(capturedSystemInstruction, /حساب الضمان المالي/);
	assert.match(capturedSystemInstruction, /لا تدّعِ أبداً أن الذكاء الاصطناعي يفصل في النزاعات/);
});

test('help:ask: an oversized/malformed history is bounded rather than accepted as-is', async (t) => {
	let capturedPrompt = '';
	const register = await loadGateway(t, {
		generateStream: (prompt) => {
			capturedPrompt = prompt;
			return fakeStream(['رد']);
		},
	});
	const { socket, handlers } = createMockSocket({ userId: `user-${Date.now()}-${Math.random()}` });
	register(socket);

	const hugeHistory = Array.from({ length: 50 }, (_, i) => ({ question: `سؤال ${i}`, answer: 'ط'.repeat(5000) }));
	await handlers['help:ask']({ question: 'سؤال أخير', history: hugeHistory });

	// Only the last MAX_HISTORY_TURNS (3) survive, and each oversized answer
	// (5000 chars) is dropped entirely by sanitizeHistory rather than
	// truncated-but-included, since it exceeds MAX_HISTORY_FIELD_LENGTH.
	assert.equal(capturedPrompt.includes('ط'.repeat(5000)), false);
	assert.match(capturedPrompt, /السؤال الحالي: سؤال أخير/);
});
