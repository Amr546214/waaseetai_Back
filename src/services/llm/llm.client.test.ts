import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LlmClient } from './llm.client';
import { LlmError, LlmErrorCode, llmErrorToAppError, LLM_NOT_CONFIGURED_MESSAGE, LLM_UNAVAILABLE_MESSAGE } from './llm.errors';
import { getLlmConfig, type LlmConfig } from './llm.config';
import { buildPayload, findPersonalData, normalizeDigits, scrubFreeText } from './llm.payload';
import { resolvePath, verifyGrounding, GroundingError } from './llm.truth';
import { MonthlyBudget, RateLimiter, TtlLru } from './llm.limits';
import { GeminiProvider } from './providers/gemini.provider';
import type { LlmProvider, LlmProviderRequest } from './providers/llm-provider';

const CONFIG: LlmConfig = { provider: 'gemini', apiKey: 'test-key-not-real', model: 'test-model', monthlyBudgetUsd: null, priceInputPerMillionUsd: null, priceOutputPerMillionUsd: null, ratePerHour: 10, cacheTtlMs: 600_000 };
const Schema = z.object({ summary: z.string(), score: z.number().min(0).max(100) });

function fakeProvider(script: Array<string | LlmError | ((req: LlmProviderRequest) => string)>, calls: LlmProviderRequest[] = []): LlmProvider {
  let i = 0;
  return {
    async generate(req) {
      calls.push(req);
      const step = script[Math.min(i++, script.length - 1)];
      if (step instanceof LlmError) throw step;
      const text = typeof step === 'function' ? step(req) : step;
      return { text, tokensIn: 100, tokensOut: 50 };
    },
  };
}
const logs: string[] = [];
const logger = { info: (m: string) => { logs.push(m); }, warn: (m: string) => { logs.push(m); } };
function client(provider: LlmProvider, config: LlmConfig | null = CONFIG, extra: any = {}) {
  return new LlmClient({ getConfig: () => config, createProvider: () => provider, logger, sleep: async () => {}, ...extra });
}
const base = { feature: 'project-fit', userId: 'user-1', schema: Schema, system: 'sys', input: { project: { title: 'متجر إلكتروني' } } };
const ok = JSON.stringify({ summary: 'ملخص', score: 80 });

test('success returns data, usage and source LLM (never a provider name)', async () => {
  const r = await client(fakeProvider([ok])).generateJson(base);
  assert.deepEqual(r.data, { summary: 'ملخص', score: 80 });
  assert.equal(r.source, 'LLM');
  assert.deepEqual(r.usage, { tokensIn: 100, tokensOut: 50 });
});

test('missing env → NOT_CONFIGURED (503, fixed Arabic message), no provider call', async () => {
  const calls: LlmProviderRequest[] = [];
  const c = client(fakeProvider([ok], calls), null);
  await assert.rejects(c.generateJson(base), (e: any) => e instanceof LlmError && e.code === LlmErrorCode.NOT_CONFIGURED);
  const app = llmErrorToAppError(new LlmError(LlmErrorCode.NOT_CONFIGURED, 'x'));
  assert.equal(app.statusCode, 503);
  assert.equal(app.message, LLM_NOT_CONFIGURED_MESSAGE);
  assert.equal(calls.length, 0);
});

test('config: every one of LLM_PROVIDER / key / LLM_MODEL is required; LLM_API_KEY or GEMINI_API_KEY accepted; unsupported provider rejected', () => {
  const env = { LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', LLM_MODEL: 'm' };
  assert.ok(getLlmConfig(env));
  assert.ok(getLlmConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', LLM_MODEL: 'm' }));
  assert.equal(getLlmConfig({ ...env, LLM_MODEL: '' }), null);
  assert.equal(getLlmConfig({ ...env, LLM_API_KEY: '' }), null);
  assert.equal(getLlmConfig({ LLM_API_KEY: 'k', LLM_MODEL: 'm' }), null);
  assert.equal(getLlmConfig({ ...env, LLM_PROVIDER: 'openai' }), null);
  assert.equal(getLlmConfig({ ...env, LLM_MONTHLY_BUDGET_USD: '50' }), null, 'a budget without prices fails closed');
  assert.ok(getLlmConfig({ ...env, LLM_MONTHLY_BUDGET_USD: '50', LLM_PRICE_INPUT_PER_MILLION_USD: '1', LLM_PRICE_OUTPUT_PER_MILLION_USD: '2' }));
  assert.equal(getLlmConfig(env)!.ratePerHour, 10);
});

test('invalid JSON then valid on the single repair attempt', async () => {
  const calls: LlmProviderRequest[] = [];
  const r = await client(fakeProvider(['not json', ok], calls)).generateJson(base);
  assert.equal(r.data.score, 80);
  assert.equal(calls.length, 2);
  assert.match(calls[1].user, /problems/);
});

test('schema-invalid output after the repair attempt → INVALID_RESPONSE (503)', async () => {
  const bad = JSON.stringify({ summary: 'x', score: 500 });
  const calls: LlmProviderRequest[] = [];
  await assert.rejects(client(fakeProvider([bad, bad, bad], calls)).generateJson(base), (e: any) => e.code === LlmErrorCode.INVALID_RESPONSE);
  assert.equal(calls.length, 2, 'exactly one repair attempt');
  assert.equal(llmErrorToAppError(new LlmError(LlmErrorCode.INVALID_RESPONSE, 'x')).statusCode, 503);
});

test('output that cites a value not in the input is rejected (UNGROUNDED_OUTPUT), no invented answer returned', async () => {
  const S = z.object({ items: z.array(z.object({ id: z.string(), note: z.string() })) });
  const out = JSON.stringify({ items: [{ id: 'ghost', note: 'x' }] });
  await assert.rejects(
    client(fakeProvider([out])).generateJson({ ...base, schema: S, input: { c: [{ id: 'a' }] }, grounding: { ids: [{ output: 'items[].id', input: 'c[].id' }] } }),
    (e: any) => e.code === LlmErrorCode.UNGROUNDED_OUTPUT,
  );
});

test('model/provider failure → PROVIDER_UNAVAILABLE mapped to a fixed 503 message with no provider name', async () => {
  await assert.rejects(client(fakeProvider([new LlmError(LlmErrorCode.UNKNOWN, 'boom')])).generateJson(base), (e: any) => e.code === LlmErrorCode.UNKNOWN);
  const app = llmErrorToAppError(new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'secret upstream text'));
  assert.equal(app.statusCode, 503);
  assert.equal(app.message, LLM_UNAVAILABLE_MESSAGE);
  assert.doesNotMatch(app.message, /secret|gemini|google|openai/i);
});

test('one retry for a transient failure only; non-transient failures are not retried', async () => {
  const calls: LlmProviderRequest[] = [];
  const r = await client(fakeProvider([new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, '503', { retryable: true }), ok], calls)).generateJson(base);
  assert.equal(r.data.score, 80);
  assert.equal(calls.length, 2);
  const calls2: LlmProviderRequest[] = [];
  await assert.rejects(client(fakeProvider([new LlmError(LlmErrorCode.AUTHENTICATION_ERROR, '401'), ok], calls2)).generateJson(base));
  assert.equal(calls2.length, 1);
  const calls3: LlmProviderRequest[] = [];
  await assert.rejects(client(fakeProvider([new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, '503', { retryable: true })], calls3)).generateJson(base));
  assert.equal(calls3.length, 2, 'a second transient failure is not retried again');
});

test('timeout: the abort signal fires and the call fails with TIMEOUT', async () => {
  const hanging: LlmProvider = { generate: (req) => new Promise((_res, rej) => req.signal.addEventListener('abort', () => rej(new LlmError(LlmErrorCode.TIMEOUT, 'aborted')))) };
  await assert.rejects(client(hanging).generateJson({ ...base, timeoutMs: 1000 }), (e: any) => e.code === LlmErrorCode.TIMEOUT);
});

test('per user + feature rate limit (RATE_LIMITED → 429) and independent users/features', async () => {
  const c = client(fakeProvider([ok]), { ...CONFIG, ratePerHour: 2 });
  await c.generateJson(base); await c.generateJson(base);
  await assert.rejects(c.generateJson(base), (e: any) => e.code === LlmErrorCode.RATE_LIMITED);
  assert.equal(llmErrorToAppError(new LlmError(LlmErrorCode.RATE_LIMITED, 'x')).statusCode, 429);
  await c.generateJson({ ...base, userId: 'user-2' });
  await c.generateJson({ ...base, feature: 'project-health' });
});

test('concurrent calls for the same user+feature are refused (BUSY)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: LlmProvider = { generate: async () => { await gate; return { text: ok, tokensIn: 1, tokensOut: 1 }; } };
  const c = client(slow);
  const first = c.generateJson(base);
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(c.generateJson(base), (e: any) => e.code === LlmErrorCode.BUSY);
  release();
  await first;
});

test('read-only cache: identical input is served from memory, a different input or user is not', async () => {
  const calls: LlmProviderRequest[] = [];
  const c = client(fakeProvider([ok], calls));
  await c.generateJson({ ...base, cache: true });
  await c.generateJson({ ...base, cache: true });
  assert.equal(calls.length, 1);
  await c.generateJson({ ...base, cache: true, input: { project: { title: 'تطبيق' } } });
  await c.generateJson({ ...base, cache: true, userId: 'user-2' });
  assert.equal(calls.length, 3);
  await c.generateJson({ ...base, userId: 'user-9' }); await c.generateJson({ ...base, userId: 'user-9' });
  assert.equal(calls.length, 5, 'uncached calls always reach the provider');
});

test('monthly budget breaker trips, then BUDGET_EXCEEDED (503)', async () => {
  const cfg = { ...CONFIG, monthlyBudgetUsd: 0.0001, priceInputPerMillionUsd: 1000, priceOutputPerMillionUsd: 1000 };
  const c = client(fakeProvider([ok]), cfg);
  await c.generateJson(base); // spends 150 tokens × 1000 / 1e6 = 0.15 USD
  await assert.rejects(c.generateJson({ ...base, userId: 'user-2' }), (e: any) => e.code === LlmErrorCode.BUDGET_EXCEEDED);
  assert.equal(llmErrorToAppError(new LlmError(LlmErrorCode.BUDGET_EXCEEDED, 'x')).statusCode, 503);
});

test('logs carry feature, hashed user, latency, tokens and outcome — never the prompt, the output or the user id', async () => {
  logs.length = 0;
  await client(fakeProvider([ok])).generateJson({ ...base, input: { project: { title: 'عنوان-سري-123' } } });
  const joined = logs.join('\n');
  assert.match(joined, /feature=project-fit user=[0-9a-f]{12} ms=\d+ tokensIn=100 tokensOut=50 outcome=ok/);
  assert.doesNotMatch(joined, /عنوان-سري|ملخص|user-1|test-key/);
});

test('the outgoing payload text never contains personal data after buildPayload', () => {
  const dirty = {
    title: 'متجر', description: 'تواصل على ali@example.com أو +966 50 123 4567 أو ٠٥٠١٢٣٤٥٦٧ أو https://x.com/ali أو @ali_dev',
    firstName: 'علي', email: 'a@b.com', phone: '0501234567', requirements: ['راسلني a@b.com'],
  };
  const payload = buildPayload(dirty, { title: 'string', description: 'text', requirements: ['text'] }) as any;
  assert.equal(findPersonalData(payload), null);
  assert.equal('firstName' in payload, false);
  assert.equal('email' in payload, false);
  assert.equal('phone' in payload, false);
  assert.equal(findPersonalData(dirty), 'ali@example.com');
  assert.equal(scrubFreeText('٠٥٠١٢٣٤٥٦٧'), '[محجوب]');
  assert.equal(normalizeDigits('٣ و ۴'), '3 و 4');
});

test('allowlist: a field that is not listed never leaves the server', () => {
  const out = buildPayload({ a: 'x', secret: 'y', nested: { keep: 1, drop: 2 } }, { a: 'string', nested: { keep: 'number' } }) as any;
  assert.deepEqual(out, { a: 'x', nested: { keep: 1 } });
});

// ── honesty verifier ──
test('verifier: ids ⊆ input, basedOn resolves, quotes are literal, numbers appear in the input', () => {
  const input = { project: { title: 'متجر', requirements: ['دفع إلكتروني', 'لوحة تحكم'], budgetMax: 5000 }, candidates: [{ id: 'a' }, { id: 'b' }] };
  const good = { items: [{ id: 'a', text: 'الميزانية 5000', basedOn: ['project.budgetMax'], quote: 'دفع إلكتروني' }] };
  const spec = { ids: [{ output: 'items[].id', input: 'candidates[].id' }], basedOn: ['items[].basedOn'], quotes: ['items[].quote'], freeText: ['items[].text'] };
  verifyGrounding(good, input, spec);
  assert.throws(() => verifyGrounding({ items: [{ ...good.items[0], id: 'z' }] }, input, spec), GroundingError);
  assert.throws(() => verifyGrounding({ items: [{ ...good.items[0], basedOn: ['project.nothing'] }] }, input, spec), GroundingError);
  assert.throws(() => verifyGrounding({ items: [{ ...good.items[0], basedOn: [] }] }, input, spec), GroundingError);
  assert.throws(() => verifyGrounding({ items: [{ ...good.items[0], quote: 'نظام دفع غير موجود' }] }, input, spec), GroundingError);
  assert.throws(() => verifyGrounding({ items: [{ ...good.items[0], text: 'الميزانية 7000' }] }, input, spec), GroundingError);
  verifyGrounding({ items: [{ ...good.items[0], text: 'الميزانية ٥٠٠٠' }] }, input, spec); // Arabic digits normalised
  assert.deepEqual(resolvePath(input, 'candidates[].id'), ['a', 'b']);
});

test('limits: rate limiter window, LRU ttl, budget rolls over by month', () => {
  let t = 0;
  const rl = new RateLimiter(2, 1000, () => t);
  assert.ok(rl.tryAcquire('k')); assert.ok(rl.tryAcquire('k')); assert.equal(rl.tryAcquire('k'), false);
  t = 1001; assert.ok(rl.tryAcquire('k'));
  const lru = new TtlLru<number>(2, () => t);
  lru.set('a', 1, 100); lru.set('b', 2, 100); lru.set('c', 3, 100);
  assert.equal(lru.get('a'), undefined); assert.equal(lru.get('c'), 3);
  t += 200; assert.equal(lru.get('c'), undefined);
  let date = new Date('2026-01-15T00:00:00Z');
  const mb = new MonthlyBudget(1, 1_000_000, 0, () => date);
  mb.record(2, 0); assert.equal(mb.allows(), false);
  date = new Date('2026-02-01T00:00:00Z'); assert.equal(mb.allows(), true);
});

test('gemini adapter: maps HTTP failures to LlmError codes, keeps the key in a header only and never copies upstream text', async () => {
  const mk = (status: number, body: any = {}) => new GeminiProvider({ apiKey: 'KEY-123', model: 'm', fetchImpl: (async (_u: any, init: any) => {
    assert.equal(init.headers['x-goog-api-key'], 'KEY-123');
    assert.doesNotMatch(String(_u), /KEY-123/);
    return new Response(JSON.stringify(body), { status });
  }) as any });
  const req = () => ({ system: 's', user: 'u', maxOutputTokens: 100, signal: new AbortController().signal });
  await assert.rejects(mk(401, { error: 'UPSTREAM-TEXT' }).generate(req()), (e: any) => e.code === LlmErrorCode.AUTHENTICATION_ERROR && !/UPSTREAM/.test(e.message));
  await assert.rejects(mk(503).generate(req()), (e: any) => e.code === LlmErrorCode.PROVIDER_UNAVAILABLE && e.retryable);
  await assert.rejects(mk(429).generate(req()), (e: any) => e.code === LlmErrorCode.PROVIDER_UNAVAILABLE && !e.retryable);
  await assert.rejects(mk(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }).generate(req()), (e: any) => e.code === LlmErrorCode.INVALID_RESPONSE);
  const good = await mk(200, { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }).generate(req());
  assert.deepEqual(good, { text: '{"a":1}', tokensIn: 7, tokensOut: 3 });
});

test('static: no model/provider name appears in any user-facing LLM message, and no model name is hardcoded in the layer', () => {
  const dir = __dirname;
  const files = [...readdirSync(dir), ...readdirSync(join(dir, 'providers')).map((f) => `providers/${f}`)].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf-8');
    // Arabic literals (what users can see) must not name a provider
    for (const m of src.match(/'[^'\n]*[؀-ۿ][^'\n]*'/g) ?? []) assert.doesNotMatch(m, /gemini|google|openai|anthropic|claude|gpt/i, `${f}: ${m}`);
    assert.doesNotMatch(src, /gemini-\d|gpt-\d|claude-\d/i, `${f}: hardcoded model name`);
  }
  assert.doesNotMatch(LLM_UNAVAILABLE_MESSAGE + LLM_NOT_CONFIGURED_MESSAGE, /gemini|google|openai|anthropic/i);
});
