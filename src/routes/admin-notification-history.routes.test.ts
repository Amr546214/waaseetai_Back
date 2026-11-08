import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

test('notification history is private, paged by a stable cursor and contains no notification content or recipients', async t => {
  const createdAt = new Date('2026-11-08T12:00:00Z');
  const rows = Array.from({ length: 26 }, (_, i) => ({
    id: '11111111-1111-4111-8111-' + String(100 - i).padStart(12, '0'),
    createdAt, category: 'ALL', type: 'PLATFORM_REPORT_DECIDED', isRead: false,
    title: 'private title', message: 'private body', userId: 'private user', metadata: { token: 'private' }, actionUrl: '/private',
  }));
  const calls: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: { notification: { findMany: async (q: any) => {
    calls.push(q);
    return (q.where.OR ? rows.slice(25) : rows).map(row => Object.fromEntries(Object.keys(q.select).map(key => [key, row[key as keyof typeof row]])));
  } } } } });
  const auth: RequestHandler = (req, res, next) => {
    const role = req.header('x-role');
    if (!role) { res.sendStatus(401); return; }
    req.adminActor = { isSuperAdmin: role === 'super' } as NonNullable<typeof req.adminActor>;
    next();
  };
  t.mock.module('../middlewares/auth.middleware', { namedExports: { authenticate: auth, requireActiveUser: (_req: unknown, _res: unknown, next: () => void) => next() } });
  const router = (await import('./admin-notification-history.routes')).default;
  const app = express();
  app.use('/history', router);
  const handleError: ErrorRequestHandler = (err, _req, res, _next) => { res.status(err.statusCode ?? 500).json({ message: err.message }); };
  app.use(handleError);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/history';
    const get = (path = '', role = 'super') => fetch(base + path, { headers: role ? { 'x-role': role } : {} });
    assert.equal((await get('', '')).status, 401);
    assert.equal((await get('', 'admin')).status, 403);
    assert.equal((await get('?beforeAt=2026-11-08T12%3A00%3A00Z')).status, 400);
    assert.equal((await get('?range=30d')).status, 400);
    assert.equal(calls.length, 0);
    const first = await get('?range=7d&category=ALL&read=unread');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const { data } = await first.json();
    assert.equal(data.items.length, 25);
    assert.deepEqual(data.nextCursor, { beforeAt: createdAt.toISOString(), beforeId: rows[24].id });
    assert.doesNotMatch(JSON.stringify(data), /private|userId|message|metadata|actionUrl|title/);
    assert.equal(calls[0].where.isRead, false);
    assert.equal(calls[0].where.category, 'ALL');
    assert.ok(Math.abs(Date.now() - calls[0].where.createdAt.gte.getTime() - 7 * 86400000) < 5000);
    assert.equal(calls[0].take, 26);
    assert.deepEqual(calls[0].orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    const next = await get('?' + new URLSearchParams(data.nextCursor).toString());
    assert.equal(next.status, 200);
    assert.deepEqual(calls[1].where.OR, [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: rows[24].id } }]);
    const nextData = (await next.json()).data;
    assert.equal(nextData.items[0].id, rows[25].id);
    assert.equal(nextData.nextCursor, null);
  } finally { server.close(); }
});
