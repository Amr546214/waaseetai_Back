import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Specialty portfolio AI review endpoints: provider auth + ownership + aiLimiter in front, advisory-only controller behind.
const routes = readFileSync(new URL('../routes/provider-specialty.routes.ts', import.meta.url), 'utf8');
const ctl = readFileSync(new URL('./specialty-ai.controller.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');

test('routes: POST ai-evaluate (rate limited) + GET ai-evaluation + GET ai-evaluations, all behind provider auth and the ownership check', () => {
  assert.match(routes, /router\.post\('\/:id\/ai-evaluate', \.\.\.providerAuth, requireOwnedProviderSpecialtyFromParam, aiLimiter, evaluateSpecialtyWithAI\)/);
  assert.match(routes, /router\.get\('\/:id\/ai-evaluation', \.\.\.providerAuth, requireOwnedProviderSpecialtyFromParam, getLatestSpecialtyAiEvaluation\)/);
  assert.match(routes, /router\.get\('\/:id\/ai-evaluations', \.\.\.providerAuth, requireOwnedProviderSpecialtyFromParam, listSpecialtyAiEvaluations\)/);
});

test('controller: no database access and no verification-state write of its own (the service only reads samples and appends an audit row)', () => {
  assert.doesNotMatch(ctl, /prisma|\.update\(|\.create\(|gemini/i);
  assert.doesNotMatch(ctl, /503|AI_FEATURE_UNAVAILABLE/);
});

test('controller maps the service result to {success,data} and passes errors (404) to next()', async (t) => {
  const calls: any[] = [];
  t.mock.module('../services/ai-features/specialty-portfolio-review.service', { namedExports: { specialtyPortfolioReviewService: {
    evaluate: async (...a: any[]) => { calls.push(['evaluate', ...a]); return { status: 'NOT_ENOUGH_DATA' }; },
    latest: async (...a: any[]) => { calls.push(['latest', ...a]); const e: any = new Error('x'); e.statusCode = 404; throw e; },
    history: async () => [],
  } } });
  const c = await import(`./specialty-ai.controller.ts?f=${Date.now()}`);
  const res: any = { code: 0, body: null, status(n: number) { this.code = n; return this; }, json(b: any) { this.body = b; return this; } };
  await c.evaluateSpecialtyWithAI({ params: { id: 'ps1' }, user: { id: 'u1' } }, res, () => {});
  assert.equal(res.code, 200); assert.deepEqual(res.body, { success: true, data: { status: 'NOT_ENOUGH_DATA' } });
  assert.deepEqual(calls[0], ['evaluate', 'u1', 'ps1']);
  let err: any; await c.getLatestSpecialtyAiEvaluation({ params: { id: 'ps1' }, user: { id: 'u1' } }, res, (e: any) => { err = e; });
  assert.equal(err.statusCode, 404);
});
