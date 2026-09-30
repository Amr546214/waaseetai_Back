import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { createHelpAssistantTtsRouter } from './help-assistant-tts.routes';
import { globalErrorHandler } from '../middlewares/error.middleware';
import { requireActiveUser } from '../middlewares/auth.middleware';
import { WaseetAiClient, extractTtsWav, type FetchLike } from '../services/ai/waseet-ai/waseet-ai.client';
import { WaseetAiError, WaseetAiErrorCode } from '../services/ai/waseet-ai/waseet-ai.errors';
import type { WaseetAiConfig } from '../config/ai/waseet-ai.config';
import {
	MAX_TTS_TEXT_LENGTH,
	TTS_DIALECTS,
	TTS_MODEL,
	TTS_VOICES,
	createUserRateLimiter,
	validateTtsInput,
} from '../services/ai/help-assistant-tts';

// POST /api/help-assistant/tts. No test here makes a network call to
// WaseetAI: upstream `fetch` is a recording mock and the bearer "token" is a
// synthetic marker built at runtime. Requests go to a throwaway Express app
// on an ephemeral localhost port.

const TEST_TOKEN = ['tts', 'unit', 'marker'].join('-');
const UPSTREAM_SECRET_TEXT = 'upstream-internal-detail-should-never-leak';

/** A minimal valid RIFF/WAVE payload (header + a few samples). */
function wavBytes(): Buffer {
	const b = Buffer.alloc(64);
	b.write('RIFF', 0, 'ascii');
	b.writeUInt32LE(56, 4);
	b.write('WAVE', 8, 'ascii');
	b.write('fmt ', 12, 'ascii');
	return b;
}

interface Recorded { url: string; init: RequestInit }

function upstreamFetch(status: number, body: unknown, calls: Recorded[]): FetchLike {
	return async (url, init) => {
		calls.push({ url, init });
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
	};
}

function realClient(fetchImpl: FetchLike, configured = true): WaseetAiClient {
	const config: WaseetAiConfig = { baseUrl: 'https://waseet-ai.test', bearerToken: configured ? TEST_TOKEN : undefined, restTimeoutMs: 1_000, streamTimeoutMs: 1_000 };
	return new WaseetAiClient(fetchImpl, () => config);
}

const CLIENT_USER = { userId: 'user-1', id: 'user-1', email: 'u@test', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: [] };

/** Test-only stand-in for `authenticate`: sets a verified user. */
const asUser = (user: Record<string, unknown> = CLIENT_USER): RequestHandler => (req, _res, next) => {
	(req as any).user = user;
	next();
};

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function start(router: express.Router): Promise<string> {
	const app = express();
	app.use(express.json());
	app.use('/api/help-assistant', router);
	app.use(globalErrorHandler);
	const server = await new Promise<Server>((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s));
	});
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/help-assistant/tts`;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

const VALID = { text: 'أهلاً بك في وسيط', voice: 'Kore', dialect: 'saudi' };

function authedRouter(opts: { fetchImpl?: FetchLike; configured?: boolean; calls?: Recorded[]; user?: Record<string, unknown>; blocked?: boolean; limited?: (id: string) => boolean } = {}) {
	const calls = opts.calls ?? [];
	const fetchImpl = opts.fetchImpl ?? upstreamFetch(200, { success: true, data: { audio: { base64Audio: wavBytes().toString('base64') } } }, calls);
	return createHelpAssistantTtsRouter({
		guards: [asUser(opts.user), requireActiveUser],
		client: realClient(fetchImpl, opts.configured ?? true),
		isBlocked: async () => opts.blocked === true,
		isRateLimited: opts.limited ?? (() => false),
	});
}

// ── authentication ──────────────────────────────────────────────────────

test('TTS: unauthenticated request (no token) is rejected 401 by the REAL authenticate guard, and never reaches upstream', async () => {
	const calls: Recorded[] = [];
	const url = await start(createHelpAssistantTtsRouter({ client: realClient(upstreamFetch(200, {}, calls)), isBlocked: async () => false, isRateLimited: () => false }));
	const res = await post(url, VALID);
	assert.equal(res.status, 401);
	assert.equal(calls.length, 0);
});

test('TTS: an invalid/forged JWT is rejected 401 by the REAL authenticate guard', async () => {
	const prev = process.env.JWT_SECRET;
	process.env.JWT_SECRET = ['unit', 'jwt', 'secret'].join('-');
	try {
		const calls: Recorded[] = [];
		const url = await start(createHelpAssistantTtsRouter({ client: realClient(upstreamFetch(200, {}, calls)), isBlocked: async () => false, isRateLimited: () => false }));
		const res = await post(url, VALID, { Authorization: 'Bearer not-a-real-jwt' });
		assert.equal(res.status, 401);
		assert.equal(calls.length, 0);
	} finally {
		if (prev === undefined) delete process.env.JWT_SECRET;
		else process.env.JWT_SECRET = prev;
	}
});

test('TTS: the production router is wired with authenticate + requireActiveUser + aiLimiter, and app.ts mounts it at /help-assistant', () => {
	const routeSource = fs.readFileSync(path.join(__dirname, 'help-assistant-tts.routes.ts'), 'utf8');
	assert.match(routeSource, /options\.guards \?\? \[authenticate, requireActiveUser, aiLimiter\]/);
	const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.ts'), 'utf8');
	assert.match(appSource, /mountApiRoute\('\/help-assistant', helpAssistantTtsRouter\)/);
});

test('TTS: a user whose role cannot be mapped, or who is banned, is rejected 403 without an upstream call', async () => {
	const calls: Recorded[] = [];
	let res = await post(await start(authedRouter({ calls, user: { ...CLIENT_USER, accountType: 'UNKNOWN', activeRole: undefined } })), VALID);
	assert.equal(res.status, 403);
	res = await post(await start(authedRouter({ calls, blocked: true })), VALID);
	assert.equal(res.status, 403);
	assert.equal(calls.length, 0);
});

// ── authenticated happy path ────────────────────────────────────────────

test('TTS: authenticated request → mocked upstream → 200 audio/wav with the exact WAV bytes', async () => {
	const calls: Recorded[] = [];
	const res = await post(await start(authedRouter({ calls })), VALID);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('content-type'), 'audio/wav');
	assert.equal(res.headers.get('cache-control'), 'no-store');
	const body = Buffer.from(await res.arrayBuffer());
	assert.deepEqual(body, wavBytes());

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://waseet-ai.test/v1/ai/tts/synthesize');
	assert.equal(calls[0].init.method, 'POST');
	// Exactly the Bebo v4 handoff request body — model fixed server-side.
	assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
		text: VALID.text, dialect: 'saudi', voice: 'Kore', model: TTS_MODEL, speakingRate: 'normal', mimeType: 'audio/wav',
	});
});

test('TTS: identity comes from the authenticated request — client-supplied userId/role/model are never trusted or forwarded', async () => {
	const calls: Recorded[] = [];
	const limitedFor: string[] = [];
	const url = await start(authedRouter({ calls, limited: (id) => { limitedFor.push(id); return false; } }));
	const res = await post(url, { ...VALID, userId: 'victim-user', role: 'admin', model: 'gemini-3.8-flash-tts' });
	assert.equal(res.status, 200);
	assert.deepEqual(limitedFor, ['user-1']);
	const sent = JSON.parse(String(calls[0].init.body));
	assert.equal(sent.model, TTS_MODEL);
	assert.equal('userId' in sent || 'role' in sent, false);
});

test('TTS: the bearer token is only ever sent upstream — never in the response headers or body', async () => {
	const calls: Recorded[] = [];
	const res = await post(await start(authedRouter({ calls })), VALID);
	assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TEST_TOKEN}`);
	const raw = Buffer.from(await res.arrayBuffer()).toString('latin1');
	assert.equal(raw.includes(TEST_TOKEN), false);
	for (const [, v] of res.headers) assert.equal(v.includes(TEST_TOKEN), false);
});

test('TTS: all audio locations accepted by the handoff are handled (base64Audio, base64, audioUrl data URL, data.audioUrl)', async () => {
	const b64 = wavBytes().toString('base64');
	for (const data of [
		{ audio: { base64Audio: b64 } },
		{ audio: { base64: b64 } },
		{ audio: { audioUrl: `data:audio/wav;base64,${b64}` } },
		{ audio: { url: `data:audio/wav;base64,${b64}` } },
		{ audioUrl: `data:audio/wav;base64,${b64}` },
	]) {
		assert.deepEqual(extractTtsWav(data), wavBytes(), JSON.stringify(Object.keys(data)));
	}
});

test('TTS: non-WAV / truncated / non-base64 / mp3 data-URL audio is rejected by the extractor', () => {
	const notWav = Buffer.alloc(64, 1).toString('base64');
	assert.equal(extractTtsWav({ audio: { base64Audio: notWav } }), null);
	assert.equal(extractTtsWav({ audio: { base64Audio: 'UklGRg==' } }), null);
	assert.equal(extractTtsWav({ audio: { base64Audio: '<script>'.repeat(20) } }), null);
	assert.equal(extractTtsWav({ audioUrl: `data:audio/mpeg;base64,${wavBytes().toString('base64')}` }), null);
	assert.equal(extractTtsWav({ audio: { someOtherField: wavBytes().toString('base64') } }), null);
	assert.equal(extractTtsWav(null), null);
});

test('TTS: an upstream 200 without valid WAV audio becomes a sanitized 502 (no audio fabricated)', async () => {
	const res = await post(await start(authedRouter({ fetchImpl: upstreamFetch(200, { success: true, data: { audio: { base64Audio: Buffer.alloc(64, 1).toString('base64') } } }, []) })), VALID);
	assert.equal(res.status, 502);
	const json = await res.json();
	assert.equal(json.code, 'UNAVAILABLE');
});

// ── validation ──────────────────────────────────────────────────────────

test('TTS: invalid voice is rejected 400 without an upstream call', async () => {
	const calls: Recorded[] = [];
	const url = await start(authedRouter({ calls }));
	for (const voice of ['Alloy', 'puck', '', 42, undefined]) {
		const res = await post(url, { ...VALID, voice });
		assert.equal(res.status, 400, String(voice));
		assert.equal((await res.json()).code, 'INVALID_INPUT');
	}
	assert.equal(calls.length, 0);
});

test('TTS: invalid dialect (including the UI-only "auto") is rejected 400 without an upstream call', async () => {
	const calls: Recorded[] = [];
	const url = await start(authedRouter({ calls }));
	for (const dialect of ['auto', 'levantine', 'EGYPTIAN', '', null]) {
		const res = await post(url, { ...VALID, dialect });
		assert.equal(res.status, 400, String(dialect));
	}
	assert.equal(calls.length, 0);
});

test('TTS: empty or oversized text is rejected 400 without an upstream call', async () => {
	const calls: Recorded[] = [];
	const url = await start(authedRouter({ calls }));
	for (const text of ['', '   ', 'x'.repeat(MAX_TTS_TEXT_LENGTH + 1), 123]) {
		const res = await post(url, { ...VALID, text });
		assert.equal(res.status, 400);
	}
	const ok = await post(url, { ...VALID, text: 'x'.repeat(MAX_TTS_TEXT_LENGTH) });
	assert.equal(ok.status, 200);
	assert.equal(calls.length, 1);
});

test('TTS: allowlists are exactly the Bebo v4 handoff voice/dialect lists', () => {
	assert.deepEqual([...TTS_VOICES], ['Puck', 'Kore', 'Fenrir', 'Aoede', 'Zephyr', 'Sulafat', 'Charon', 'Leda']);
	assert.deepEqual([...TTS_DIALECTS], ['egyptian', 'saudi', 'gulf', 'msa', 'english']);
	assert.equal(validateTtsInput([VALID]).ok, false);
	assert.equal(validateTtsInput('text').ok, false);
});

// ── limits / configuration / upstream failures ──────────────────────────

test('TTS: per-user rate limit → 429 without an upstream call; limiter windows are per user', async () => {
	const calls: Recorded[] = [];
	const res = await post(await start(authedRouter({ calls, limited: () => true })), VALID);
	assert.equal(res.status, 429);
	assert.equal(calls.length, 0);

	let now = 0;
	const limited = createUserRateLimiter(2, 1000, () => now);
	assert.equal(limited('a'), false);
	assert.equal(limited('a'), false);
	assert.equal(limited('a'), true);
	assert.equal(limited('b'), false);
	now = 1001;
	assert.equal(limited('a'), false);
});

test('TTS: fails closed with 503 NOT_CONFIGURED when the bearer token is unavailable — no upstream call', async () => {
	const calls: Recorded[] = [];
	const res = await post(await start(authedRouter({ calls, configured: false })), VALID);
	assert.equal(res.status, 503);
	assert.equal((await res.json()).code, 'NOT_CONFIGURED');
	assert.equal(calls.length, 0);
});

test('TTS: upstream failures are sanitized — fixed message, no upstream body, no token', async () => {
	for (const [status, expected, code] of [[500, 502, 'UNAVAILABLE'], [401, 502, 'UNAVAILABLE'], [429, 429, 'RATE_LIMITED'], [400, 502, 'UNAVAILABLE']] as const) {
		const res = await post(await start(authedRouter({ fetchImpl: upstreamFetch(status, { success: false, error: { message: UPSTREAM_SECRET_TEXT, token: TEST_TOKEN } }, []) })), VALID);
		assert.equal(res.status, expected, `upstream ${status}`);
		const text = await res.text();
		assert.equal(JSON.parse(text).code, code);
		assert.equal(text.includes(UPSTREAM_SECRET_TEXT), false);
		assert.equal(text.includes(TEST_TOKEN), false);
	}
	// success:false envelope on HTTP 200 is also a failure, not audio.
	const res = await post(await start(authedRouter({ fetchImpl: upstreamFetch(200, { success: false, message: UPSTREAM_SECRET_TEXT }, []) })), VALID);
	assert.equal(res.status, 502);
	assert.equal((await res.text()).includes(UPSTREAM_SECRET_TEXT), false);
});

test('TTS: upstream timeout → 504 TIMEOUT; network failure → 502', async () => {
	const timeoutFetch: FetchLike = async () => { throw new WaseetAiError(WaseetAiErrorCode.TIMEOUT, 'x'); };
	let res = await post(await start(authedRouter({ fetchImpl: timeoutFetch })), VALID);
	assert.equal(res.status, 504);
	const netFetch: FetchLike = async () => { throw new TypeError(`fetch failed ${UPSTREAM_SECRET_TEXT}`); };
	res = await post(await start(authedRouter({ fetchImpl: netFetch })), VALID);
	assert.equal(res.status, 502);
	assert.equal((await res.text()).includes(UPSTREAM_SECRET_TEXT), false);
});
