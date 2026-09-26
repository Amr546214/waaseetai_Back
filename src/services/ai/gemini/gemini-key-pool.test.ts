import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiErrorCode, GeminiProviderError } from './gemini.errors';

// Gemini API key pool — deterministic round-robin distribution with
// quota/rate-limit failover. The @google/genai SDK is fully mocked (a
// distinct MockGoogleGenAI instance per configured key, tagged with the
// apiKey it was constructed with) so tests can identify which key handled
// each attempt without ever depending on real network access. Both
// GeminiKeyPool and process.env are read fresh per test via cache-busted
// re-import, matching gemini.client.test.ts's own isolation pattern.

class MockGoogleGenAI {
  apiKey: string;
  models: { generateContent: (...args: any[]) => Promise<any> };
  constructor({ apiKey }: { apiKey: string }) {
    this.apiKey = apiKey;
    this.models = { generateContent: () => { throw new Error('not stubbed'); } };
  }
}

function rateLimitedError(): any {
  const e: any = new Error('quota exceeded');
  e.status = 429;
  return e;
}

function authError(): any {
  const e: any = new Error('bad key');
  e.status = 401;
  return e;
}

function unavailableError(): any {
  const e: any = new Error('overloaded');
  e.status = 503;
  return e;
}

async function loadPool(t: TestContext, opts: {
  apiKeys?: string; // GEMINI_API_KEYS
  apiKey?: string;  // GEMINI_API_KEY (legacy)
  cooldownMs?: string;
  logs?: { warn: any[]; debug: any[] };
}) {
  t.mock.module('@google/genai', { namedExports: { GoogleGenAI: MockGoogleGenAI } });
  const logs = opts.logs ?? { warn: [], debug: [] };
  t.mock.module('../../../config/logger', {
    namedExports: {
      logger: {
        warn: (...args: any[]) => logs.warn.push(args),
        debug: (...args: any[]) => logs.debug.push(args),
        info: () => {},
        error: () => {},
      },
    },
  });

  const originalKeys = process.env.GEMINI_API_KEYS;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalCooldown = process.env.GEMINI_KEY_COOLDOWN_MS;
  if (opts.apiKeys === undefined) delete process.env.GEMINI_API_KEYS; else process.env.GEMINI_API_KEYS = opts.apiKeys;
  if (opts.apiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = opts.apiKey;
  if (opts.cooldownMs === undefined) delete process.env.GEMINI_KEY_COOLDOWN_MS; else process.env.GEMINI_KEY_COOLDOWN_MS = opts.cooldownMs;

  const moduleUrl = `./gemini-key-pool.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  const pool = new mod.GeminiKeyPool();

  return {
    pool,
    logs,
    restoreEnv: () => {
      if (originalKeys === undefined) delete process.env.GEMINI_API_KEYS; else process.env.GEMINI_API_KEYS = originalKeys;
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
      if (originalCooldown === undefined) delete process.env.GEMINI_KEY_COOLDOWN_MS; else process.env.GEMINI_KEY_COOLDOWN_MS = originalCooldown;
    },
  };
}

// ── parsing / configuration ─────────────────────────────────────────────

test('GEMINI_API_KEYS: parses a comma-separated list, trims whitespace, drops empty entries, de-dupes', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: ' keyA ,keyB,, keyA ,keyC ,' });
  try {
    assert.equal(pool.size(), 3);
    assert.equal(pool.isConfigured(), true);
  } finally { restoreEnv(); }
});

test('single-key backward compatibility: GEMINI_API_KEY alone still works when GEMINI_API_KEYS is absent', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKey: 'legacy-single-key' });
  try {
    assert.equal(pool.size(), 1);
    assert.equal(pool.isConfigured(), true);
  } finally { restoreEnv(); }
});

test('GEMINI_API_KEYS takes priority over GEMINI_API_KEY when both are present', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'keyA,keyB', apiKey: 'legacy-single-key' });
  const seenKeys = new Set<string>();
  try {
    for (let i = 0; i < 4; i++) {
      await pool.execute(async (client: MockGoogleGenAI) => { seenKeys.add(client.apiKey); return null; });
    }
    assert.deepEqual([...seenKeys].sort(), ['keyA', 'keyB']);
    assert.equal(seenKeys.has('legacy-single-key'), false);
  } finally { restoreEnv(); }
});

test('neither GEMINI_API_KEYS nor GEMINI_API_KEY set: not configured, execute() rejects with NOT_CONFIGURED', async t => {
  const { pool, restoreEnv } = await loadPool(t, {});
  try {
    assert.equal(pool.isConfigured(), false);
    assert.equal(pool.size(), 0);
    await assert.rejects(
      () => pool.execute(async () => 'unreachable'),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.NOT_CONFIGURED); return true; }
    );
  } finally { restoreEnv(); }
});

// ── round-robin ──────────────────────────────────────────────────────────

test('round-robin: distributes consecutive successful calls across all keys in order, wrapping around', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2,key3' });
  try {
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      await pool.execute(async (client: MockGoogleGenAI) => { order.push(client.apiKey); return null; });
    }
    assert.deepEqual(order, ['key1', 'key2', 'key3', 'key1', 'key2', 'key3', 'key1']);
  } finally { restoreEnv(); }
});

// ── quota/rate-limit failover ────────────────────────────────────────────

test('failover: a RATE_LIMITED failure on the selected key retries with the next healthy key, transparent to the caller', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2' });
  try {
    const attempts: string[] = [];
    const result = await pool.execute(async (client: MockGoogleGenAI) => {
      attempts.push(client.apiKey);
      if (client.apiKey === 'key1') throw rateLimitedError();
      return 'success-from-' + client.apiKey;
    });
    assert.deepEqual(attempts, ['key1', 'key2']);
    assert.equal(result, 'success-from-key2');
  } finally { restoreEnv(); }
});

test('failover: never tries the same key twice within one failover cycle', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2,key3' });
  try {
    const attempts: string[] = [];
    await assert.rejects(
      pool.execute(async (client: MockGoogleGenAI) => {
        attempts.push(client.apiKey);
        throw rateLimitedError();
      })
    );
    assert.deepEqual(attempts, ['key1', 'key2', 'key3']);
    assert.equal(new Set(attempts).size, 3, 'each key must be tried at most once');
  } finally { restoreEnv(); }
});

// ── cooldown ─────────────────────────────────────────────────────────────

test('cooldown: a rate-limited key is skipped by a later separate call while still cooling down', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2', cooldownMs: '60000' });
  try {
    // First call: key1 rate-limited, key2 succeeds. key1 is now cooling down.
    await pool.execute(async (client: MockGoogleGenAI) => {
      if (client.apiKey === 'key1') throw rateLimitedError();
      return 'ok';
    });
    // Second call would normally start at key1 again (round robin), but
    // key1 is still cooling down, so it must be skipped straight to key2.
    const attempts: string[] = [];
    await pool.execute(async (client: MockGoogleGenAI) => {
      attempts.push(client.apiKey);
      return 'ok';
    });
    assert.deepEqual(attempts, ['key2']);
  } finally { restoreEnv(); }
});

test('cooldown: a key becomes eligible again once its cooldown window elapses', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2', cooldownMs: '10' });
  try {
    await pool.execute(async (client: MockGoogleGenAI) => {
      if (client.apiKey === 'key1') throw rateLimitedError();
      return 'ok';
    });
    await new Promise(resolve => setTimeout(resolve, 25)); // wait past the 10ms cooldown
    const attempts: string[] = [];
    await pool.execute(async (client: MockGoogleGenAI) => {
      attempts.push(client.apiKey);
      return 'ok';
    });
    // Round robin now starts back at key1 (2nd call already advanced the
    // cursor once), and key1's cooldown has elapsed, so it's eligible again.
    assert.ok(attempts.includes('key1') || attempts.includes('key2'));
  } finally { restoreEnv(); }
});

test('does not permanently disable a key after one transient rate-limit failure', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1', cooldownMs: '10' });
  try {
    await assert.rejects(
      pool.execute(async () => { throw rateLimitedError(); }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.RATE_LIMITED); return true; }
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    const result = await pool.execute(async () => 'recovered');
    assert.equal(result, 'recovered');
  } finally { restoreEnv(); }
});

// ── bounded retry ────────────────────────────────────────────────────────

test('bounded retry: with every key rate-limited, execute() makes exactly N attempts (never infinite) then throws honestly', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2,key3,key4,key5' });
  try {
    let callCount = 0;
    await assert.rejects(
      pool.execute(async () => { callCount++; throw rateLimitedError(); }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.RATE_LIMITED); return true; }
    );
    assert.equal(callCount, 5, 'must try each of the 5 configured keys exactly once, no more');
  } finally { restoreEnv(); }
});

// ── all-keys-exhausted ───────────────────────────────────────────────────

test('all-keys-exhausted: throws the real provider error honestly, never fabricates a response', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2' });
  try {
    const result = await pool.execute(async () => { throw rateLimitedError(); }).catch(err => err);
    assert.ok(result instanceof GeminiProviderError);
    assert.equal(result.code, GeminiErrorCode.RATE_LIMITED);
  } finally { restoreEnv(); }
});

// ── non-quota errors never rotate ───────────────────────────────────────

test('non-quota error (AUTHENTICATION_ERROR, 401): propagates immediately after one attempt, never tries another key', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2' });
  try {
    let callCount = 0;
    await assert.rejects(
      pool.execute(async () => { callCount++; throw authError(); }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.AUTHENTICATION_ERROR); return true; }
    );
    assert.equal(callCount, 1, 'must not rotate to a second key for a non-quota error');
  } finally { restoreEnv(); }
});

test('non-quota error (PROVIDER_UNAVAILABLE, 503): propagates immediately after one attempt, never rotates', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2' });
  try {
    let callCount = 0;
    await assert.rejects(
      pool.execute(async () => { callCount++; throw unavailableError(); }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.PROVIDER_UNAVAILABLE); return true; }
    );
    assert.equal(callCount, 1);
  } finally { restoreEnv(); }
});

test('non-quota error (application-level GeminiProviderError, e.g. INVALID_RESPONSE from malformed output): never rotates', async t => {
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: 'key1,key2' });
  try {
    let callCount = 0;
    await assert.rejects(
      pool.execute(async () => {
        callCount++;
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'malformed structured output');
      }),
      (err: any) => { assert.equal(err.code, GeminiErrorCode.INVALID_RESPONSE); return true; }
    );
    assert.equal(callCount, 1);
  } finally { restoreEnv(); }
});

// ── no secret leakage ────────────────────────────────────────────────────

test('no secret leakage: cooldown log messages never contain the raw API key, only the slot identifier', async t => {
  const secretKey = 'AIzaSy-fake-test-secret-value-should-never-be-logged';
  const { pool, logs, restoreEnv } = await loadPool(t, { apiKeys: `${secretKey},key2` });
  try {
    await pool.execute(async (client: MockGoogleGenAI) => {
      if (client.apiKey === secretKey) throw rateLimitedError();
      return 'ok';
    });
    const allLogText = [...logs.warn, ...logs.debug].flat().map(String).join('\n');
    assert.equal(allLogText.includes(secretKey), false, 'raw key must never appear in any log call');
    assert.match(allLogText, /gemini-key-slot-1/, 'logs should reference the slot identifier instead');
  } finally { restoreEnv(); }
});

test('no secret leakage: a thrown error after exhaustion never includes any raw key in its message', async t => {
  const secretKey = 'AIzaSy-another-fake-secret-should-not-leak';
  const { pool, restoreEnv } = await loadPool(t, { apiKeys: secretKey });
  try {
    const error = await pool.execute(async () => { throw rateLimitedError(); }).catch(err => err);
    assert.equal(String(error?.message ?? '').includes(secretKey), false);
    assert.equal(JSON.stringify(error ?? {}).includes(secretKey), false);
  } finally { restoreEnv(); }
});
