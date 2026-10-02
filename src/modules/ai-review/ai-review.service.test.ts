import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiReviewService } from './ai-review.service';
import { WaseetAiClient, type FetchLike } from '../../services/ai/waseet-ai/waseet-ai.client';
import type { WaseetAiConfig } from '../../config/ai/waseet-ai.config';
import { AppError } from '../../utils/app-error';

// AI-03 / AI-04 contract + adapter tests. The REAL WaseetAiClient runs (HTTP
// status mapping, envelope validation, timeout) against a mocked fetch —
// zero real WaseetAI/Gemini calls. The token below is a dummy test value.

const TEST_TOKEN = 'unit-test-dummy-token-0000';
const UPSTREAM_SECRET_TEXT = 'UPSTREAM-INTERNAL-DETAIL-should-never-leak';

type Call = { url: string; init: RequestInit; body: any };

function makeService(handler: (url: string, body: any, init: RequestInit) => Response | Promise<Response>, cfg: Partial<WaseetAiConfig> = {}) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    return handler(url, body, init);
  };
  const config: WaseetAiConfig = { baseUrl: 'https://waseet-ai.test', bearerToken: TEST_TOKEN, restTimeoutMs: 40, streamTimeoutMs: 40, ...cfg };
  return { service: new AiReviewService(new WaseetAiClient(fetchImpl, () => config)), calls };
}

const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown) => json(200, { success: true, data });
const hang = (init: RequestInit) => new Promise<Response>((_, reject) => {
  init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
});

// Documented v1.0.0 sample responses (guide §2.2 / §2.3).
const DOC_MILESTONES = {
  milestones: [
    { title: 'Stage 1: UI/UX & Prototypes', description: 'Figma screens and flows', days: 5, percentage: 30, amount: 900 },
    { title: 'Stage 2: Core Backend & APIs', description: 'Database, auth, payments', days: 10, percentage: 50, amount: 1500 },
    { title: 'Stage 3: Testing & Launch', description: 'QA, deployment and handover', days: 5, percentage: 20, amount: 600 },
  ],
};
const DOC_ANALYSIS = {
  clarityScore: 85,
  feasibilityScore: 72,
  marketFitRating: 'Good',
  executiveSummary: 'Feasible but budget is low for 4 APIs',
  strengths: ['Clear feature scope'],
  gapsAndRisks: ['API subscription costs not accounted for'],
};

async function rejectsWith(promise: Promise<unknown>, status: number): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof AppError, 'must be an AppError');
    assert.equal((e as AppError).statusCode, status);
    assert.ok(!String((e as Error).message).includes(TEST_TOKEN), 'error must never carry the credential');
    assert.ok(!String((e as Error).message).includes(UPSTREAM_SECRET_TEXT), 'error must never carry upstream body text');
    return e as AppError;
  }
  assert.fail('expected rejection — a fabricated fallback result was returned instead');
}

// ── AI-03 milestones ───────────────────────────────────────────────────────

test('milestones: request mapping matches the documented /v1/ai/milestones body exactly', async () => {
  const { service, calls } = makeService(() => ok(DOC_MILESTONES));
  await service.suggestMilestones({ title: ' متجر إلكتروني ', description: 'تطبيق عميل وسائق', totalAmount: 3000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://waseet-ai.test/v1/ai/milestones');
  assert.deepEqual(calls[0].body, { title: 'متجر إلكتروني', description: 'تطبيق عميل وسائق', totalAmount: 3000, currency: 'USD' });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TEST_TOKEN}`, 'only the backend→WaseetAI hop carries the bearer');
});

test('milestones: documented response maps to the existing SuggestedMilestone shape (days→estimatedDays, amount dropped)', async () => {
  const { service } = makeService(() => ok(DOC_MILESTONES));
  const result = await service.suggestMilestones({ title: 'E-Commerce App', description: 'x', totalAmount: 3000 });

  assert.deepEqual(result, [
    { title: 'Stage 1: UI/UX & Prototypes', description: 'Figma screens and flows', estimatedDays: 5, percentage: 30 },
    { title: 'Stage 2: Core Backend & APIs', description: 'Database, auth, payments', estimatedDays: 10, percentage: 50 },
    { title: 'Stage 3: Testing & Launch', description: 'QA, deployment and handover', estimatedDays: 5, percentage: 20 },
  ]);
  assert.ok(!JSON.stringify(result).includes(TEST_TOKEN));
});

test('milestones: the existing 100%-sum invariant is preserved (difference applied to the last milestone)', async () => {
  const data = { milestones: [{ ...DOC_MILESTONES.milestones[0] }, { ...DOC_MILESTONES.milestones[1] }, { ...DOC_MILESTONES.milestones[2], percentage: 15 }] };
  const { service } = makeService(() => ok(data));
  const result = await service.suggestMilestones({ title: 'App', totalAmount: 3000 });
  assert.equal(result.reduce((s, m) => s + (m.percentage ?? 0), 0), 100);
  assert.equal(result[2].percentage, 20);
});

test('milestones: percentages that cannot be balanced to 100 are invalid (503), never silently rebalanced', async () => {
  const data = { milestones: [{ ...DOC_MILESTONES.milestones[0], percentage: 100 }, { ...DOC_MILESTONES.milestones[1], percentage: 100 }, { ...DOC_MILESTONES.milestones[2], percentage: 0 }] };
  const { service } = makeService(() => ok(data));
  await rejectsWith(service.suggestMilestones({ title: 'App', totalAmount: 3000 }), 503);
});

test('milestones: missing documented required input (totalAmount) is a 400 and WaseetAI is never called', async () => {
  const { service, calls } = makeService(() => ok(DOC_MILESTONES));
  await rejectsWith(service.suggestMilestones({ title: 'App', description: 'x' }), 400);
  await rejectsWith(service.suggestMilestones({ title: '', description: 'x', totalAmount: 100 }), 400);
  assert.equal(calls.length, 0);
});

for (const [label, status] of [['4xx', 400], ['401', 401], ['429', 429], ['5xx', 503]] as const) {
  test(`milestones: upstream ${label} → honest 503, no fabricated milestones, upstream body not leaked`, async () => {
    const { service } = makeService(() => json(status, { success: false, error: { message: UPSTREAM_SECRET_TEXT } }));
    await rejectsWith(service.suggestMilestones({ title: 'App', totalAmount: 3000 }), 503);
  });
}

test('milestones: timeout → honest 503', async () => {
  const { service } = makeService((_u, _b, init) => hang(init));
  await rejectsWith(service.suggestMilestones({ title: 'App', totalAmount: 3000 }), 503);
});

test('milestones: malformed JSON / unsuccessful envelope / missing fields → 503', async () => {
  for (const respond of [
    () => new Response('<html>not json', { status: 200 }),
    () => json(200, { success: false, data: DOC_MILESTONES }),
    () => ok({ milestones: [] }),
    () => ok({ milestones: [{ title: 'A', description: 'B', percentage: 100 }] }), // days missing
    () => ok({ milestones: [{ title: 'A', description: 'B', days: 3, percentage: 140 }] }),
    () => ok({ nothing: true }),
  ]) {
    const { service } = makeService(respond);
    await rejectsWith(service.suggestMilestones({ title: 'App', totalAmount: 3000 }), 503);
  }
});

test('milestones: WaseetAI not configured → 503 without any network call', async () => {
  const { service, calls } = makeService(() => ok(DOC_MILESTONES), { bearerToken: undefined });
  await rejectsWith(service.suggestMilestones({ title: 'App', totalAmount: 3000 }), 503);
  assert.equal(calls.length, 0);
});

// ── AI-04 project analysis ─────────────────────────────────────────────────

const ANALYZE_DTO = {
  title: 'Smart Travel Booking App',
  description: 'Integration with 4 flight APIs',
  category: 'تطوير',
  totalAmount: 1500,
  stages: [
    { title: 'A', description: 'a', days: 5, percentage: 40 },
    { title: 'B', description: 'b', days: 10, percentage: 60 },
  ],
};

function routeAnalysis(analysis: () => Response | Promise<Response>, milestones: () => Response | Promise<Response> = () => ok(DOC_MILESTONES)) {
  return (url: string, _b: any, init: RequestInit) => (url.endsWith('/v1/ai/project-analysis') ? analysis() : url.endsWith('/v1/ai/milestones') ? milestones() : hang(init));
}

test('analysis: request mapping matches the documented /v1/ai/project-analysis body (budget←totalAmount, deadlineDays←Σ stage days)', async () => {
  const { service, calls } = makeService(routeAnalysis(() => ok(DOC_ANALYSIS)));
  await service.analyzeProjectModel(ANALYZE_DTO);

  const analysisCall = calls.find((c) => c.url.endsWith('/v1/ai/project-analysis'));
  assert.ok(analysisCall);
  assert.deepEqual(analysisCall!.body, { title: 'Smart Travel Booking App', description: 'Integration with 4 flight APIs', budget: 1500, deadlineDays: 15, currency: 'USD' });
  const msCall = calls.find((c) => c.url.endsWith('/v1/ai/milestones'));
  assert.deepEqual(msCall!.body, { title: 'Smart Travel Booking App', description: 'Integration with 4 flight APIs', totalAmount: 1500, currency: 'USD' });
});

test('analysis: documented response maps field-for-field; scores pass through untouched; absent Waseet fields are empty/null, not invented', async () => {
  const { service } = makeService(routeAnalysis(() => ok(DOC_ANALYSIS)));
  const result = await service.analyzeProjectModel(ANALYZE_DTO);

  assert.equal(result.clarityScore, 85);
  assert.equal(result.feasibilityScore, 72);
  assert.equal(result.executiveSummary, 'Feasible but budget is low for 4 APIs');
  assert.deepEqual(result.strengths, ['Clear feature scope']);
  assert.deepEqual(result.gapsAndRisks, ['API subscription costs not accounted for']);
  assert.equal(result.marketFitRating, null, '"Good" has no documented position on High/Medium/Low — never guessed');
  assert.deepEqual(result.recommendedImprovements, []);
  assert.equal(result.suggestedPricingStrategy, null);
  assert.equal(result.suggestedMilestones.length, 3, 'milestones come from the real documented /v1/ai/milestones call');
  assert.equal(result.suggestedMilestones[1].estimatedDays, 10);
  assert.ok(!JSON.stringify(result).includes(TEST_TOKEN));
});

test('analysis: an exact High/Medium/Low rating (any case) is passed through', async () => {
  const { service } = makeService(routeAnalysis(() => ok({ ...DOC_ANALYSIS, marketFitRating: 'medium' })));
  assert.equal((await service.analyzeProjectModel(ANALYZE_DTO)).marketFitRating, 'Medium');
});

test('analysis: a milestones-companion failure still returns the real analysis with suggestedMilestones=[]', async () => {
  const { service } = makeService(routeAnalysis(() => ok(DOC_ANALYSIS), () => json(500, {})));
  const result = await service.analyzeProjectModel(ANALYZE_DTO);
  assert.equal(result.clarityScore, 85);
  assert.deepEqual(result.suggestedMilestones, []);
});

test('analysis: missing budget or timeline is a 400 and WaseetAI is never called (no defaulted inputs)', async () => {
  const { service, calls } = makeService(routeAnalysis(() => ok(DOC_ANALYSIS)));
  await rejectsWith(service.analyzeProjectModel({ ...ANALYZE_DTO, totalAmount: undefined }), 400);
  await rejectsWith(service.analyzeProjectModel({ ...ANALYZE_DTO, stages: [] }), 400);
  await rejectsWith(service.analyzeProjectModel({ ...ANALYZE_DTO, stages: [{ title: 'A', days: 0 }] }), 400);
  assert.equal(calls.length, 0);
});

for (const [label, respond] of [
  ['4xx', () => json(422, { error: UPSTREAM_SECRET_TEXT })],
  ['5xx', () => json(502, { error: UPSTREAM_SECRET_TEXT })],
  ['malformed JSON', () => new Response('{bad', { status: 200 })],
  ['missing clarityScore', () => ok({ ...DOC_ANALYSIS, clarityScore: undefined })],
  ['missing executiveSummary', () => ok({ ...DOC_ANALYSIS, executiveSummary: '' })],
  ['strengths not an array', () => ok({ ...DOC_ANALYSIS, strengths: 'x' })],
  ['out-of-range score (never clamped)', () => ok({ ...DOC_ANALYSIS, feasibilityScore: 140 })],
] as const) {
  test(`analysis: ${label} → honest 503, no fabricated scores`, async () => {
    const { service } = makeService(routeAnalysis(respond as () => Response));
    await rejectsWith(service.analyzeProjectModel(ANALYZE_DTO), 503);
  });
}

test('analysis: timeout → honest 503', async () => {
  // fetch honors the client's own AbortSignal, as undici does.
  const { service } = makeService((url, _b, init) => (url.endsWith('/v1/ai/project-analysis') ? hang(init) : ok(DOC_MILESTONES)), { restTimeoutMs: 20 });
  await rejectsWith(service.analyzeProjectModel(ANALYZE_DTO), 503);
});
