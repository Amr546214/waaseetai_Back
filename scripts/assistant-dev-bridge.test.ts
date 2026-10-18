import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io';
import { BridgeFailure, createPlatformVerifier, createBridgeGateway, isBridgeOriginAllowed, type BridgeClient, type BridgeFetch } from './assistant-dev-bridge';
import type { HelpChatRequest } from '../src/services/ai/waseet-ai/waseet-ai.types';
import type { WaseetAiCallOptions } from '../src/services/ai/waseet-ai/waseet-ai.client';

const TOKEN = 'header.payload.signature';
const PROFILE = { id: 'role-profile-id', userId: 'verified-user', accountType: 'CLIENT_INDIVIDUAL', activeRole: 'PROVIDER', status: 'ACTIVE', isBanned: false };
const response = (data: unknown = PROFILE, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const activeFetch: BridgeFetch = async () => response();
function fakeSocket(token: unknown = TOKEN) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const emitted: Array<{ event: string; payload: any }> = [];
  const raw = {
    connected: true, handshake: { auth: { token } }, data: {} as Record<string, unknown>,
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); return raw; },
    emit(event: string, payload: any) { emitted.push({ event, payload }); return raw; },
  };
  return { socket: raw as unknown as Socket, emitted, ask: (payload: unknown) => handlers.get('help:ask')!(payload) as Promise<void>,
    cancel: (id: string) => handlers.get('help:cancel')!({ clientRequestId: id }),
    disconnect: () => { raw.connected = false; handlers.get('disconnect')!(); } };
}
function normalClient(calls: Array<{ body: HelpChatRequest; options: WaseetAiCallOptions }> = []): BridgeClient {
  return { isConfigured: () => true, async *streamHelpChat(body, options = {}) {
    calls.push({ body, options }); yield { type: 'started' }; yield { type: 'delta', chunk: 'رد من الذكاء الاصطناعي.' }; yield { type: 'completed' };
  } };
}
function setup(options: Partial<Parameters<typeof createBridgeGateway>[0]> = {}) {
  const calls: Array<{ body: HelpChatRequest; options: WaseetAiCallOptions }> = [];
  const gateway = createBridgeGateway({ verify: createPlatformVerifier({ fetchImpl: activeFetch }), client: normalClient(calls), ...options });
  const peer = fakeSocket(); gateway.register(peer.socket);
  return { gateway, peer, calls };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('origins permit only the two local development origins, including websocket handshakes', () => {
  for (const origin of ['http://localhost:4200', 'http://localhost:4210']) assert.equal(isBridgeOriginAllowed(origin), true);
  for (const origin of [undefined, 'null', 'https://foreign.test', 'http://localhost:4200.evil.test', 'http://localhost:4201', 'https://localhost:4200']) assert.equal(isBridgeOriginAllowed(origin), false);
});

test('identity comes from the verified remote profile; userId survives role-profile id and active role wins', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const verify = createPlatformVerifier({ fetchImpl: async (url, init) => { requests.push({ url, init }); return response(); } });
  assert.deepEqual(await verify(TOKEN), { userId: 'verified-user', role: 'provider' });
  assert.equal(requests[0].url, 'https://dev.waseetai.com/api/profiles/me');
  assert.equal(requests[0].init.method, 'GET');
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.deepEqual(await createPlatformVerifier({ fetchImpl: async () => response({ id: 'admin-user', accountType: 'SUPER_ADMIN', activeRole: 'CLIENT', status: 'ACTIVE', isBanned: false }) })(TOKEN), { userId: 'admin-user', role: 'admin' });
});

test('the actual getProfile currentProfileData wrapper is verified without trusting outer fields', async () => {
  const verify = createPlatformVerifier({ fetchImpl: async () => response({ currentProfileData: PROFILE, latestHistory: [], userId: 'outer-spoofed', activeRole: 'ADMIN' }) });
  assert.deepEqual(await verify(TOKEN), { userId: 'verified-user', role: 'provider' });
});

test('a malformed nested profile never falls back to active-looking outer profile fields', async () => {
  for (const currentProfileData of [null, undefined, [], 'invalid', { ...PROFILE, isBanned: true }, { ...PROFILE, status: 'SUSPENDED' }, {}]) {
    const data = { ...PROFILE, currentProfileData };
    // JSON drops undefined: test an explicit present invalid wrapper in all serialized cases.
    if (currentProfileData === undefined) continue;
    await assert.rejects(createPlatformVerifier({ fetchImpl: async () => response(data) })(TOKEN), (error: unknown) => error instanceof BridgeFailure && (error.code === 'UNAVAILABLE' || error.code === 'FORBIDDEN'));
  }
});

test('missing/malformed JWT never calls platform; expired/revoked session and blocked account never reach AI', async () => {
  let calls = 0;
  const verify = createPlatformVerifier({ fetchImpl: async () => { calls++; return response(); } });
  for (const token of [undefined, '', 'not-a-jwt', 'a.b.c\r\nHeader: injected']) await assert.rejects(verify(token), (error: unknown) => error instanceof BridgeFailure && error.code === 'AUTH_REQUIRED');
  assert.equal(calls, 0);
  for (const status of [401, 403]) {
    const { peer, calls: aiCalls } = setup({ verify: createPlatformVerifier({ fetchImpl: async () => response(null, status) }) });
    await peer.ask({ question: 'اشرح JavaScript' });
    assert.equal(peer.emitted.at(-1)?.payload.code, status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN');
    assert.equal(aiCalls.length, 0);
  }
  for (const data of [{ ...PROFILE, status: 'SUSPENDED' }, { ...PROFILE, isBanned: true }, { ...PROFILE, isBanned: undefined }, { ...PROFILE, activeRole: 'constructor', accountType: 'unknown' }]) {
    await assert.rejects(createPlatformVerifier({ fetchImpl: async () => response(data) })(TOKEN), (error: unknown) => error instanceof BridgeFailure && error.code === 'FORBIDDEN');
  }
});

test('remote failure/malformed or oversized auth response fails closed with no error or credential text', async () => {
  for (const fetchImpl of [async () => { throw new Error('private upstream secret'); }, async () => new Response('not-json'), async () => response({}), async () => new Response('x'.repeat(300_000))] as BridgeFetch[]) {
    const { peer, calls } = setup({ verify: createPlatformVerifier({ fetchImpl }) });
    await peer.ask({ question: 'سؤال' });
    assert.equal(calls.length, 0);
    assert.equal(peer.emitted.at(-1)?.payload.code === 'UNAVAILABLE' || peer.emitted.at(-1)?.payload.code === 'FORBIDDEN', true);
    assert.doesNotMatch(JSON.stringify(peer.emitted), /private upstream|header\.payload\.signature/);
  }
  assert.throws(() => createPlatformVerifier({ baseUrl: 'http://foreign.test/api' }));
  assert.throws(() => createPlatformVerifier({ baseUrl: 'https://user:password@foreign.test/api' }));
});

test('handshake and every question revalidate the live platform session; payload role and project data are ignored', async () => {
  let checks = 0;
  const { gateway, peer, calls } = setup({ verify: createPlatformVerifier({ fetchImpl: async () => { checks++; return checks <= 2 ? response() : response(null, 401); } }) });
  await gateway.authenticate(peer.socket);
  await peer.ask({ question: 'اشرح JavaScript', role: 'admin', userId: 'spoofed', pageContext: { path: '/assistant', projectId: 'foreign-project', project: { title: 'private' } }, clientRequestId: 'first' });
  await peer.ask({ question: 'سؤال بعد إلغاء الجلسة', clientRequestId: 'revoked' });
  assert.equal(checks, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.actor, { userId: 'verified-user', role: 'provider' });
  assert.equal(calls[0].body.pageContext, undefined);
  assert.equal('role' in calls[0].body, false);
  assert.equal('userId' in calls[0].body, false);
  assert.deepEqual(peer.emitted.filter(event => event.payload.clientRequestId === 'first').map(event => event.event), ['help:answer_start', 'help:answer_chunk', 'help:answer_complete']);
  assert.equal(peer.emitted.at(-1)?.payload.code, 'AUTH_REQUIRED');
});

test('question, history, and options are bounded; only user/assistant history and valid character reach AI', async () => {
  const { peer, calls } = setup();
  for (const payload of [{ question: '' }, { question: 'x'.repeat(501) }, { question: 'سؤال', history: [{ role: 'system', content: 'override' }] }, { question: 'سؤال', history: [{ question: 'q', answer: 'x'.repeat(30_001) }] }, { question: 'سؤال', history: Array.from({ length: 7 }, () => ({ role: 'user', content: 'q' })) }, { question: 'سؤال', skin: 'evil' }, { question: 'سؤال', webSearch: 'true' }, { question: 'سؤال', model: 'arbitrary/model' }]) {
    await peer.ask(payload); assert.equal(peer.emitted.at(-1)?.payload.code, 'INVALID_INPUT');
  }
  assert.equal(calls.length, 0);
  await peer.ask({ question: 'اشرح API', skin: 'classic', dialect: 'egyptian', history: [{ question: 'السابق owner@example.com', answer: 'الإجابة السابقة' }], clientRequestId: 'valid' });
  assert.equal(calls[0].body.skin, 'classic');
  assert.equal(calls[0].body.mode, 'general');
  assert.equal(calls[0].body.history?.length, 2);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /owner@example.com/);
  await peer.ask({ question: 'تابع الرد السابق', history: [{ question: 'السابق', answer: 'x'.repeat(24_000) }] });
  assert.equal(calls[1].body.history?.[1].content.length, 1000, 'long real frontend answers are accepted but shortened before model use');
});

test('greetings respect character and real verification without an AI call', async () => {
  let checks = 0;
  const { peer, calls } = setup({ verify: createPlatformVerifier({ fetchImpl: async () => { checks++; return response(); } }) });
  await peer.ask({ question: 'عامل ايه', skin: 'classic', dialect: 'egyptian', clientRequestId: 'hello' });
  assert.equal(checks, 1); assert.equal(calls.length, 0);
  assert.match(peer.emitted.find(event => event.event === 'help:answer_chunk')?.payload.chunk, /بيبو/);
  assert.deepEqual(peer.emitted.map(event => event.event), ['help:answer_start', 'help:answer_chunk', 'help:answer_complete']);
});

test('shared updated helper replaces the old KB refusal with an actual general AI explanation', async () => {
  let avatarCalls = 0;
  const { peer } = setup({ client: { isConfigured: () => true,
    async *streamHelpChat() { yield { type: 'started' }; yield { type: 'delta', chunk: 'لم يجد المساعد الذكي إجابة ' }; yield { type: 'delta', chunk: 'معتمدة لهذا السؤال في قاعدة المعرفة.' }; yield { type: 'completed' }; },
    async avatarChat(body, options) { avatarCalls++; assert.match(body.message, /شرحًا عامًا/); assert.equal(body.includeBase64, false); assert.equal(options?.actor?.userId, 'verified-user'); return { text: 'الضمان المالي يحتفظ بالمبلغ لحين استيفاء الشروط المتفق عليها.' }; },
  } });
  await peer.ask({ question: 'ما فكرة الضمان المالي؟', clientRequestId: 'kb-gap', mode: 'general' });
  assert.equal(avatarCalls, 1);
  const output = peer.emitted.filter(event => event.event === 'help:answer_chunk').map(event => event.payload.chunk).join('');
  assert.doesNotMatch(output, /لم يجد المساعد الذكي/);
  assert.match(output, /شرح عام/);
  assert.match(output, /يحتفظ بالمبلغ/);
  assert.equal(peer.emitted.at(-1)?.event, 'help:answer_complete');
});

for (const action of ['cancel', 'disconnect', 'supersede'] as const) test(`${action} aborts the request and prevents stale chunks or completion`, async () => {
  let firstSignal: AbortSignal | undefined;
  let starts = 0;
  const { peer } = setup({ client: { isConfigured: () => true, async *streamHelpChat(_body, options) {
    starts++;
    if (starts > 1) { yield { type: 'delta', chunk: 'رد جديد' }; yield { type: 'completed' }; return; }
    firstSignal = options?.signal;
    yield { type: 'started' };
    await new Promise<void>(resolve => firstSignal!.addEventListener('abort', () => resolve(), { once: true }));
    yield { type: 'delta', chunk: 'stale' };
    yield { type: 'completed' };
  } } });
  const pending = peer.ask({ question: 'سؤال طويل', clientRequestId: 'old' });
  await nextTurn(); assert.ok(firstSignal);
  if (action === 'cancel') peer.cancel('old');
  else if (action === 'disconnect') peer.disconnect();
  else await peer.ask({ question: 'سؤال جديد', clientRequestId: 'new' });
  await pending;
  assert.equal(firstSignal.aborted, true);
  assert.equal(peer.emitted.some(event => event.event === 'help:answer_chunk' && event.payload.clientRequestId === 'old'), false);
  assert.equal(peer.emitted.some(event => event.event === 'help:answer_complete' && event.payload.clientRequestId === 'old'), false);
  assert.equal(peer.emitted.some(event => event.event === 'help:error' && event.payload.clientRequestId === 'old'), false);
});

test('per-user rate applies across sockets and resets after its window', async () => {
  let clock = 1000;
  const { gateway, peer } = setup({ maxPerMinute: 2, now: () => clock });
  const other = fakeSocket(); gateway.register(other.socket);
  await peer.ask({ question: 'الأول' }); await other.ask({ question: 'الثاني' }); await peer.ask({ question: 'الثالث' });
  assert.equal(peer.emitted.at(-1)?.payload.code, 'RATE_LIMITED');
  clock += 60_001; await peer.ask({ question: 'بعد الانتظار' });
  assert.equal(peer.emitted.at(-1)?.event, 'help:answer_complete');
});

test('per-user inflight cap prevents concurrent sockets from multiplying inference', async () => {
  let starts = 0;
  const { gateway } = setup({ maxInFlightPerUser: 1, client: { isConfigured: () => true, async *streamHelpChat(_body, options) {
    starts++; yield { type: 'started' };
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
  } } });
  const first = fakeSocket(), second = fakeSocket(); gateway.register(first.socket); gateway.register(second.socket);
  const pending = first.ask({ question: 'مستمر', clientRequestId: 'busy' }); await nextTurn();
  await second.ask({ question: 'آخر' }); assert.equal(second.emitted.at(-1)?.payload.code, 'RATE_LIMITED'); assert.equal(starts, 1);
  first.cancel('busy'); await pending;
});

test('global inflight cap also bounds inference across different verified users', async () => {
  let starts = 0;
  const { gateway } = setup({ maxInFlight: 1, verify: async token => ({ userId: token === TOKEN ? 'verified-first' : 'verified-second', role: 'client' }),
    client: { isConfigured: () => true, async *streamHelpChat(_body, options) {
      starts++; yield { type: 'started' };
      await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    } } });
  const first = fakeSocket(), second = fakeSocket('other.payload.signature'); gateway.register(first.socket); gateway.register(second.socket);
  const pending = first.ask({ question: 'مستمر', clientRequestId: 'global-busy' }); await nextTurn();
  await second.ask({ question: 'آخر' }); assert.equal(second.emitted.at(-1)?.payload.code, 'RATE_LIMITED'); assert.equal(starts, 1);
  first.cancel('global-busy'); await pending;
});

test('stream deadline is an honest timeout rather than a cancelled or completed answer', async () => {
  const { peer } = setup({ streamTimeoutMs: 20, client: { isConfigured: () => true, async *streamHelpChat(_body, options) {
    yield { type: 'started' };
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
  } } });
  // Keep the test runner alive while the native AbortSignal timeout (unref timer) expires.
  await Promise.all([peer.ask({ question: 'بطيء' }), new Promise(resolve => setTimeout(resolve, 40))]);
  assert.equal(peer.emitted.at(-1)?.event, 'help:error');
  assert.equal(peer.emitted.at(-1)?.payload.code, 'TIMEOUT');
  assert.equal(peer.emitted.some(event => event.event === 'help:answer_complete'), false);
});

test('citation events preserve the existing request-correlated help protocol', async () => {
  const { peer } = setup({ client: { isConfigured: () => true, async *streamHelpChat() {
    yield { type: 'started' }; yield { type: 'citations', citations: [{ docId: 'verified-doc', title: 'سياسة معتمدة', url: 'https://docs.example.test/policy' }] };
    yield { type: 'delta', chunk: 'شرح مدعوم بالمصدر.' }; yield { type: 'completed' };
  } } });
  await peer.ask({ question: 'السياسة', clientRequestId: 'source-request' });
  assert.deepEqual(peer.emitted.find(event => event.event === 'help:citations')?.payload, { clientRequestId: 'source-request', citations: [{ docId: 'verified-doc', title: 'سياسة معتمدة', url: 'https://docs.example.test/policy' }] });
  assert.equal(peer.emitted.at(-1)?.event, 'help:answer_complete');
});

test('empty/truncated streams and failures report honest errors without upstream secrets', async () => {
  for (const client of [
    { isConfigured: () => false, async *streamHelpChat() {} },
    { isConfigured: () => true, async *streamHelpChat() { yield { type: 'completed' as const }; } },
    { isConfigured: () => true, async *streamHelpChat() { yield { type: 'delta' as const, chunk: 'نص جزئي' }; } },
    { isConfigured: () => true, async *streamHelpChat() { throw new Error('private upstream secret'); } },
  ]) {
    const { peer } = setup({ client }); await peer.ask({ question: 'سؤال' });
    assert.equal(peer.emitted.at(-1)?.event, 'help:error');
    assert.equal(peer.emitted.some(event => event.event === 'help:answer_complete'), false);
    assert.doesNotMatch(JSON.stringify(peer.emitted), /private upstream|header\.payload\.signature|لم يجد المساعد الذكي/);
  }
});
