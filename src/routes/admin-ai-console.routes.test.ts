import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type RequestHandler, type ErrorRequestHandler } from 'express';

test('AI console requires a signed-in active Super Admin and never offers a model action', async t => {
  let calls = 0;
  const auth: RequestHandler = (req, res, next) => {
    const role = req.header('x-role');
    if (!role) { res.sendStatus(401); return; }
    req.user = { id: 'admin' } as typeof req.user;
    req.adminActor = { isSuperAdmin: role === 'super' } as NonNullable<typeof req.adminActor>;
    next();
  };
  t.mock.module('../middlewares/auth.middleware', { namedExports: {
    authenticate: auth, requireActiveUser: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.header('x-inactive')) { res.sendStatus(403); return; } next();
    },
  } });
  t.mock.module('../services/admin-ai-console.service', { namedExports: { adminAiConsoleService: {
    overview: async () => { calls++; return { specialtyChecks: 0 }; },
    audit: async () => { calls++; return { items: [], hasNext: false }; },
    matching: async () => { calls++; return { items: [], count: 0, hasNext: false }; },
  } } });
  const app = express();
  app.use('/ai', (await import('./admin-ai-console.routes')).default);
  const error: ErrorRequestHandler = (err, _req, res, _next) => { res.status(err.statusCode ?? 500).end(); };
  app.use(error);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/ai';
    for (const path of ['/overview', '/audit', '/matching']) {
      assert.equal((await fetch(base + path)).status, 401);
      assert.equal((await fetch(base + path, { headers: { 'x-role': 'viewer' } })).status, 403);
      const response = await fetch(base + path, { headers: { 'x-role': 'super' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(calls, 3);
    assert.equal((await fetch(base + '/audit?days=1000000', { headers: { 'x-role': 'super' } })).status, 400);
    assert.equal((await fetch(base + '/overview', { headers: { 'x-role': 'super', 'x-inactive': '1' } })).status, 403);
    assert.equal((await fetch(base + '/matching', { method: 'POST', headers: { 'x-role': 'super' } })).status, 404);
    assert.equal(calls, 3);
  } finally { server.close(); }
});
