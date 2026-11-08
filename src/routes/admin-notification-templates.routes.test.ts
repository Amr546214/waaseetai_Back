import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

test('templates require Super Admin, validate drafts and preserve the winning edit', async t => {
  const id = '11111111-1111-4111-8111-111111111111';
  let row: Record<string, unknown> | null = null;
  const model = {
    findMany: async () => row ? [row] : [],
    create: async ({ data }: any) => {
      if (row) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      row = { ...data, id, version: 1, updatedAt: new Date() };
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      if (!row || where.id !== row.id || where.version !== row.version) return { count: 0 };
      row = { ...row, ...data, version: where.version + data.version.increment };
      return { count: 1 };
    },
    findUnique: async ({ where }: any) => where.id === row?.id ? row : null,
    findUniqueOrThrow: async () => row,
  };
  const auth: RequestHandler = (req, res, next) => {
    const role = req.header('x-role');
    if (!role) { res.sendStatus(401); return; }
    req.user = { id: 'super-1' } as typeof req.user;
    req.adminActor = { isSuperAdmin: role === 'super' } as NonNullable<typeof req.adminActor>;
    next();
  };
  t.mock.module('../config/db', { namedExports: { prisma: {
    notificationTemplate: model, $transaction: async (fn: (tx: any) => unknown) => fn({ notificationTemplate: model, accountAuditLog: { create: async () => ({}) } }),
  } } });
  t.mock.module('../middlewares/auth.middleware', { namedExports: { authenticate: auth, requireActiveUser: (_r: unknown, _s: unknown, next: () => void) => next() } });
  const app = express();
  app.use(express.json());
  app.use('/templates', (await import('./admin-notification-templates.routes')).default);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message }); };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/templates';
    const call = (method: string, path = '', body?: object, role = 'super') => fetch(base + path, {
      method, headers: { ...(role ? { 'x-role': role } : {}), 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    });
    const draft = { name: ' ترحيب ', title: 'عنوان', message: '<b>نص فقط</b>' };
    assert.equal((await call('GET', '', undefined, '')).status, 401);
    assert.equal((await call('GET', '', undefined, 'admin')).status, 403);
    assert.equal((await call('POST', '', draft, 'admin')).status, 403);
    assert.equal((await call('POST', '', { ...draft, recipients: ['qa'] })).status, 400);
    assert.equal((await call('POST', '', { ...draft, message: ' ' })).status, 400);
    const created = await call('POST', '', draft);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal((await created.json()).data.name, 'ترحيب');
    assert.equal((await call('POST', '', draft)).status, 409);
    assert.equal((await call('PATCH', '/' + id, { ...draft, version: 1 }, 'admin')).status, 403);
    const changed = await call('PATCH', '/' + id, { ...draft, version: 1, message: 'النسخة المحفوظة' });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).data.version, 2);
    const stale = await call('PATCH', '/' + id, { ...draft, version: 1 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'NOTIFICATION_TEMPLATE_CHANGED');
    const list = await call('GET', '?page=1');
    assert.equal((await list.json()).data.items[0].message, 'النسخة المحفوظة');
  } finally { server.close(); }
});
