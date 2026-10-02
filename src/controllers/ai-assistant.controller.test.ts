import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeProjectForProvider } from './ai-assistant.controller';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

test('analyzeProjectForProvider: always 503 AI_FEATURE_UNAVAILABLE, no analysis fabricated', async () => {
  const res = mockRes();
  await analyzeProjectForProvider({ params: { projectId: 'p1' }, body: { projectId: 'p1' }, user: { id: 'u1' } } as any, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'AI_FEATURE_UNAVAILABLE');
  assert.equal(res.body.data, undefined);
});

test('ai-assistant.controller and routes have no Gemini reference; route keeps provider-only auth and aiLimiter', () => {
  const ctrl = readFileSync(new URL('./ai-assistant.controller.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const routes = readFileSync(new URL('../routes/ai-assistant.routes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(ctrl, /gemini|prisma|generateStructured/i);
  assert.doesNotMatch(routes, /gemini/i);
  assert.match(routes, /router\.use\(authenticate, requireActiveUser, providerOnly, aiLimiter\)/);
});
