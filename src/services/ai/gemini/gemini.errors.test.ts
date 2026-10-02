import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError, extractRetryAfterMs, normalizeGeminiError } from './gemini.errors';

// AI Cleanup Batch 4 — classification table for normalizeGeminiError. Pure
// unit tests; no SDK, no network.

const withStatus = (status: number, message = 'x') => Object.assign(new Error(message), { status });

const cases: Array<[string, unknown, GeminiErrorCode, string, boolean]> = [
  ['AbortError', Object.assign(new Error('a'), { name: 'AbortError' }), GeminiErrorCode.TIMEOUT, 'TIMEOUT', false],
  ['401', withStatus(401), GeminiErrorCode.AUTHENTICATION_ERROR, 'AUTHENTICATION', false],
  ['403', withStatus(403), GeminiErrorCode.AUTHENTICATION_ERROR, 'AUTHENTICATION', false],
  ['400 API_KEY_INVALID', withStatus(400, '{"error":{"details":[{"reason":"API_KEY_INVALID"}]}}'), GeminiErrorCode.AUTHENTICATION_ERROR, 'AUTHENTICATION', false],
  ['429', withStatus(429), GeminiErrorCode.RATE_LIMITED, 'RATE_LIMITED', false],
  ['502', withStatus(502), GeminiErrorCode.PROVIDER_UNAVAILABLE, 'UPSTREAM_UNAVAILABLE', true],
  ['503', withStatus(503), GeminiErrorCode.PROVIDER_UNAVAILABLE, 'UPSTREAM_UNAVAILABLE', true],
  ['500', withStatus(500), GeminiErrorCode.PROVIDER_UNAVAILABLE, 'UPSTREAM_ERROR', false],
  ['504', withStatus(504), GeminiErrorCode.PROVIDER_UNAVAILABLE, 'UPSTREAM_ERROR', false],
  ['400 generic', withStatus(400), GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'INVALID_REQUEST', false],
  ['404 (e.g. unknown model)', withStatus(404), GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'INVALID_REQUEST', false],
  ['ECONNRESET', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), GeminiErrorCode.PROVIDER_UNAVAILABLE, 'NETWORK', true],
  ['UND_ERR_SOCKET', Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }), GeminiErrorCode.PROVIDER_UNAVAILABLE, 'NETWORK', true],
  ['ENOTFOUND', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'UNKNOWN', false],
  ['plain Error', new Error('odd'), GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'UNKNOWN', false],
  ['non-object', 'string thrown', GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'UNKNOWN', false],
];

for (const [label, input, code, detail, retryable] of cases) {
  test(`normalizeGeminiError: ${label} → ${code}/${detail} (retryable=${retryable})`, () => {
    const err = normalizeGeminiError(input);
    assert.ok(err instanceof GeminiProviderError);
    assert.equal(err.code, code);
    assert.equal(err.detail, detail);
    assert.equal(err.retryable, retryable);
  });
}

test('normalizeGeminiError: an existing GeminiProviderError passes through unchanged', () => {
  const original = new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'm', undefined, { detail: 'TRUNCATED' });
  assert.equal(normalizeGeminiError(original), original);
});

test('GeminiProviderError: backward-compatible 3-arg constructor still works with safe defaults', () => {
  const err = new GeminiProviderError(GeminiErrorCode.RATE_LIMITED, 'm', { status: 429 });
  assert.equal(err.detail, 'RATE_LIMITED');
  assert.equal(err.retryable, false);
});

test('normalizeGeminiError: never copies raw upstream text (which may echo request details) into .message', () => {
  const raw = '{"error":{"message":"API key not valid AIzaSy-SECRET-should-not-leak"}}';
  for (const status of [400, 401, 429, 500, 503]) {
    const err = normalizeGeminiError(withStatus(status, raw));
    assert.equal(err.message.includes('AIzaSy'), false);
    assert.equal(err.message.includes('API key not valid'), false);
  }
});

test('extractRetryAfterMs: parses google.rpc.RetryInfo retryDelay, ignores anything else', () => {
  assert.equal(extractRetryAfterMs(withStatus(503, '{"retryDelay": "12s"}')), 12_000);
  assert.equal(extractRetryAfterMs(withStatus(503, '{"retryDelay":"0.5s"}')), 500);
  assert.equal(extractRetryAfterMs(withStatus(503, 'no hint')), undefined);
  assert.equal(extractRetryAfterMs(undefined), undefined);
  assert.equal(normalizeGeminiError(withStatus(503, '{"retryDelay":"3s"}')).retryAfterMs, 3_000);
});
