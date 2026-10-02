import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The @google/genai SDK is mocked exactly ONCE at module-load time (not per
// test). Node's CJS module cache means re-mocking the same specifier from
// inside multiple individual tests silently falls back to the real,
// already-loaded module on the second and later calls — so instead we
// register a single mock class here whose behavior is redirected through a
// mutable holder that each test overwrites before use. No real network call
// to Google's API is ever made by these tests.
//
// The GeminiClient module itself is still imported fresh (cache-busted) per
// test, so the client's internal singleton state (its cached SDK instance)
// never leaks between tests — same pattern as project-amendment.service.test.ts.

type MockModelsBehavior = {
  generateContent?: (...args: any[]) => Promise<any>;
  generateContentStream?: (...args: any[]) => Promise<AsyncIterable<any>>;
};

const behaviorHolder: { current: MockModelsBehavior } = { current: {} };

class MockGoogleGenAI {
  models = {
    generateContent: (...args: any[]) =>
      (behaviorHolder.current.generateContent ?? (async () => { throw new Error('generateContent not stubbed for this test'); }))(...args),
    generateContentStream: (...args: any[]) =>
      (behaviorHolder.current.generateContentStream ?? (async () => { throw new Error('generateContentStream not stubbed for this test'); }))(...args),
  };
}

mock.module('@google/genai', { namedExports: { GoogleGenAI: MockGoogleGenAI } });

// `apiKey` has no default value on purpose: a JS default parameter also
// fires when the caller passes an explicit `undefined`, which would make
// `loadClient(behavior, undefined)` silently keep the key instead of
// deleting it. Every call site must pass the argument explicitly.
async function loadClient(behavior: MockModelsBehavior, apiKey: string | undefined) {
  behaviorHolder.current = behavior;
  const originalApiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = apiKey;

  const moduleUrl = `./gemini.client.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);

  return {
    geminiClient: mod.geminiClient as import('./gemini.client').GeminiClient,
    restoreEnv: () => {
      if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalApiKey;
    },
  };
}

function usageMetadataFixture() {
  return { promptTokenCount: 12, candidatesTokenCount: 34, totalTokenCount: 46 };
}

// ── NOT_CONFIGURED ───────────────────────────────────────────────────────

test('generateText: rejects with NOT_CONFIGURED when GEMINI_API_KEY is missing, without calling the SDK', async () => {
  const { geminiClient, restoreEnv } = await loadClient({}, undefined);
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    assert.equal(geminiClient.isConfigured(), false);
    await assert.rejects(
      () => geminiClient.generateText('hello'),
      (err: any) => {
        assert.equal(err.name, 'GeminiProviderError');
        assert.equal(err.code, GeminiErrorCode.NOT_CONFIGURED);
        return true;
      }
    );
  } finally {
    restoreEnv();
  }
});

// ── successful text response ────────────────────────────────────────────

test('generateText: returns text + normalized usage on success', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: 'Hello from Gemini', usageMetadata: usageMetadataFixture() }),
  }, 'test-key');
  try {
    assert.equal(geminiClient.isConfigured(), true);
    const result = await geminiClient.generateText('say hello');
    assert.equal(result.text, 'Hello from Gemini');
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 34, totalTokens: 46 });
  } finally {
    restoreEnv();
  }
});

// ── successful structured JSON response ─────────────────────────────────

test('generateStructured: parses valid JSON and runs caller validation', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: '{"score": 91, "label": "GOOD"}', usageMetadata: usageMetadataFixture() }),
  }, 'test-key');
  try {
    const result = await geminiClient.generateStructured<{ score: number; label: string }>('evaluate', {
      responseSchema: { type: 'object', properties: { score: { type: 'number' }, label: { type: 'string' } } },
      validate: (value: any) => typeof value?.score === 'number' && typeof value?.label === 'string',
    });
    assert.deepEqual(result.data, { score: 91, label: 'GOOD' });
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 34, totalTokens: 46 });
  } finally {
    restoreEnv();
  }
});

test('generateStructured: rejects with INVALID_RESPONSE when caller validation fails', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: '{"unexpected": true}', usageMetadata: usageMetadataFixture() }),
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateStructured('evaluate', {
        responseSchema: { type: 'object' },
        validate: (value: any) => typeof value?.score === 'number',
      }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE); return true; }
    );
  } finally {
    restoreEnv();
  }
});

// ── malformed structured response ───────────────────────────────────────

test('generateStructured: rejects with INVALID_RESPONSE on malformed JSON text', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: 'not valid json {{{', usageMetadata: usageMetadataFixture() }),
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateStructured('evaluate', { responseSchema: { type: 'object' } }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE); return true; }
    );
  } finally {
    restoreEnv();
  }
});

// ── empty response ───────────────────────────────────────────────────────

test('generateText: rejects with INVALID_RESPONSE when Gemini returns empty text', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: '', usageMetadata: usageMetadataFixture() }),
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateText('say hello'),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateStructured: rejects with INVALID_RESPONSE when Gemini returns empty text', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: '   ', usageMetadata: usageMetadataFixture() }),
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateStructured('evaluate', { responseSchema: { type: 'object' } }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE); return true; }
    );
  } finally {
    restoreEnv();
  }
});

// ── normalized provider errors ──────────────────────────────────────────

test('generateText: normalizes a 429 SDK error to RATE_LIMITED without leaking the raw provider message', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => { const e: any = new Error('Too many requests'); e.status = 429; throw e; },
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateText('hello'),
      (err: any) => {
        assert.equal(err.code, GeminiErrorCode.RATE_LIMITED);
        assert.equal(err.message.includes('Too many requests'), false, 'must not leak raw provider message');
        assert.ok(err.cause, 'original cause must be preserved internally');
        return true;
      }
    );
  } finally {
    restoreEnv();
  }
});

test('generateText: normalizes a 401 SDK error to AUTHENTICATION_ERROR', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => { const e: any = new Error('bad key'); e.status = 401; throw e; },
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateText('hello'),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.AUTHENTICATION_ERROR); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateText: normalizes a 503 SDK error to PROVIDER_UNAVAILABLE', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => { const e: any = new Error('overloaded'); e.status = 503; throw e; },
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateText('hello'),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.PROVIDER_UNAVAILABLE); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateText: normalizes an unrecognized SDK error to UNKNOWN_PROVIDER_ERROR', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => { throw new Error('something odd'); },
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateText('hello'),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.UNKNOWN_PROVIDER_ERROR); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateText: normalizes an AbortError (timeout) to TIMEOUT', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; },
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateText('hello'),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.TIMEOUT); return true; }
    );
  } finally {
    restoreEnv();
  }
});

// ── streaming ────────────────────────────────────────────────────────────

test('generateStream: yields chunks in order and returns final usage', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContentStream: async () => ({
      async *[Symbol.asyncIterator]() {
        yield { text: 'Hel' };
        yield { text: 'lo ' };
        yield { text: 'world', usageMetadata: usageMetadataFixture() };
      },
    }),
  }, 'test-key');
  try {
    const stream = geminiClient.generateStream('say hello');
    const chunks: string[] = [];
    let result = await stream.next();
    while (!result.done) {
      chunks.push(result.value);
      result = await stream.next();
    }
    assert.deepEqual(chunks, ['Hel', 'lo ', 'world']);
    assert.deepEqual(result.value, { promptTokens: 12, completionTokens: 34, totalTokens: 46 });
  } finally {
    restoreEnv();
  }
});

test('generateStream: propagates a normalized error when the stream fails mid-iteration', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContentStream: async () => ({
      async *[Symbol.asyncIterator]() {
        yield { text: 'partial ' };
        const e: any = new Error('stream died');
        e.status = 500;
        throw e;
      },
    }),
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  const chunks: string[] = [];
  try {
    const stream = geminiClient.generateStream('say hello');
    await assert.rejects(
      async () => {
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
      },
      (err: any) => { assert.equal(err.code, GeminiErrorCode.PROVIDER_UNAVAILABLE); return true; }
    );
    assert.deepEqual(chunks, ['partial ']);
  } finally {
    restoreEnv();
  }
});

test('generateStream: rejects with NOT_CONFIGURED before making any SDK call when GEMINI_API_KEY is missing', async () => {
  const { geminiClient, restoreEnv } = await loadClient({}, undefined);
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    const stream = geminiClient.generateStream('hello');
    await assert.rejects(
      () => stream.next(),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.NOT_CONFIGURED); return true; }
    );
  } finally {
    restoreEnv();
  }
});

// ── generateStructuredWithImage (Vision) ────────────────────────────────

test('generateStructuredWithImage: a successful call sends the text prompt and correctly base64-encoded image parts to the SDK layer', async () => {
  let capturedArgs: any;
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async (args: any) => {
      capturedArgs = args;
      return { text: '{"score": 88}', usageMetadata: usageMetadataFixture() };
    }
  }, 'test-key');
  try {
    const imageBytes = Buffer.from('fake-png-bytes');
    const result = await geminiClient.generateStructuredWithImage<{ score: number }>('evaluate this image', {
      responseSchema: { type: 'object', properties: { score: { type: 'number' } } },
      images: [{ mimeType: 'image/png', data: imageBytes }]
    });

    assert.deepEqual(result.data, { score: 88 });
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 34, totalTokens: 46 });

    assert.deepEqual(capturedArgs.contents, [
      { text: 'evaluate this image' },
      { inlineData: { mimeType: 'image/png', data: imageBytes.toString('base64') } }
    ]);
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: attaches multiple images in order, each independently base64-encoded', async () => {
  let capturedArgs: any;
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async (args: any) => {
      capturedArgs = args;
      return { text: '{"score": 90}', usageMetadata: usageMetadataFixture() };
    }
  }, 'test-key');
  try {
    const imageA = Buffer.from('image-a-bytes');
    const imageB = Buffer.from('image-b-bytes');
    await geminiClient.generateStructuredWithImage('evaluate', {
      responseSchema: { type: 'object' },
      images: [
        { mimeType: 'image/png', data: imageA },
        { mimeType: 'image/jpeg', data: imageB }
      ]
    });

    assert.deepEqual(capturedArgs.contents, [
      { text: 'evaluate' },
      { inlineData: { mimeType: 'image/png', data: imageA.toString('base64') } },
      { inlineData: { mimeType: 'image/jpeg', data: imageB.toString('base64') } }
    ]);
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: rejects with a normalized error (no images provided) without calling the SDK', async () => {
  let called = false;
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => { called = true; return { text: '{}' }; }
  }, 'test-key');
  try {
    await assert.rejects(
      () => geminiClient.generateStructuredWithImage('evaluate', { responseSchema: { type: 'object' }, images: [] }),
      (err: any) => { assert.equal(err.name, 'GeminiProviderError'); return true; }
    );
    assert.equal(called, false);
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: rejects with NOT_CONFIGURED when GEMINI_API_KEY is missing', async () => {
  const { geminiClient, restoreEnv } = await loadClient({}, undefined);
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateStructuredWithImage('evaluate', {
        responseSchema: { type: 'object' },
        images: [{ mimeType: 'image/png', data: Buffer.from('x') }]
      }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.NOT_CONFIGURED); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: a malformed JSON response is rejected as INVALID_RESPONSE', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: 'not valid json {{{', usageMetadata: usageMetadataFixture() })
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateStructuredWithImage('evaluate', {
        responseSchema: { type: 'object' },
        images: [{ mimeType: 'image/png', data: Buffer.from('x') }]
      }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: caller validation rejecting the parsed response surfaces as INVALID_RESPONSE', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: '{"score": -5}', usageMetadata: usageMetadataFixture() })
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateStructuredWithImage('evaluate', {
        responseSchema: { type: 'object' },
        validate: (value: any) => typeof value?.score === 'number' && value.score >= 0,
        images: [{ mimeType: 'image/png', data: Buffer.from('x') }]
      }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: normalizes a 503 SDK error to PROVIDER_UNAVAILABLE (provider unavailable)', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => { const e: any = new Error('overloaded'); e.status = 503; throw e; }
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateStructuredWithImage('evaluate', {
        responseSchema: { type: 'object' },
        images: [{ mimeType: 'image/png', data: Buffer.from('x') }]
      }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.PROVIDER_UNAVAILABLE); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: an AbortError (timeout) is normalized to TIMEOUT', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; }
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateStructuredWithImage('evaluate', {
        responseSchema: { type: 'object' },
        images: [{ mimeType: 'image/png', data: Buffer.from('x') }]
      }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.TIMEOUT); return true; }
    );
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: an externally aborted signal propagates as TIMEOUT', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async (_args: any, _config?: any) => {
      // Simulate the SDK honoring the abort signal mid-call.
      const e: any = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
  }, 'test-key');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => geminiClient.generateStructuredWithImage('evaluate', {
        responseSchema: { type: 'object' },
        images: [{ mimeType: 'image/png', data: Buffer.from('x') }],
        signal: controller.signal
      }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.TIMEOUT); return true; }
    );
  } finally {
    restoreEnv();
  }
});

// ── multi-key pool integration (GeminiClient delegates to GeminiKeyPool) ──
// The pool's own unit behavior (round-robin order, cooldown, bounded retry,
// parsing) is covered exhaustively in gemini-key-pool.test.ts. These tests
// only prove GeminiClient actually wires real calls through the pool.

async function loadClientMultiKey(behavior: MockModelsBehavior, apiKeysCsv: string | undefined) {
  behaviorHolder.current = behavior;
  const originalApiKeys = process.env.GEMINI_API_KEYS;
  const originalApiKey = process.env.GEMINI_API_KEY;
  if (apiKeysCsv === undefined) delete process.env.GEMINI_API_KEYS; else process.env.GEMINI_API_KEYS = apiKeysCsv;
  delete process.env.GEMINI_API_KEY;

  const moduleUrl = `./gemini.client.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);

  return {
    geminiClient: mod.geminiClient as import('./gemini.client').GeminiClient,
    restoreEnv: () => {
      if (originalApiKeys === undefined) delete process.env.GEMINI_API_KEYS; else process.env.GEMINI_API_KEYS = originalApiKeys;
      if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalApiKey;
    },
  };
}

test('GEMINI_API_KEYS: generateText succeeds via GeminiClient when multiple keys are configured', async () => {
  const { geminiClient, restoreEnv } = await loadClientMultiKey({
    generateContent: async () => ({ text: 'multi-key response', usageMetadata: usageMetadataFixture() }),
  }, 'key1,key2,key3');
  try {
    assert.equal(geminiClient.isConfigured(), true);
    const result = await geminiClient.generateText('hello');
    assert.equal(result.text, 'multi-key response');
  } finally {
    restoreEnv();
  }
});

test('GEMINI_API_KEYS: a rate-limited attempt fails over to another key transparently, generateText still succeeds', async () => {
  let callCount = 0;
  const { geminiClient, restoreEnv } = await loadClientMultiKey({
    generateContent: async () => {
      callCount++;
      if (callCount === 1) { const e: any = new Error('quota exceeded'); e.status = 429; throw e; }
      return { text: 'recovered after failover', usageMetadata: usageMetadataFixture() };
    },
  }, 'key1,key2');
  try {
    const result = await geminiClient.generateText('hello');
    assert.equal(result.text, 'recovered after failover');
    assert.equal(callCount, 2, 'exactly one retry should have happened, transparent to the caller');
  } finally {
    restoreEnv();
  }
});

test('GEMINI_API_KEYS: a non-quota error still surfaces as before, without any hidden retry', async () => {
  let callCount = 0;
  const { geminiClient, restoreEnv } = await loadClientMultiKey({
    generateContent: async () => { callCount++; const e: any = new Error('bad key'); e.status = 401; throw e; },
  }, 'key1,key2');
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  try {
    await assert.rejects(
      () => geminiClient.generateText('hello'),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.AUTHENTICATION_ERROR); return true; }
    );
    assert.equal(callCount, 1);
  } finally {
    restoreEnv();
  }
});

test('generateStructuredWithImage: real usage metadata is extracted and returned unmodified', async () => {
  const { geminiClient, restoreEnv } = await loadClient({
    generateContent: async () => ({ text: '{"score": 77}', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } })
  }, 'test-key');
  try {
    const result = await geminiClient.generateStructuredWithImage('evaluate', {
      responseSchema: { type: 'object' },
      images: [{ mimeType: 'image/jpeg', data: Buffer.from('x') }]
    });
    assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  } finally {
    restoreEnv();
  }
});

// ═════════════════════════════════════════════════════════════════════════
// AI Cleanup Batch 4 — Gemini reliability: bounded transient retry,
// truncation/finishReason detection, failure-detail classification.
// All SDK calls are mocked; no real Gemini request is ever made.
// ═════════════════════════════════════════════════════════════════════════

// Fresh GeminiClient instance with a FAST retry policy (tiny fixed backoff,
// no minimum-window gate) so retry behavior can be asserted deterministically
// without slow sleeps. Production defaults are asserted separately below.
async function loadFastRetryClient(
  behavior: MockModelsBehavior,
  opts: { apiKey?: string; apiKeysCsv?: string; retryPolicy?: Record<string, unknown> } = {}
) {
  behaviorHolder.current = behavior;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalApiKeys = process.env.GEMINI_API_KEYS;
  if (opts.apiKeysCsv !== undefined) { process.env.GEMINI_API_KEYS = opts.apiKeysCsv; delete process.env.GEMINI_API_KEY; }
  else { delete process.env.GEMINI_API_KEYS; process.env.GEMINI_API_KEY = opts.apiKey ?? 'test-key'; }

  const mod = await import(`./gemini.client.ts?fixture=${Date.now()}-${Math.random()}`);
  const { GeminiErrorCode } = await import('./gemini.errors.ts');
  const client = new mod.GeminiClient({ retryPolicy: { backoffMs: [5, 5], minAttemptWindowMs: 0, ...opts.retryPolicy } }) as import('./gemini.client').GeminiClient;
  return {
    client,
    mod,
    GeminiErrorCode,
    restoreEnv: () => {
      if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalApiKey;
      if (originalApiKeys === undefined) delete process.env.GEMINI_API_KEYS; else process.env.GEMINI_API_KEYS = originalApiKeys;
    },
  };
}

const httpError = (status: number, message = 'upstream error body') => Object.assign(new Error(message), { status });
const structuredOpts = { responseSchema: { type: 'object' }, validate: (v: any) => typeof v?.score === 'number' };

test('retry policy: production defaults are small and bounded (3 attempts, fixed sub-2s backoff)', async () => {
  const mod = await import(`./gemini.client.ts?fixture=${Date.now()}-${Math.random()}`);
  const p = mod.DEFAULT_GEMINI_RETRY_POLICY;
  assert.equal(p.maxAttempts, 3);
  assert.deepEqual(p.backoffMs, [750, 1500]);
  assert.ok(p.minAttemptWindowMs > 0);
  assert.ok(p.maxRetryAfterMs <= 5_000);
});

test('retry: success on the first attempt makes exactly one SDK call', async () => {
  let calls = 0;
  const { client, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; return { text: '{"score": 1}', candidates: [{ finishReason: 'STOP' }] }; },
  });
  try {
    const result = await client.generateStructured('x', structuredOpts);
    assert.deepEqual(result.data, { score: 1 });
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

for (const status of [503, 502]) {
  test(`retry: HTTP ${status} then success is retried once and returns the real result`, async () => {
    let calls = 0;
    const { client, restoreEnv } = await loadFastRetryClient({
      generateContent: async () => { calls++; if (calls === 1) throw httpError(status); return { text: '{"score": 42}' }; },
    });
    try {
      const result = await client.generateStructured('x', structuredOpts);
      assert.deepEqual(result.data, { score: 42 });
      assert.equal(calls, 2);
    } finally { restoreEnv(); }
  });
}

test('retry: repeated 503 exhausts after exactly maxAttempts and throws the honest PROVIDER_UNAVAILABLE — no fabricated data', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; throw httpError(503, '{"error":{"code":503,"message":"The model is overloaded"}}'); },
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => {
      assert.equal(err.name, 'GeminiProviderError');
      assert.equal(err.code, GeminiErrorCode.PROVIDER_UNAVAILABLE);
      assert.equal(err.detail, 'UPSTREAM_UNAVAILABLE');
      assert.equal(err.httpStatus, 503);
      assert.equal('data' in err, false, 'an error, never a result-shaped object');
      assert.equal(err.message.includes('overloaded'), false, 'raw upstream body never reaches the message');
      return true;
    });
    assert.equal(calls, 3, 'bounded: exactly maxAttempts, never more');
  } finally { restoreEnv(); }
});

test('retry: a transient network failure (fetch failed / ECONNRESET) then success is retried', async () => {
  let calls = 0;
  const { client, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return { text: 'recovered' };
    },
  });
  try {
    const result = await client.generateText('x');
    assert.equal(result.text, 'recovered');
    assert.equal(calls, 2);
  } finally { restoreEnv(); }
});

test('retry: a persistent network/config failure (ENOTFOUND) is NOT retried', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); },
  });
  try {
    await assert.rejects(() => client.generateText('x'), (err: any) => { assert.equal(err.code, GeminiErrorCode.UNKNOWN_PROVIDER_ERROR); return true; });
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

test('retry: a timeout (AbortError) is NOT retried — the operation budget is already spent', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => { assert.equal(err.code, GeminiErrorCode.TIMEOUT); return true; });
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

for (const status of [400, 404, 422]) {
  test(`retry: a permanent HTTP ${status} is NOT retried`, async () => {
    let calls = 0;
    const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
      generateContent: async () => { calls++; throw httpError(status); },
    });
    try {
      await assert.rejects(() => client.generateText('x'), (err: any) => {
        assert.equal(err.code, GeminiErrorCode.UNKNOWN_PROVIDER_ERROR);
        assert.equal(err.detail, 'INVALID_REQUEST');
        return true;
      });
      assert.equal(calls, 1);
    } finally { restoreEnv(); }
  });
}

for (const status of [500, 504]) {
  test(`retry: HTTP ${status} is classified PROVIDER_UNAVAILABLE but NOT retried (often request-caused per Google docs)`, async () => {
    let calls = 0;
    const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
      generateContent: async () => { calls++; throw httpError(status); },
    });
    try {
      await assert.rejects(() => client.generateText('x'), (err: any) => {
        assert.equal(err.code, GeminiErrorCode.PROVIDER_UNAVAILABLE);
        assert.equal(err.detail, 'UPSTREAM_ERROR');
        return true;
      });
      assert.equal(calls, 1);
    } finally { restoreEnv(); }
  });
}

for (const [label, makeErr] of [
  ['401', () => httpError(401)],
  ['403', () => httpError(403)],
  ['400 API_KEY_INVALID', () => httpError(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}')],
] as const) {
  test(`retry: an auth/config failure (${label}) is NOT retried, on single and multi-key pools`, async () => {
    for (const keys of [{ apiKey: 'k1' }, { apiKeysCsv: 'k1,k2,k3' }]) {
      let calls = 0;
      const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
        generateContent: async () => { calls++; throw makeErr(); },
      }, keys);
      try {
        await assert.rejects(() => client.generateText('x'), (err: any) => {
          assert.equal(err.code, GeminiErrorCode.AUTHENTICATION_ERROR);
          assert.equal(err.message.includes('API key not valid'), false);
          return true;
        });
        assert.equal(calls, 1);
      } finally { restoreEnv(); }
    }
  });
}

test('429 (preserved): single key → RATE_LIMITED after one call; the transient-retry loop never re-runs it', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; throw httpError(429); },
  });
  try {
    await assert.rejects(() => client.generateText('x'), (err: any) => { assert.equal(err.code, GeminiErrorCode.RATE_LIMITED); return true; });
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

test('429 (preserved): multi-key failover still rotates exactly once per key, then fails honestly', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; throw httpError(429); },
  }, { apiKeysCsv: 'k1,k2,k3' });
  try {
    await assert.rejects(() => client.generateText('x'), (err: any) => { assert.equal(err.code, GeminiErrorCode.RATE_LIMITED); return true; });
    assert.equal(calls, 3, 'one attempt per key, no extra transient retries on top');
  } finally { restoreEnv(); }
});

test('retry budget: no retry is started when the remaining timeout cannot fit backoff + a real attempt', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; throw httpError(503); },
  }, { retryPolicy: { backoffMs: [750, 1500], minAttemptWindowMs: 2_000 } });
  try {
    await assert.rejects(() => client.generateText('x', { timeoutMs: 1_000 }), (err: any) => { assert.equal(err.code, GeminiErrorCode.PROVIDER_UNAVAILABLE); return true; });
    assert.equal(calls, 1, 'the caller-visible timeout still bounds the whole operation');
  } finally { restoreEnv(); }
});

test('retry budget: a server retryDelay hint longer than maxRetryAfterMs is honored by NOT retrying (no invented shorter wait)', async () => {
  let calls = 0;
  const { client, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; throw httpError(503, '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}'); },
  });
  try {
    await assert.rejects(() => client.generateText('x'));
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

test('retry budget: a short server retryDelay hint is used as the backoff', async () => {
  let calls = 0;
  const started = Date.now();
  const { client, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; if (calls === 1) throw httpError(503, '{"retryDelay":"0.2s"}'); return { text: 'ok' }; },
  });
  try {
    const result = await client.generateText('x');
    assert.equal(result.text, 'ok');
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 180, 'waited for the provider-supplied delay, not the 5ms test backoff');
  } finally { restoreEnv(); }
});

test('retry: caller cancellation during backoff stops immediately as TIMEOUT, no further attempt', async () => {
  let calls = 0;
  const controller = new AbortController();
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; setTimeout(() => controller.abort(), 10); throw httpError(503); },
  }, { retryPolicy: { backoffMs: [500, 500] } });
  try {
    await assert.rejects(() => client.generateText('x', { signal: controller.signal }), (err: any) => { assert.equal(err.code, GeminiErrorCode.TIMEOUT); return true; });
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

test('retry: generateStructuredWithImage retries 503 then succeeds with the real result', async () => {
  let calls = 0;
  const { client, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; if (calls === 1) throw httpError(503); return { text: '{"score": 7}' }; },
  });
  try {
    const result = await client.generateStructuredWithImage('x', { ...structuredOpts, images: [{ mimeType: 'image/png', data: Buffer.from('x') }] });
    assert.deepEqual(result.data, { score: 7 });
    assert.equal(calls, 2);
  } finally { restoreEnv(); }
});

test('retry: generateStream retries 503 on stream ESTABLISHMENT only, then streams the real chunks', async () => {
  let calls = 0;
  const { client, restoreEnv } = await loadFastRetryClient({
    generateContentStream: async () => {
      calls++;
      if (calls === 1) throw httpError(503);
      return (async function* () { yield { text: 'a' }; yield { text: 'b' }; })();
    },
  });
  try {
    const chunks: string[] = [];
    for await (const c of client.generateStream('x')) chunks.push(c);
    assert.deepEqual(chunks, ['a', 'b']);
    assert.equal(calls, 2);
  } finally { restoreEnv(); }
});

test('retry: a mid-stream 503 (after chunks were yielded) is NEVER retried', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContentStream: async () => {
      calls++;
      return (async function* () { yield { text: 'partial' }; throw httpError(503); })();
    },
  });
  try {
    const chunks: string[] = [];
    await assert.rejects(async () => { for await (const c of client.generateStream('x')) chunks.push(c); },
      (err: any) => { assert.equal(err.code, GeminiErrorCode.PROVIDER_UNAVAILABLE); return true; });
    assert.deepEqual(chunks, ['partial']);
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

// ── structured JSON robustness ───────────────────────────────────────────

test('structured: valid JSON with finishReason STOP parses correctly', async () => {
  const { client, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => ({ text: '{"score": 88}', candidates: [{ finishReason: 'STOP' }] }),
  });
  try {
    assert.deepEqual((await client.generateStructured('x', structuredOpts)).data, { score: 88 });
  } finally { restoreEnv(); }
});

test('structured: truncated JSON (finishReason MAX_TOKENS) is rejected explicitly as TRUNCATED and NOT retried', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => {
      calls++;
      return { text: '{"score": 88, "bullets": ["المرحلة', candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { thoughtsTokenCount: 470, candidatesTokenCount: 30 } };
    },
  });
  try {
    await assert.rejects(() => client.generateStructured('x', { ...structuredOpts, maxOutputTokens: 500 }), (err: any) => {
      assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE);
      assert.equal(err.detail, 'TRUNCATED');
      assert.equal(err.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

test('structured: MAX_TOKENS is rejected even if the cut-off text happens to parse — a partial object is never accepted', async () => {
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => ({ text: '{"score": 1}', candidates: [{ finishReason: 'MAX_TOKENS' }] }),
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => {
      assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE);
      assert.equal(err.detail, 'TRUNCATED');
      return true;
    });
  } finally { restoreEnv(); }
});

test('structured: truncated JSON WITHOUT a finishReason is still caught as MALFORMED_JSON, never a partial object', async () => {
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => ({ text: '{"score": 88, "label": "GO' }),
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => {
      assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE);
      assert.equal(err.detail, 'MALFORMED_JSON');
      return true;
    });
  } finally { restoreEnv(); }
});

test('structured: a safety/other early stop (finishReason SAFETY) is rejected as INCOMPLETE', async () => {
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => ({ text: '', candidates: [{ finishReason: 'SAFETY' }] }),
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => {
      assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE);
      assert.equal(err.detail, 'INCOMPLETE');
      assert.match(err.message, /finishReason=SAFETY/);
      return true;
    });
  } finally { restoreEnv(); }
});

test('structured: malformed JSON is INVALID_RESPONSE/MALFORMED_JSON and NOT retried', async () => {
  let calls = 0;
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => { calls++; return { text: 'not json {{{', candidates: [{ finishReason: 'STOP' }] }; },
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => {
      assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE);
      assert.equal(err.detail, 'MALFORMED_JSON');
      return true;
    });
    assert.equal(calls, 1);
  } finally { restoreEnv(); }
});

test('structured: markdown-fenced JSON is NOT silently stripped (responseSchema mode never fences) — rejected honestly', async () => {
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => ({ text: '```json\n{"score": 5}\n```' }),
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => {
      assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE);
      assert.equal(err.detail, 'MALFORMED_JSON');
      return true;
    });
  } finally { restoreEnv(); }
});

test('structured: empty response is INVALID_RESPONSE/EMPTY_RESPONSE', async () => {
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => ({ text: '   ', candidates: [{ finishReason: 'STOP' }] }),
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => {
      assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE);
      assert.equal(err.detail, 'EMPTY_RESPONSE');
      return true;
    });
  } finally { restoreEnv(); }
});

test('structured: schema-invalid (valid JSON, wrong shape) is INVALID_RESPONSE/SCHEMA_INVALID — no fields are invented', async () => {
  const { client, GeminiErrorCode, restoreEnv } = await loadFastRetryClient({
    generateContent: async () => ({ text: '{"label": "no score here"}', candidates: [{ finishReason: 'STOP' }] }),
  });
  try {
    await assert.rejects(() => client.generateStructured('x', structuredOpts), (err: any) => {
      assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE);
      assert.equal(err.detail, 'SCHEMA_INVALID');
      return true;
    });
  } finally { restoreEnv(); }
});

test('structured: the configured maxOutputTokens is passed through to the SDK unchanged', async () => {
  let seen: any;
  const { client, restoreEnv } = await loadFastRetryClient({
    generateContent: async (req: any) => { seen = req.config.maxOutputTokens; return { text: '{"score": 1}' }; },
  });
  try {
    await client.generateStructured('x', { ...structuredOpts, maxOutputTokens: 1500 });
    assert.equal(seen, 1500);
  } finally { restoreEnv(); }
});
