import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { AccountType, UserStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';

// Implementation Batch 8 — advisory-only Gemini project health analysis
// controllers (client-requests.controller.ts#getProjectHealthAnalysis and
// provider.controller.ts#getProjectHealthAnalysis). Both real controllers
// are exercised behind the REAL authenticate/requireActiveUser middleware
// (only prisma.user.findUnique is mocked) so these tests prove actual
// route-level authentication behavior, not just the controller function in
// isolation — mirrors delivery-ai-review.controller.test.ts's pattern.

async function load(t: TestContext, opts: { accountType?: AccountType; status?: UserStatus; failure?: any } = {}) {
  const calls: any[] = [];
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        user: {
          findUnique: async () => ({
            id: 'authenticated-user',
            accountType: opts.accountType ?? AccountType.CLIENT_INDIVIDUAL,
            status: opts.status ?? UserStatus.ACTIVE,
            roles: [],
            activeRole: null,
          }),
        },
      },
    },
  });

  t.mock.module('../socket', { namedExports: { getIO: () => null, ioInstance: null, initSocketServer: () => {} } });
  t.mock.module('../services/notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('../services/email.service', { namedExports: { emailService: {} } });
  t.mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 'session' }) } } });

  const service = {
    getProjectHealthAnalysis: async (...args: any[]) => {
      calls.push(args);
      if (opts.failure) throw opts.failure;
      return {
        confidence: 70, riskLevel: 'منخفضة', riskLevelKey: 'LOW',
        healthRating: 'المشروع يسير ضمن الجدول الزمني المتوقع.',
        bullets: ['لا توجد طلبات تعديل متكررة حتى الآن.'],
        earlyDays: 1, matchPercentage: null,
      };
    },
  };
  t.mock.module('../services/project-progress.service', { namedExports: { projectProgressService: service } });

  const clientController = await import(`./client-requests.controller.ts?test=${Date.now()}-${Math.random()}`);
  const providerController = await import(`./provider.controller.ts?test=${Date.now()}-${Math.random()}`);
  const auth = await import(`../middlewares/auth.middleware.ts?test=${Date.now()}-${Math.random()}`);
  const res: any = {
    statusCode: 200,
    body: null,
    status(n: number) { this.statusCode = n; return this; },
    json(body: any) { this.body = body; return this; },
  };
  return { clientController, providerController, auth, calls, res };
}

async function authenticatedRequest(auth: any, res: any, opts: { expectActiveGuardError?: boolean } = {}) {
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'batch8-test-only-secret';
  const req: any = {
    headers: { authorization: `Bearer ${jwt.sign({ userId: 'authenticated-user' }, process.env.JWT_SECRET)}` },
    get: () => '',
    params: { id: 'contract-1' },
  };
  let error: any;
  await auth.authenticate(req, res, (e: any) => { error = e; });
  assert.equal(error, undefined, 'authenticate must succeed for a real, valid JWT');
  auth.requireActiveUser(req, res, (e: any) => { error = e; });
  if (opts.expectActiveGuardError) {
    return { req, activeGuardError: error, restoreEnv: () => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; } };
  }
  assert.equal(error, undefined, 'requireActiveUser must succeed for an ACTIVE account');
  return { req, activeGuardError: error, restoreEnv: () => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; } };
}

test('client controller: authenticated active client success through real auth/active guards, uses real params', async t => {
  const x = await load(t, { accountType: AccountType.CLIENT_INDIVIDUAL });
  const { req, restoreEnv } = await authenticatedRequest(x.auth, x.res);
  t.after(restoreEnv);
  let error: any;
  await x.clientController.clientRequestsController.getProjectHealthAnalysis({ ...req, user: { ...req.user, id: 'authenticated-user' } }, x.res, (e: any) => { error = e; });
  assert.equal(error, undefined);
  assert.equal(x.res.body.success, true);
  assert.deepEqual(x.calls[0], ['authenticated-user', 'contract-1']);
});

test('provider controller: authenticated active provider success, uses real params', async t => {
  const x = await load(t, { accountType: AccountType.PROVIDER_INDIVIDUAL });
  const { req, restoreEnv } = await authenticatedRequest(x.auth, x.res);
  t.after(restoreEnv);
  let error: any;
  await x.providerController.getProjectHealthAnalysis({ ...req, user: { ...req.user, id: 'authenticated-user' } }, x.res, (e: any) => { error = e; });
  assert.equal(error, undefined);
  assert.equal(x.res.body.success, true);
  assert.deepEqual(x.calls[0], ['authenticated-user', 'contract-1']);
});

test('client controller: unauthenticated (no token) request never reaches the service', async t => {
  const x = await load(t);
  const req: any = { headers: {}, get: () => '', params: { id: 'contract-1' } };
  let error: any;
  await x.auth.authenticate(req, x.res, (e: any) => { error = e; });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 401);
  assert.equal(x.calls.length, 0);
});

test('a SUSPENDED (inactive) user is denied by requireActiveUser before the service is ever reached', async t => {
  const x = await load(t, { status: UserStatus.SUSPENDED });
  const { activeGuardError, restoreEnv } = await authenticatedRequest(x.auth, x.res, { expectActiveGuardError: true });
  t.after(restoreEnv);
  assert.ok(activeGuardError instanceof AppError);
  assert.equal(activeGuardError.statusCode, 403);
  assert.equal(x.calls.length, 0, 'the service must never be called for a suspended account');
});

test('a PENDING_VERIFICATION (inactive) user is denied by requireActiveUser before the service is ever reached', async t => {
  const x = await load(t, { status: UserStatus.PENDING_VERIFICATION });
  const { activeGuardError, restoreEnv } = await authenticatedRequest(x.auth, x.res, { expectActiveGuardError: true });
  t.after(restoreEnv);
  assert.ok(activeGuardError instanceof AppError);
  assert.equal(activeGuardError.statusCode, 403);
  assert.equal(x.calls.length, 0);
});

test('client controller: an unrelated/unauthorized caller (service 403) is forwarded as a real error, not swallowed', async t => {
  const x = await load(t, { failure: new AppError('لا تملك صلاحية الاطلاع على هذا المشروع', 403) });
  const req: any = { user: { id: 'stranger' }, params: { id: 'contract-1' } };
  let error: any;
  await x.clientController.clientRequestsController.getProjectHealthAnalysis(req, x.res, (e: any) => { error = e; });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 403);
});

test('client controller: project/contract not found (service 404) is forwarded as a real error', async t => {
  const x = await load(t, { failure: new AppError('العقد غير موجود', 404) });
  const req: any = { user: { id: 'authenticated-user' }, params: { id: 'missing' } };
  let error: any;
  await x.clientController.clientRequestsController.getProjectHealthAnalysis(req, x.res, (e: any) => { error = e; });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 404);
});

test('client controller: Gemini failure gives an honest 502, not a fabricated health result', async t => {
  const x = await load(t, { failure: Object.assign(new Error('Gemini unavailable'), { code: 'PROVIDER_UNAVAILABLE' }) });
  const req: any = { user: { id: 'authenticated-user' }, params: { id: 'contract-1' } };
  let error: any;
  await x.clientController.clientRequestsController.getProjectHealthAnalysis(req, x.res, (e: any) => { error = e; });
  assert.equal(error, undefined, 'a non-AppError Gemini failure must be handled here, not passed to next()');
  assert.equal(x.res.statusCode, 502);
  assert.equal(x.res.body.success, false);
  assert.match(x.res.body.message, /تعذر إجراء تحليل صحة المشروع/);
});

test('provider controller: Gemini failure gives an honest 502 too', async t => {
  const x = await load(t, { failure: Object.assign(new Error('Gemini unavailable'), { code: 'PROVIDER_UNAVAILABLE' }) });
  const req: any = { user: { id: 'authenticated-user' }, params: { id: 'contract-1' } };
  let error: any;
  await x.providerController.getProjectHealthAnalysis(req, x.res, (e: any) => { error = e; });
  assert.equal(error, undefined);
  assert.equal(x.res.statusCode, 502);
  assert.equal(x.res.body.success, false);
});

test('provider controller: unauthenticated (no user id) request never reaches the service', async t => {
  const x = await load(t);
  const req: any = { user: undefined, params: { id: 'contract-1' } };
  await x.providerController.getProjectHealthAnalysis(req, x.res, () => {});
  assert.equal(x.res.statusCode, 401);
  assert.equal(x.calls.length, 0);
});

test('route wiring: client health analysis is behind authenticate, requireActiveUser and aiLimiter, alongside the manual review route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/client-requests.routes.ts'), 'utf8');
  assert.ok(source.includes(
    "router.post('/:id/health', authenticate, requireActiveUser, aiLimiter, clientRequestsController.getProjectHealthAnalysis);"
  ));
  assert.ok(source.includes(
    "router.post('/:id/stages/:stageId/review', authenticate, requireActiveUser, clientRequestsController.reviewStageDelivery);"
  ), 'the manual, human-authoritative review route must remain present and untouched');
});

test('route wiring: provider health analysis is behind authenticate, requireActiveUser and aiLimiter, alongside the manual submit route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/provider.routes.ts'), 'utf8');
  assert.ok(source.includes(
    "router.post('/projects/:id/health', authenticate, requireActiveUser, aiLimiter, getProjectHealthAnalysis);"
  ));
  assert.ok(source.includes(
    "router.post('/projects/:id/stages/:stageId/deliveries', authenticate, requireActiveUser, submitStageDelivery);"
  ), 'the manual, human-authoritative submit route must remain present and untouched');
});

test('neither health-analysis route registration mentions decision/status/escrow mutation helpers', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '../routes/client-requests.routes.ts'), 'utf8');
  const providerSource = fs.readFileSync(path.join(__dirname, '../routes/provider.routes.ts'), 'utf8');
  const healthLine = (source: string) => source.split('\n').find(line => line.includes("'/:id/health'") || line.includes("'/projects/:id/health'"))!;
  for (const line of [healthLine(clientSource), healthLine(providerSource)]) {
    assert.doesNotMatch(line, /reviewDelivery|submitDelivery|escrow|Escrow|resolveDispute/i);
  }
});
