import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WaseetAiError, WaseetAiErrorCode } from './ai/waseet-ai/waseet-ai.errors';

// Proposal AI feedback — WaseetAI only (waseetAiClient mocked, no network).

const upstream = (overrides: Partial<any> = {}) => ({
  suggestedTitle: 'عرض مطور لتنفيذ المتجر',
  suggestedMessage: 'رسالة عرض محسّنة',
  qualityScore: 72,
  qualityTag: 'GOOD',
  priceAudit: { recommendedMin: 1, recommendedMax: 2, priceTag: 'FAIR', justification: 'ungrounded' },
  suggestedAdvantages: ['خبرة', ' سرعة '],
  ...overrides
});

const enriched = (o: any = {}) => ({ id: 'e1', aiMatchScore: 92, aiQualityTag: 'STRONG', aiPriceTag: 'FAIR', aiFeedback: { summary: ' ملخص ' }, ...o });

async function load(t: TestContext, suggestProposal: (body: any) => Promise<any> = async () => upstream(), enrich: (body: any) => Promise<any> = async () => enriched()) {
  const calls: any[] = [];
  t.mock.module('./ai/waseet-ai/waseet-ai.client', {
    namedExports: { waseetAiClient: {
      suggestProposal: async (body: any) => { calls.push(body); return suggestProposal(body); },
      enrichProposal: async (body: any) => { calls.push(body); return enrich(body); }
    } }
  });
  const { aiProposalService } = await import(`./ai-proposal.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return Object.assign(aiProposalService, { calls });
}

test('maps title/message/quality/advantages and sends exactly the verified request fields', async (t) => {
  const svc = await load(t);
  const result = await svc.evaluateAndSuggestProposal(' proj-1 ', ' عنواني ', ' رسالتي ', ['ignored']);
  assert.deepEqual(svc.calls, [{ projectId: 'proj-1', currentTitle: 'عنواني', currentMessage: 'رسالتي', currency: 'USD' }]);
  assert.deepEqual(result, {
    suggestedTitle: 'عرض مطور لتنفيذ المتجر',
    suggestedMessage: 'رسالة عرض محسّنة',
    qualityScore: 72,
    qualityTag: 'GOOD',
    suggestedAdvantages: ['خبرة', 'سرعة']
  });
});

test('priceAudit from the service is NEVER returned (not grounded in the real project budget)', async (t) => {
  const svc = await load(t);
  const result = await svc.evaluateAndSuggestProposal('p1', 't', 'm');
  assert.equal('priceAudit' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /recommendedMin|priceTag|justification|ungrounded/);
});

test('missing suggestedAdvantages maps to an empty list (nothing invented)', async (t) => {
  const svc = await load(t, async () => upstream({ suggestedAdvantages: undefined }));
  const result = await svc.evaluateAndSuggestProposal('p1', 't', 'm');
  assert.deepEqual(result.suggestedAdvantages, []);
});

test('upstream failure -> honest 503 without upstream text, no fabricated feedback', async (t) => {
  const SECRET = 'UPSTREAM-SECRET-DETAIL';
  const svc = await load(t, async () => { throw new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, SECRET, { status: 502 }); });
  await assert.rejects(
    () => svc.evaluateAndSuggestProposal('p1', 't', 'm'),
    (err: any) => err.statusCode === 503 && !String(err.message).includes(SECRET)
  );
});

test('not configured -> 503', async (t) => {
  const svc = await load(t, async () => { throw new WaseetAiError(WaseetAiErrorCode.NOT_CONFIGURED, 'x'); });
  await assert.rejects(() => svc.evaluateAndSuggestProposal('p1', 't', 'm'), (err: any) => err.statusCode === 503);
});

for (const bad of [
  { suggestedTitle: '' }, { suggestedMessage: '  ' }, { qualityScore: 'high' }, { qualityScore: NaN }, { qualityTag: '' }
]) {
  test(`unusable upstream response ${JSON.stringify(bad)} -> 503, not a half-empty suggestion`, async (t) => {
    const svc = await load(t, async () => upstream(bad));
    await assert.rejects(() => svc.evaluateAndSuggestProposal('p1', 't', 'm'), (err: any) => err.statusCode === 503);
  });
}

test('missing projectId or fully empty draft is a 400 without calling WaseetAI', async (t) => {
  const svc = await load(t);
  await assert.rejects(() => svc.evaluateAndSuggestProposal('', 't', 'm'), (err: any) => err.statusCode === 400);
  await assert.rejects(() => svc.evaluateAndSuggestProposal('p1', ' ', ' '), (err: any) => err.statusCode === 400);
  assert.equal(svc.calls.length, 0);
});

test('title and message are both required: each missing/blank case is a clear 400 and WaseetAI is never called', async (t) => {
  const svc = await load(t);
  const cases: Array<[string, string, RegExp]> = [
    ['', 'نص العرض', /عنوان العرض/],
    ['   ', 'نص العرض', /عنوان العرض/],
    ['عنوان العرض', '', /نص العرض/],
    ['عنوان العرض', '  ', /نص العرض/],
    ['', '', /العنوان ونصه معًا|ونصه معًا/]
  ];
  for (const [title, message, expected] of cases) {
    await assert.rejects(
      () => svc.evaluateAndSuggestProposal('p1', title, message),
      (err: any) => err.statusCode === 400 && expected.test(err.message)
    );
  }
  assert.equal(svc.calls.length, 0);
});

test('a title plus a message still reaches WaseetAI (successful path unchanged)', async (t) => {
  const svc = await load(t);
  const result = await svc.evaluateAndSuggestProposal('p1', 'عنوان', 'رسالة');
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].currentTitle, 'عنوان');
  assert.equal(svc.calls[0].currentMessage, 'رسالة');
  assert.ok(result.suggestedTitle);
});

test('route keeps authenticate + provider authorize + aiLimiter + validation; controller passes through the service result', () => {
  const route = readFileSync(new URL('../routes/proposal.routes.ts', import.meta.url), 'utf8');
  const idx = route.indexOf("'/ai-suggest'");
  const block = route.slice(idx, route.indexOf(');', idx));
  for (const piece of ['authenticate', 'authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY)', 'aiLimiter', 'validateDto(aiSuggestRequestSchema)']) {
    assert.ok(block.includes(piece), `route must keep ${piece}`);
  }
});

test('ai-proposal.service has no direct Gemini usage', () => {
  const src = readFileSync(new URL('./ai-proposal.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gemini\.client|geminiClient|generateStructured|generateStream/);
});

const ms = [{ stepOrder: 1, title: 'م1', description: 'وصف المرحلة', days: 3, percentage: 100, amount: 500 }];
const input = (o: any = {}) => ({ projectId: ' p1 ', title: ' ع ', message: ' ر ', totalPrice: 500, deliveryDays: 3, milestones: ms, ...o });

test('evaluate: sends real fields and milestones, drops price tag, maps score/tag/summary', async (t) => {
  const svc = await load(t);
  const r = await svc.evaluate(input());
  assert.deepEqual(svc.calls, [{ projectId: 'p1', title: 'ع', message: 'ر', totalPrice: 500, deliveryDays: 3, milestones: ms }]);
  assert.deepEqual(r, { qualityScore: 92, qualityTag: 'STRONG', summary: 'ملخص' });
  assert.doesNotMatch(JSON.stringify(r), /FAIR|aiPriceTag/);
});

test('evaluate: milestones key omitted when there are none', async (t) => {
  const svc = await load(t);
  await svc.evaluate(input({ milestones: [] }));
  assert.equal('milestones' in svc.calls[0], false);
});

test('evaluate: invalid input is a 400 without calling WaseetAI', async (t) => {
  const svc = await load(t);
  for (const bad of [{ title: ' ' }, { message: '' }, { projectId: '' }, { totalPrice: NaN }, { deliveryDays: Infinity }]) {
    await assert.rejects(() => svc.evaluate(input(bad)), (e: any) => e.statusCode === 400);
  }
  assert.equal(svc.calls.length, 0);
});

test('evaluate: upstream failure -> 503 without upstream text', async (t) => {
  const SECRET = 'UP-SECRET';
  const svc = await load(t, undefined, async () => { throw new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, SECRET, { status: 502 }); });
  await assert.rejects(() => svc.evaluate(input()), (e: any) => e.statusCode === 503 && !String(e.message).includes(SECRET));
});

for (const bad of [{ aiMatchScore: 101 }, { aiMatchScore: -1 }, { aiMatchScore: NaN }, { aiMatchScore: '9' }, { aiQualityTag: '' }, { aiFeedback: {} }, { aiFeedback: undefined }]) {
  test(`evaluate: unusable response ${JSON.stringify(bad)} -> 503`, async (t) => {
    const svc = await load(t, undefined, async () => enriched(bad));
    await assert.rejects(() => svc.evaluate(input()), (e: any) => e.statusCode === 503);
  });
}
