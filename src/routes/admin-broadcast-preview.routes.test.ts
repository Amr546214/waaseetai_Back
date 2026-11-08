import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

test('only Super Admin can preview an eligible audience; preview cannot send', async t => {
  const calls: unknown[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: { user: { count: async ({ where }: { where: unknown }) => {
    calls.push(where);
    return 3;
  } } } } });
  const auth: RequestHandler = (req, res, next) => {
    const role = req.header('x-role');
    if (!role) { res.sendStatus(401); return; }
    req.adminActor = { isSuperAdmin: role === 'super' } as NonNullable<typeof req.adminActor>;
    next();
  };
  t.mock.module('../middlewares/auth.middleware', { namedExports: {
    authenticate: auth, requireActiveUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  } });
  const app = express();
  app.use('/preview', (await import('./admin-broadcast-preview.routes')).default);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error.statusCode ?? 500).json({ message: error.message }); };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/preview';
    const get = (q: string, role = 'super') => fetch(base + q, { headers: role ? { 'x-role': role } : {} });
    assert.equal((await get('?audience=CLIENTS', '')).status, 401);
    assert.equal((await get('?audience=CLIENTS', 'admin')).status, 403);
    assert.equal((await get('?audience=ADMIN')).status, 400);
    assert.equal((await get('?audience=CLIENTS&send=true')).status, 400);
    assert.equal((await fetch(base, { method: 'POST', headers: { 'x-role': 'super' } })).status, 404);
    assert.equal(calls.length, 0);
    for (const [audience, types] of [
      ['CLIENTS', ['CLIENT_INDIVIDUAL', 'CLIENT_COMPANY']],
      ['PROVIDERS', ['PROVIDER_INDIVIDUAL', 'PROVIDER_COMPANY']],
      ['MARKETERS', ['MARKETING_BROKER']],
    ] as const) {
      const result = await get('?audience=' + audience);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      const { data } = await result.json();
      assert.deepEqual(Object.keys(data).sort(), ['audience', 'checkedAt', 'count']);
      assert.equal(data.count, 3);
      assert.deepEqual(calls.at(-1), { accountType: { in: types }, status: 'ACTIVE', isBanned: false });
    }
  } finally { server.close(); }
});
