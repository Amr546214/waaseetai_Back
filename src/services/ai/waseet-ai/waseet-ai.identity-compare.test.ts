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
const okData = (over: any = {}) => ({ requestId: 'r-1', fields: { fullName: { status: 'MATCH' }, birthDate: { status: 'MISMATCH', reason: 'DIGIT_DIFF' }, nationalId: { status: 'COULD_NOT_VERIFY', reason: 'LOW_CONFIDENCE' } }, model: { name: 'm', version: '1' }, readAt: new Date().toISOString(), ...over });
const mk = (status: number, payload: unknown, calls: any[] = []): FetchLike => async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }); };

test('sends the contract request with the standard headers and returns the validated response', async () => {
	const calls: any[] = [];
	const res = await new WaseetAiClient(mk(200, { success: true, data: okData() }, calls), cfg).compareIdentityFields(body);
	assert.equal(calls[0].url, 'https://ai.example.test/v1/ai/identity/compare-fields');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers['X-Request-Id'], 'r-1');
	assert.equal(calls[0].init.headers['X-Client-Id'], 'waseet_core_backend');
	assert.match(calls[0].init.headers.Authorization, /^Bearer /);
	assert.equal(JSON.parse(calls[0].init.body).registered.nationalId, ID);
	assert.equal(res.fields.birthDate.status, 'MISMATCH');
});

test('garbage / partial / wrong-requestId / bad-status / free-text-reason responses are INVALID_RESPONSE (never guessed)', async () => {
	const bad = [
		{ success: true, data: { nonsense: 1 } }, { success: true, data: okData({ fields: { fullName: { status: 'MATCH' } } }) },
		{ success: true, data: okData({ requestId: 'other' }) },
		{ success: true, data: okData({ fields: { ...okData().fields, fullName: { status: 'YES' } } }) },
		{ success: true, data: okData({ fields: { ...okData().fields, fullName: { status: 'MATCH', reason: 'raw text read: ' + ID } } }) },
		{ success: true, data: okData({ model: {} }) }, { success: false }, 'not-json-envelope'
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
		await new WaseetAiClient(mk(200, { success: true, data: okData() }), cfg).compareIdentityFields(body);
		await new WaseetAiClient(mk(500, {}), cfg).compareIdentityFields(body).catch(() => undefined);
		await new WaseetAiClient(mk(200, { success: true, data: { x: 1 } }), cfg).compareIdentityFields(body).catch(() => undefined);
	} finally { for (const [l, f] of orig) (logger as any)[l] = f; }
	assert.ok(lines.length > 0);
	for (const line of lines) { assert.ok(!line.includes(ID)); assert.ok(!line.includes(IMG)); }
});
