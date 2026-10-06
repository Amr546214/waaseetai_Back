import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

async function load(t: any, analyze: (userId: string, id: string) => Promise<any>) {
  t.mock.module('../services/ai-features/project-fit.service', { namedExports: { projectFitService: { analyze } } });
  return (await import(`./ai-assistant.controller.ts?f=${Date.now()}-${Math.random()}`)).analyzeProjectForProvider;
}

test('analyzeProjectForProvider: returns the service result as { success, data } for the authenticated provider', async (t) => {
  const seen: any[] = [];
  const handler = await load(t, async (u, id) => { seen.push([u, id]); return { generationSource: 'LLM', analysis: { summary: 's' } }; });
  const res = mockRes();
  await handler({ params: { projectId: 'p1' }, body: {}, user: { id: 'u1' } } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.generationSource, 'LLM');
  assert.deepEqual(seen, [['u1', 'p1']]);
});

test('analyzeProjectForProvider: POST body projectId works; a missing id is a 400 and the model is not called', async (t) => {
  let called = 0;
  const handler = await load(t, async () => { called++; return {}; });
  const ok = mockRes();
  await handler({ params: {}, body: { projectId: 'p9' }, user: { id: 'u1' } } as any, ok);
  assert.equal(ok.statusCode, 200);
  const bad = mockRes();
  await handler({ params: {}, body: {}, user: { id: 'u1' } } as any, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(called, 1);
});

test('analyzeProjectForProvider: a service failure (503) is passed to the error middleware, never answered with an invented analysis', async (t) => {
  const boom = Object.assign(new Error('x'), { statusCode: 503 });
  const handler = await load(t, async () => { throw boom; });
  let forwarded: any;
  const res = mockRes();
  await handler({ params: { projectId: 'p1' }, body: {}, user: { id: 'u1' } } as any, res, (e: any) => { forwarded = e; });
  assert.equal(forwarded, boom);
  assert.equal(res.body, undefined);
});

test('ai-assistant routes keep provider-only auth and aiLimiter', () => {
  const routes = readFileSync(new URL('../routes/ai-assistant.routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /router\.use\(authenticate, requireActiveUser, providerOnly, aiLimiter\)/);
  assert.doesNotMatch(routes, /gemini/i);
});
