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
