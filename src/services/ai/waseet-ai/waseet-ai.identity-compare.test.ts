import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaseetAiClient, type FetchLike } from './waseet-ai.client';
import { WaseetAiErrorCode } from './waseet-ai.errors';
import type { WaseetAiConfig } from '../../../config/ai/waseet-ai.config';
import { logger } from '../../../config/logger';

// Contract client for POST /v1/ai/identity/compare-fields. fetch is a recording mock: NO real network call; the contract itself is taken from the brief and is
// NOT verified against a live service. Synthetic data only.
const cfg = (): WaseetAiConfig => ({ baseUrl: 'https://ai.example.test', bearerToken: ['unit', 'test', 'marker'].join('-'), restTimeoutMs: 5000, streamTimeoutMs: 5000, authMode: 'legacy', clientId: 'waseet_core_backend', environment: 'dev' });
const ID = '29001011234567'; const IMG = Buffer.from('SYNTHETIC-IMAGE-BYTES').toString('base64');
const body = { requestId: 'r-1', image: IMG, imageMimeType: 'image/jpeg', registered: { fullName: 'اسم تجريبي', birthDate: '1990-01-01', nationalId: ID } };
const okData = (over: any = {}) => ({ fields: { name: 'MATCH', birthDate: 'MISMATCH', nationalId: 'UNREADABLE' }, faceMatch: 'NOT_CHECKED', liveness: 'NOT_CHECKED', documentAuthenticity: 'NOT_CHECKED', ...over });
const envelope = (data = okData(), requestId = 'r-1') => ({ success: true, requestId, data });
const mk = (status: number, payload: unknown, calls: any[] = []): FetchLike => async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }); };

test('sends the contract request with the standard headers and returns the validated response', async () => {
	const calls: any[] = [];
	const res = await new WaseetAiClient(mk(200, envelope(), calls), cfg).compareIdentityFields(body);
	assert.equal(calls[0].url, 'https://ai.example.test/v1/ai/identity/compare-fields');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers['X-Request-Id'], 'r-1');
	assert.equal(calls[0].init.headers['X-Client-Id'], 'waseet_core_backend');
	assert.match(calls[0].init.headers.Authorization, /^Bearer /);
	assert.equal(JSON.parse(calls[0].init.body).declared.nationalId, ID);
	assert.equal(res.fields.birthDate.status, 'MISMATCH');
	assert.equal(res.fields.nationalId.status, 'COULD_NOT_VERIFY');
	const document = { country: 'GB', type: 'PASSPORT' } as const;
	await new WaseetAiClient(mk(200, envelope(), calls), cfg).compareIdentityFields({ ...body, document });
	assert.deepEqual(JSON.parse(calls[1].init.body).document, document);
});

test('garbage / partial / wrong-requestId / bad-status responses are INVALID_RESPONSE (never guessed)', async () => {
  const bad = [
    envelope({ nonsense: 1 }), envelope(okData({ fields: { name: 'MATCH' } })),
    envelope(okData(), 'other'),
    envelope(okData({ fields: { ...okData().fields, name: 'YES' } })),
    envelope(okData({ faceMatch: 'MATCH' })), { success: false }, 'not-json-envelope'
  ];
	for (const payload of bad) await assert.rejects(new WaseetAiClient(mk(200, payload), cfg).compareIdentityFields(body), (e: any) => e.code === WaseetAiErrorCode.INVALID_RESPONSE);
});

test('HTTP failures map to the normal taxonomy (5xx unavailable, 429 rate limit, timeout)', async () => {
	await assert.rejects(new WaseetAiClient(mk(503, {}), cfg).compareIdentityFields(body), (e: any) => e.code === WaseetAiErrorCode.PROVIDER_UNAVAILABLE);
	await assert.rejects(new WaseetAiClient(mk(429, {}), cfg).compareIdentityFields(body), (e: any) => e.code === WaseetAiErrorCode.RATE_LIMITED);
	const hang: FetchLike = (_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
	await assert.rejects(new WaseetAiClient(hang, cfg).compareIdentityFields(body, { timeoutMs: 30 }), (e: any) => e.code === WaseetAiErrorCode.TIMEOUT);
});

test('the client never writes the image or the national id to any log level, success or failure', async () => {
	const lines: string[] = [];
	const orig = ['debug', 'info', 'warn', 'error'].map(l => [l, (logger as any)[l]] as const);
	for (const [l] of orig) (logger as any)[l] = (m: any) => { lines.push(String(m)); return logger; };
	try {
		await new WaseetAiClient(mk(200, envelope()), cfg).compareIdentityFields(body);
		await new WaseetAiClient(mk(500, {}), cfg).compareIdentityFields(body).catch(() => undefined);
		await new WaseetAiClient(mk(200, { success: true, data: { x: 1 } }), cfg).compareIdentityFields(body).catch(() => undefined);
	} finally { for (const [l, f] of orig) (logger as any)[l] = f; }
	assert.ok(lines.length > 0);
	for (const line of lines) { assert.ok(!line.includes(ID)); assert.ok(!line.includes(IMG)); }
});
