import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateSpecialtyWithAI } from './specialty-ai.controller';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

test('evaluateSpecialtyWithAI: always 503 AI_FEATURE_UNAVAILABLE', async () => {
  const res = mockRes();
  await evaluateSpecialtyWithAI({ params: { id: 'ps-1' }, user: { id: 'u1' } } as any, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'AI_FEATURE_UNAVAILABLE');
  assert.match(res.body.message, /WaseetAI/);
});

test('specialty-ai.controller has no Gemini reference and no database access (no verification-state write)', () => {
  const src = readFileSync(new URL('./specialty-ai.controller.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /gemini|prisma|\.update\(|\.create\(|generateStructured/i);
});

test('the ai-evaluate route keeps provider auth, ownership check and aiLimiter before the (disabled) controller', () => {
  const routes = readFileSync(new URL('../routes/provider-specialty.routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /router\.post\('\/:id\/ai-evaluate', \.\.\.providerAuth, requireOwnedProviderSpecialtyFromParam, aiLimiter, evaluateSpecialtyWithAI\)/);
});
