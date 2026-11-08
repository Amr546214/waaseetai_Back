import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

test('report intake, duplicates, private reading and one authorized decision', async t => {
  const targetId = '11111111-1111-4111-8111-111111111111';
  const reportId = '22222222-2222-4222-8222-222222222222';
  let report: Record<string, unknown> | null = null;
  const audit: any[] = [];
  let failAudit = false;
  const listQueries: any[] = [], countQueries: any[] = [];
  const prisma = {
    $transaction: async (work: Promise<unknown>[] | ((tx: any) => Promise<unknown>)) => {
      if (Array.isArray(work)) return Promise.all(work);
      const snapshot = report && { ...report };
      const entries = audit.length;
      try { return await work(prisma); }
      catch (error) { report = snapshot; audit.length = entries; throw error; }
    },
    accountAuditLog: { create: async ({ data }: any) => {
      if (failAudit) throw new Error('audit store failed');
      audit.push(data);
    } },
    user: { findFirst: async () => ({ id: targetId, firstName: 'Test', lastName: 'Account' }) },
    platformReport: {
      findMany: async (q: any) => { listQueries.push(q); return []; },
      count: async (q: any) => { countQueries.push(q); return 41; },
      create: async ({ data }: any) => {
        if (report?.status === 'OPEN') throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        report = { id: reportId, status: 'OPEN', ...data };
        return { id: reportId, status: 'OPEN' };
      },
      findUnique: async ({ where }: any) => where.id === reportId ? report : null,
      findUniqueOrThrow: async ({ where }: any) => {
        if (!report || where.id !== reportId) throw new Error('not found');
        return report;
      },
      updateMany: async ({ where, data }: any) => {
        if (!report || where.id !== reportId || report.status !== where.status) return { count: 0 };
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
    const list = '/admin/reports';
    assert.equal((await call('user', 'GET', list + '?search=Private')).status, 403);
    assert.equal(listQueries.length, 0);
    assert.equal((await call('viewer', 'GET', list + '?targetType=OTHER')).status, 400);
    const filtered = await call('viewer', 'GET', list + '?targetType=SERVICE&status=OPEN&page=2&search=' + encodeURIComponent('  A%_  '));
    assert.equal(filtered.status, 200);
    assert.equal(filtered.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await filtered.json()).data, { items: [], total: 41, page: 2, pages: 3 });
    const expected = { status: 'OPEN', targetType: 'SERVICE', OR: [{ targetLabel: { contains: 'A\\%\\_', mode: 'insensitive' } }] };
    assert.deepEqual(listQueries[0].where, expected);
    assert.deepEqual(countQueries[0].where, expected);
    assert.equal(listQueries[0].skip, 20);
    assert.equal((await call('viewer', 'GET', list + '?search=' + reportId)).status, 200);
    assert.deepEqual(listQueries[1].where.OR.slice(1), [{ id: reportId }, { targetId: reportId }]);
    const decision = { status: 'RESOLVED', resolution: 'Reviewed internally' };
    assert.equal((await call('viewer', 'PATCH', detail, decision)).status, 403);
    assert.equal(audit.length, 0);
    assert.equal((await call('manager', 'PATCH', '/admin/reports/' + targetId, decision)).status, 404);
    failAudit = true;
    assert.equal((await call('manager', 'PATCH', detail, decision)).status, 500);
    assert.equal((await (await call('viewer', 'GET', detail)).json()).data.status, 'OPEN');
    assert.equal(audit.length, 0);
    failAudit = false;
    const result = await call('manager', 'PATCH', detail, decision);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data.reviewerId, 'manager');
    assert.equal((await call('manager', 'PATCH', detail, decision)).status, 409);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].userId, 'manager');
    assert.equal(audit[0].eventType, 'PLATFORM_REPORT_DECIDED');
    assert.equal(audit[0].source, 'ADMIN');
    assert.deepEqual(audit[0].beforeData, { status: 'OPEN' });
    assert.deepEqual(audit[0].afterData, { status: 'RESOLVED' });
    assert.deepEqual(audit[0].metaData, { adminId: 'manager', reportId });
    assert.doesNotMatch(JSON.stringify(audit[0]), /Reviewed internally|Detailed abuse report|Test Account/);
  } finally { server.close(); }
});
