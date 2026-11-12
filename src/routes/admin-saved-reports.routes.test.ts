import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

test('analytics presets are private, permission-checked and validated', async t => {
  const id = '11111111-1111-4111-8111-111111111111';
  let row: { id: string; ownerId: string } | null = null;
  let listSkip: number | undefined;
  const model = {
    findMany: async ({ where, skip }: { where: { ownerId: string }; skip: number }) => { listSkip = skip; return row?.ownerId === where.ownerId ? [row] : []; },
    create: async ({ data }: { data: { ownerId: string } }) => {
      row = { ...data, id };
      const { ownerId: _owner, ...result } = row;
      return result;
    },
    deleteMany: async ({ where }: { where: { ownerId: string; id: string } }) => {
      if (row?.ownerId !== where.ownerId || row?.id !== where.id) return { count: 0 };
      row = null;
      return { count: 1 };
    },
  };
  const authenticate: RequestHandler = (req, res, next) => {
    const id = req.header('x-user');
    if (!id) { res.sendStatus(401); return; }
    req.user = { id } as typeof req.user;
    next();
  };
  const permission: RequestHandler = (req, res, next) => {
    if (req.header('x-permission') !== 'finance.read') { res.sendStatus(403); return; }
    next();
  };
  t.mock.module('../config/db', { namedExports: { prisma: { adminSavedReport: model } } });
  t.mock.module('../middlewares/auth.middleware', { namedExports: {
    authenticate, requireActiveUser: (_r: unknown, _s: unknown, next: () => void) => next(),
  } });
  t.mock.module('../middlewares/admin-access.middleware', { namedExports: {
    requirePermission: (key: string) => { assert.equal(key, 'finance.read'); return permission; },
  } });
  t.mock.module('../controllers/admin-analytics.controller', { namedExports: { getAnalyticsOverview: (_r: unknown, res: { end: () => void }) => res.end() } });
  const app = express();
  app.use(express.json());
  app.use('/analytics', (await import('./admin-analytics.routes')).default);
  const errors: ErrorRequestHandler = (err, _req, res, _next) => { res.status(err.statusCode ?? 500).json({ message: err.message }); };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/analytics/saved-reports';
    const call = (method: string, path = '', body?: object, user = 'owner', allowed = true) => fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}), ...(allowed ? { 'x-permission': 'finance.read' } : {}) },
      body: body && JSON.stringify(body),
    });
    const draft = { name: 'تقرير شهري', section: 'users', period: '30d', from: null, to: null, compare: true };
    assert.equal((await call('GET', '', undefined, '')).status, 401);
    assert.equal((await call('POST', '', draft, 'owner', false)).status, 403);
    assert.equal((await call('POST', '', { ...draft, ownerId: 'other' })).status, 400);
    assert.equal((await call('POST', '', { ...draft, period: 'custom', from: '2026-02-29' })).status, 400);
    const created = await call('POST', '', draft);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await created.json()).data, { id, ...draft });
    assert.equal((await (await call('GET')).json()).data.items.length, 1);
    assert.deepEqual((await (await call('GET', '', undefined, 'other')).json()).data.items, []);
    assert.equal((await call('DELETE', '/' + id, undefined, 'other')).status, 404);
    assert.equal((await call('GET', '?page=2')).status, 200);
    assert.equal(listSkip, 20);
    assert.equal((await call('GET', '?page=bad')).status, 400);
    assert.equal((await call('DELETE', '/' + id)).status, 204);
    assert.deepEqual((await (await call('GET')).json()).data.items, []);
  } finally { server.close(); }
});
