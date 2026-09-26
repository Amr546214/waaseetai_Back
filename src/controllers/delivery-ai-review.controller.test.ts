import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { AccountType, UserStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';

// Implementation Batch 5 — advisory-only delivery AI review controllers
// (client-requests.controller.ts#getDeliveryAiReview and
// provider.controller.ts#getDeliveryAiReview). Both real controllers are
// exercised behind the REAL authenticate/requireActiveUser middleware (only
// prisma.user.findUnique is mocked) so these tests prove actual route-level
// authentication behavior, not just the controller function in isolation.

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

  // client-requests.controller.ts and provider.controller.ts each pull in
  // several unrelated services (clientRequestsService, proposalService,
  // etc.) that transitively import ../socket (and, from there, the avatar
  // chat gateway's module-load-time OpenAI() construction). Mocked here
  // purely so importing either controller under test never touches a real
  // socket/mail/OpenAI transport in this unit test.
  t.mock.module('../socket', { namedExports: { getIO: () => null, ioInstance: null, initSocketServer: () => {} } });
  t.mock.module('../services/notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('../services/email.service', { namedExports: { emailService: {} } });
  t.mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 'session' }) } } });

  const service = {
    getDeliveryAiReview: async (...args: any[]) => {
      calls.push(args);
      if (opts.failure) throw opts.failure;
      return {
        summary: 'ملخص استشاري',
        alignedPoints: ['نقطة متوافقة'],
        potentialGaps: ['نقطة تحتاج توضيحاً'],
        questionsForReviewer: ['سؤال مقترح'],
        reviewedInputs: { deliveryText: true, stageRequirements: true, attachmentContent: false },
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

async function authenticatedRequest(auth: any, res: any) {
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'batch5-test-only-secret';
  const req: any = {
    headers: { authorization: `Bearer ${jwt.sign({ userId: 'authenticated-user' }, process.env.JWT_SECRET)}` },
    get: () => '',
    params: { id: 'contract-1', stageId: 'stage-1' },
  };
  let error: any;
  await auth.authenticate(req, res, (e: any) => { error = e; });
  assert.equal(error, undefined, 'authenticate must succeed for a real, valid JWT');
  auth.requireActiveUser(req, res, (e: any) => { error = e; });
  assert.equal(error, undefined, 'requireActiveUser must succeed for an ACTIVE account');
  return { req, restoreEnv: () => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; } };
}

test('client controller: authenticated active client success through real auth/active guards, uses real params', async t => {
  const x = await load(t, { accountType: AccountType.CLIENT_INDIVIDUAL });
  const { req, restoreEnv } = await authenticatedRequest(x.auth, x.res);
  t.after(restoreEnv);
  let error: any;
  await x.clientController.clientRequestsController.getDeliveryAiReview({ ...req, user: { ...req.user, id: 'authenticated-user' } }, x.res, (e: any) => { error = e; });
  assert.equal(error, undefined);
  assert.equal(x.res.body.success, true);
  assert.deepEqual(x.calls[0], ['authenticated-user', 'contract-1', 'stage-1']);
  assert.equal(x.res.body.data.reviewedInputs.attachmentContent, false);
});

test('provider controller: authenticated active provider success, uses real params', async t => {
  const x = await load(t, { accountType: AccountType.PROVIDER_INDIVIDUAL });
  const { req, restoreEnv } = await authenticatedRequest(x.auth, x.res);
  t.after(restoreEnv);
  let error: any;
  await x.providerController.getDeliveryAiReview({ ...req, user: { ...req.user, id: 'authenticated-user' } }, x.res, (e: any) => { error = e; });
  assert.equal(error, undefined);
  assert.equal(x.res.body.success, true);
  assert.deepEqual(x.calls[0], ['authenticated-user', 'contract-1', 'stage-1']);
});

test('client controller: unauthenticated (no token) request never reaches the service', async t => {
  const x = await load(t);
  const req: any = { headers: {}, get: () => '', params: { id: 'contract-1', stageId: 'stage-1' } };
  let error: any;
  await x.auth.authenticate(req, x.res, (e: any) => { error = e; });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 401);
  assert.equal(x.calls.length, 0);
});

test('client controller: an unrelated/unauthorized caller (service 403) is forwarded as a real error, not swallowed', async t => {
  const x = await load(t, { failure: new AppError('لا تملك صلاحية الاطلاع على هذا التسليم', 403) });
  const req: any = { user: { id: 'stranger' }, params: { id: 'contract-1', stageId: 'stage-1' } };
  let error: any;
  await x.clientController.clientRequestsController.getDeliveryAiReview(req, x.res, (e: any) => { error = e; });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 403);
});

test('client controller: delivery/contract not found (service 404) is forwarded as a real error', async t => {
  const x = await load(t, { failure: new AppError('العقد غير موجود', 404) });
  const req: any = { user: { id: 'authenticated-user' }, params: { id: 'missing', stageId: 'stage-1' } };
  let error: any;
  await x.clientController.clientRequestsController.getDeliveryAiReview(req, x.res, (e: any) => { error = e; });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 404);
});

test('client controller: Gemini failure gives an honest 502, not a fabricated review; no error swallowing of the manual flow', async t => {
  const x = await load(t, { failure: Object.assign(new Error('Gemini unavailable'), { code: 'PROVIDER_UNAVAILABLE' }) });
  const req: any = { user: { id: 'authenticated-user' }, params: { id: 'contract-1', stageId: 'stage-1' } };
  let error: any;
  await x.clientController.clientRequestsController.getDeliveryAiReview(req, x.res, (e: any) => { error = e; });
  assert.equal(error, undefined, 'a non-AppError Gemini failure must be handled here, not passed to next()');
  assert.equal(x.res.statusCode, 502);
  assert.equal(x.res.body.success, false);
  assert.match(x.res.body.message, /تعذر إنشاء المراجعة الاستشارية/);
});

test('provider controller: Gemini failure gives an honest 502 too', async t => {
  const x = await load(t, { failure: Object.assign(new Error('Gemini unavailable'), { code: 'PROVIDER_UNAVAILABLE' }) });
  const req: any = { user: { id: 'authenticated-user' }, params: { id: 'contract-1', stageId: 'stage-1' } };
  let error: any;
  await x.providerController.getDeliveryAiReview(req, x.res, (e: any) => { error = e; });
  assert.equal(error, undefined);
  assert.equal(x.res.statusCode, 502);
  assert.equal(x.res.body.success, false);
});

test('provider controller: unauthenticated (no user id) request never reaches the service', async t => {
  const x = await load(t);
  const req: any = { user: undefined, params: { id: 'contract-1', stageId: 'stage-1' } };
  await x.providerController.getDeliveryAiReview(req, x.res, () => {});
  assert.equal(x.res.statusCode, 401);
  assert.equal(x.calls.length, 0);
});

test('route wiring: client ai-review is behind authenticate, requireActiveUser and aiLimiter, alongside the manual review route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/client-requests.routes.ts'), 'utf8');
  assert.ok(source.includes(
    "router.post('/:id/stages/:stageId/ai-review', authenticate, requireActiveUser, aiLimiter, clientRequestsController.getDeliveryAiReview);"
  ));
  assert.ok(source.includes(
    "router.post('/:id/stages/:stageId/review', authenticate, requireActiveUser, clientRequestsController.reviewStageDelivery);"
  ), 'the manual, human-authoritative review route must remain present and untouched');
});

test('route wiring: provider ai-review is behind authenticate, requireActiveUser and aiLimiter, alongside the manual submit route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/provider.routes.ts'), 'utf8');
  assert.ok(source.includes(
    "router.post('/projects/:id/stages/:stageId/ai-review', authenticate, requireActiveUser, aiLimiter, getDeliveryAiReview);"
  ));
  assert.ok(source.includes(
    "router.post('/projects/:id/stages/:stageId/deliveries', authenticate, requireActiveUser, submitStageDelivery);"
  ), 'the manual, human-authoritative submit route must remain present and untouched');
});

test('neither ai-review route registration mentions decision/status/escrow mutation helpers', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '../routes/client-requests.routes.ts'), 'utf8');
  const providerSource = fs.readFileSync(path.join(__dirname, '../routes/provider.routes.ts'), 'utf8');
  const aiReviewLine = (source: string) => source.split('\n').find(line => line.includes('ai-review'))!;
  for (const line of [aiReviewLine(clientSource), aiReviewLine(providerSource)]) {
    assert.doesNotMatch(line, /reviewDelivery|submitDelivery|escrow|Escrow/i);
  }
});
