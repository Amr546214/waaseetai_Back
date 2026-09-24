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
