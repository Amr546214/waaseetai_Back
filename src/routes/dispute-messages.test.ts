import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import { disputeMessagesRouter } from './dispute-messages.routes';
import { requirePermission } from '../middlewares/admin-access.middleware';
import type { AppError } from '../utils/app-error';

test('dispute thread shares messages with parties and scoped staff, and refuses writes once closed', async () => {
  const id = 'a0acb310-6fa8-421c-9f89-9aff69391025';
  const messageId = '2114fe21-4b38-4788-a77c-435e602b20fa';
  const dispute = { openedById: 'client', againstUserId: 'provider', status: 'OPEN' };
  const messages: any[] = [];
  let reads = 0;
  const db = {
    dispute: { findUnique: async ({ where }: any) => where.id === id ? dispute : null },
    disputeMessage: {
      findMany: async () => { ++reads; return messages.slice().reverse(); },
      findFirst: async () => null,
    },
    $transaction: async (work: (tx: any) => unknown) => work({
      $queryRaw: async (_: TemplateStringsArray, disputeId: string) => disputeId === id ? [dispute] : [],
      disputeMessage: { create: async ({ data }: any) => {
        const message = { id: messageId, authorId: data.authorId, authorKind: data.authorKind, body: data.body, createdAt: new Date() };
        messages.push(message);
        return message;
      } },
    }),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.get('x-test-user') ?? 'outsider';
    req.user = { id: user } as typeof req.user;
    if (user.startsWith('staff')) {
      req.adminActor = {
        isSuperAdmin: false,
        permissions: new Set(user === 'staff-write' ? ['disputes.view', 'messages.use'] : user === 'staff-read' ? ['disputes.view'] : []),
      } as NonNullable<typeof req.adminActor>;
    }
    next();
  });
  app.use('/party/:id/messages', disputeMessagesRouter(false, db as any));
  app.use('/staff/:id/messages', requirePermission('disputes.view'), disputeMessagesRouter(true, db as any));
  const errorHandler: ErrorRequestHandler = (error: AppError, _req, res, _next) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  };
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const call = (scope: string, user: string, body?: string, query = '') => fetch(
      `http://127.0.0.1:${port}/${scope}/${id}/messages${query}`,
      { method: body === undefined ? 'GET' : 'POST', headers: { 'x-test-user': user, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify({ body }) }) },
    );

    assert.equal((await call('party', 'outsider')).status, 404);
    assert.equal((await call('party', 'outsider', 'outside')).status, 404);
    assert.equal((await call('staff', 'staff-none')).status, 403);
    assert.equal(reads, 0);
    assert.equal((await call('party', 'client', '  ')).status, 400);

    const saved = await call('party', 'client', '  evidence note  ');
    assert.equal(saved.status, 201);
    assert.equal((await saved.json()).data.own, true);

    const thread = await call('party', 'provider');
    assert.equal(thread.headers.get('cache-control'), 'no-store');
    const { data } = await thread.json();
    assert.equal(data.messages[0].body, 'evidence note');
    assert.equal(data.messages[0].own, false);
    assert.equal('authorId' in data.messages[0], false);
    assert.equal((await call('party', 'client', undefined, '?before=bad')).status, 400);
    assert.equal((await call('party', 'client', undefined, '?before=' + messageId)).status, 400);

    assert.equal((await (await call('staff', 'staff-read')).json()).data.canSend, false);
    assert.equal((await call('staff', 'staff-read', 'blocked')).status, 403);
    const staff = await call('staff', 'staff-write', 'reply');
    assert.equal(staff.status, 201);
    assert.equal((await staff.json()).data.authorKind, 'STAFF');

    dispute.status = 'RESOLVED';
    const closed = (await (await call('party', 'client')).json()).data;
    assert.equal(closed.canSend, false);
    assert.equal(closed.messages.length, 2);
    assert.equal((await call('party', 'provider', 'too late')).status, 409);
    assert.equal((await call('staff', 'staff-write', 'too late')).status, 409);
    assert.equal(messages.length, 2);
  } finally {
    server.close();
  }
});
