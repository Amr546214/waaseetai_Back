import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAssistantToolsHandlers } from './help-assistant-tools';

function fixture(body: unknown, query: unknown = {}) {
  const req: any = { body, query, params: { runId: 'run-1' }, user: { id: 'verified-user', activeRole: 'CLIENT', accountType: 'CLIENT_INDIVIDUAL' } };
  const res: any = new EventEmitter();
  Object.assign(res, { statusCode: 200, writableEnded: false, status(code: number) { this.statusCode = code; return this; },
    set() { return this; }, json(value: unknown) { this.body = value; this.writableEnded = true; return this; } });
  return { req, res };
}
function handlers(calls: any[]) {
  const record = async (...args: any[]) => { calls.push(args); return { text: 'تفريغ' }; };
  return createAssistantToolsHandlers({ isBlocked: async () => false, client: { getCapabilities: record, transcribe: record, liveToken: record, createRun: record, runOperation: record } });
}
test('recorded browser MIME is normalized and privacy/actor come from the server', async () => {
  for (const [mimeType, expected] of [['audio/webm;codecs=opus', 'audio/webm'], ['audio/ogg;codecs=opus', 'audio/ogg'], ['audio/mp4', 'audio/m4a']]) {
    const calls: any[] = []; const { req, res } = fixture({ mimeType, audioBase64: Buffer.from('synthetic audio').toString('base64') });
    await handlers(calls).stt(req, res);
    assert.equal(res.statusCode, 200); assert.equal(calls[0][0].mimeType, expected); assert.equal(calls[0][0].classification, 'PERSONAL');
    assert.deepEqual(calls[0][1].actor, { userId: 'verified-user', role: 'client' });
  }
});
test('STT rejects browser identity, incompatible timing and oversized audio without forwarding', async () => {
  const calls: any[] = []; const h = handlers(calls), audioBase64 = Buffer.from('synthetic').toString('base64');
  for (const body of [{ audioBase64, mimeType: 'audio/wav', userId: 'other' }, { audioBase64, mimeType: 'audio/wav', mode: 'smart', timestamps: true }, { audioBase64: 'A'.repeat(8_000_004), mimeType: 'audio/wav' }]) {
    const { req, res } = fixture(body); await h.stt(req, res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});
test('Live cannot select an unimplemented model', async () => {
  const calls: any[] = [], { req, res } = fixture({ model: 'gemini-3.8-live-extended-thinking' });
  await handlers(calls).live(req, res); assert.equal(res.statusCode, 400); assert.equal(calls.length, 0);
});
test('run event cursor is validated and forwarded so later pages are reachable', async () => {
  const calls: any[] = [], h = handlers(calls), { req, res } = fixture({}, { after: '201' });
  await h.events(req, res); assert.equal(res.statusCode, 200); assert.deepEqual(calls[0][2], { after: 201 });
  const invalid = fixture({}, { after: '-1' }); await h.events(invalid.req, invalid.res); assert.equal(invalid.res.statusCode, 400); assert.equal(calls.length, 1);
});

function capabilitiesFixture(role = 'CLIENT') {
  const { req, res } = fixture({});
  req.user = { id: `verified-${role}`, activeRole: role, accountType: role === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : 'PROVIDER_INDIVIDUAL' };
  return { req, res };
}
test('capabilities: the AI service is asked once per role per cache window, and a ban is still checked on every request', async () => {
  let calls = 0, banned = false, clock = 1_000;
  const { createAssistantToolsHandlers: make, CAPABILITIES_CACHE_TTL_MS } = await import('./help-assistant-tools');
  const h = make({ now: () => clock, isBlocked: async () => banned, client: { getCapabilities: async () => { calls++; return { models: [], voices: [] }; }, transcribe: async () => ({}), liveToken: async () => ({}), createRun: async () => ({}), runOperation: async () => ({}) } as any });
  for (let i = 0; i < 40; i++) { const f = capabilitiesFixture(); await h.capabilities(f.req, f.res); assert.equal(f.res.statusCode, 200); assert.deepEqual(f.res.body, { success: true, data: { models: [], voices: [] } }); }
  assert.equal(calls, 1);
  const other = capabilitiesFixture('PROVIDER'); await h.capabilities(other.req, other.res); assert.equal(calls, 2, 'another role has its own entry');
  banned = true; const b = capabilitiesFixture(); await h.capabilities(b.req, b.res); assert.equal(b.res.statusCode, 403); assert.equal(calls, 2, 'a banned account never reads the cache');
  banned = false; clock += CAPABILITIES_CACHE_TTL_MS + 1; const again = capabilitiesFixture(); await h.capabilities(again.req, again.res); assert.equal(calls, 3, 'asked again once the window passed');
});
test('capabilities: a failed answer is not cached, concurrent first requests share one upstream call', async () => {
  let calls = 0, fail = true;
  const { createAssistantToolsHandlers: make } = await import('./help-assistant-tools');
  const h = make({ isBlocked: async () => false, client: { getCapabilities: async () => { calls++; await new Promise(r => setTimeout(r, 15)); if (fail) throw new Error('upstream down'); return { models: [], voices: [] }; }, transcribe: async () => ({}), liveToken: async () => ({}), createRun: async () => ({}), runOperation: async () => ({}) } as any });
  const first = capabilitiesFixture(); await h.capabilities(first.req, first.res); assert.equal(first.res.statusCode, 503);
  fail = false; calls = 0;
  const fs = [capabilitiesFixture(), capabilitiesFixture(), capabilitiesFixture()]; await Promise.all(fs.map(f => h.capabilities(f.req, f.res)));
  assert.equal(calls, 1); for (const f of fs) assert.equal(f.res.statusCode, 200);
});
