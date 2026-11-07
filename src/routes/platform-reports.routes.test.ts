import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

test('report intake, duplicates, private reading and one authorized decision', async t => {
  const targetId = '11111111-1111-4111-8111-111111111111';
  const reportId = '22222222-2222-4222-8222-222222222222';
  let report: Record<string, unknown> | null = null;
  const prisma = {
    user: { findFirst: async () => ({ id: targetId, firstName: 'Test', lastName: 'Account' }) },
    platformReport: {
      create: async ({ data }: any) => {
        if (report?.status === 'OPEN') throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        report = { id: reportId, status: 'OPEN', ...data };
        return { id: reportId, status: 'OPEN' };
      },
      findUnique: async ({ where }: any) => where.id === reportId ? report : null,
      updateMany: async ({ data }: any) => {
        if (!report || report.status !== 'OPEN') return { count: 0 };
        Object.assign(report, data);
        return { count: 1 };
      },
    },
  };
  const auth: RequestHandler = (req, _res, next) => {
    const role = req.header('x-test-role') ?? 'user';
    req.user = { id: role === 'self' ? targetId : role } as typeof req.user;
    req.adminActor = {
      permissions: new Set(role === 'manager' ? ['reports.view', 'reports.manage'] : role === 'viewer' ? ['reports.view'] : []),
    } as NonNullable<typeof req.adminActor>;
    next();
  };
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('../middlewares/auth.middleware', { namedExports: { authenticate: auth, requireActiveUser: (_req: unknown, _res: unknown, next: () => void) => next() } });
  const { userPlatformReports, adminPlatformReports } = await import('./platform-reports.routes');
  const app = express();
  app.use(express.json());
  app.use('/reports', userPlatformReports);
  app.use('/admin/reports', adminPlatformReports);
  const errors: ErrorRequestHandler = (err, _req, res, _next) => { res.status(err.statusCode || 500).json({ message: err.message }); };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const call = (role: string, method: string, path: string, data?: unknown) => fetch(base + path, {
      method, headers: { 'x-test-role': role, 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const input = { targetType: 'ACCOUNT', targetId, reason: 'Detailed abuse report' };
    assert.equal((await call('self', 'POST', '/reports', input)).status, 400);
    assert.equal((await call('user', 'POST', '/reports', input)).status, 201);
    assert.equal((await call('user', 'POST', '/reports', input)).status, 409);
    const detail = '/admin/reports/' + reportId;
    assert.equal((await call('user', 'GET', detail)).status, 403);
    assert.equal((await call('viewer', 'GET', detail)).status, 200);
    const decision = { status: 'RESOLVED', resolution: 'Reviewed internally' };
    assert.equal((await call('viewer', 'PATCH', detail, decision)).status, 403);
    const result = await call('manager', 'PATCH', detail, decision);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data.reviewerId, 'manager');
    assert.equal((await call('manager', 'PATCH', detail, decision)).status, 409);
  } finally { server.close(); }
});
