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
