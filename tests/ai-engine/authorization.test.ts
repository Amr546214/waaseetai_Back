import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { AccountType, ProjectStatus, SpecialtyVerificationStatus, UserStatus } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import projectRoutes from '../../src/routes/project.routes';
import proposalRoutes from '../../src/routes/proposal.routes';
import clientRequestRoutes from '../../src/routes/client-requests.routes';
import { projectController } from '../../src/controllers/project.controller';
import { proposalController } from '../../src/controllers/proposal.controller';
import { clientRequestsController } from '../../src/controllers/client-requests.controller';
import { ProjectService } from '../../src/services/project.service';
import { aiProposalService } from '../../src/services/ai-proposal.service';
import { clientRequestsService } from '../../src/services/client-requests.service';
import { prisma } from '../../src/config/db';
import { structuredAiExecutionService } from '../../src/modules/ai-engine';
import { aiLimiter } from '../../src/middlewares/rate-limit.middleware';
import {
  authenticate,
  requireActiveUser,
} from '../../src/middlewares/auth.middleware';
import { AppError } from '../../src/utils/app-error';

type AnyRecord = Record<string, any>;

const replaceProxyMethod = (
  context: TestContext,
  target: AnyRecord,
  methodName: string,
  implementation: (...args: any[]) => any
) => {
  const original = target[methodName];
  const replacement = context.mock.fn(implementation);
  target[methodName] = replacement;
  context.after(() => {
    target[methodName] = original;
  });
  return replacement;
};

const PROJECT_ID = 'project-authorization-fixture';
const ACTOR_ID = 'actor-authorization-fixture';
const OTHER_USER_ID = 'other-user-fixture';

const accessProject = (overrides: AnyRecord = {}): AnyRecord => ({
  id: PROJECT_ID,
  status: ProjectStatus.IN_PROGRESS,
  specialty: 'تطوير الويب',
  clientId: OTHER_USER_ID,
  providerId: null,
  contract: null,
  projectProposals: [],
  proposals: [],
  ...overrides,
});

const projectDetails = (overrides: AnyRecord = {}): AnyRecord => ({
  id: PROJECT_ID,
  title: 'منصة أعمال تجريبية',
  description: 'وصف مشروع اصطناعي لا يحتوي على بيانات شخصية.',
  specialty: 'تطوير الويب',
  subSpecialties: ['واجهات المستخدم'],
  requirements: ['TypeScript'],
  outputs: 'تطبيق ويب',
  customConditions: null,
  deliveryDays: 21,
  budgetType: 'fixed',
  budgetMin: 4000,
  budgetMax: 6000,
  budgetFixed: 5000,
  budgetHourly: null,
  status: ProjectStatus.OPEN,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  _count: { proposals: 1, projectProposals: 2 },
  client: {
    id: 'client-fixture',
    firstName: 'عميل',
    lastName: 'تجريبي',
    avatarUrl: null,
    clientProfile: { companyName: null, kycStatus: 'VERIFIED' },
  },
  ...overrides,
});

const approvedMatchingProviderProfile = (): AnyRecord => ({
  providerSpecialties: [
    {
      specialtyId: 'specialty-fixture',
      isActive: true,
      status: SpecialtyVerificationStatus.APPROVED,
      subSpecialties: ['واجهات المستخدم'],
      specialty: {
        name: 'Web Development',
        nameAr: 'تطوير الويب',
        nameEn: 'Web Development',
      },
    },
  ],
});

const proposalProjectDetails = (): AnyRecord => ({
  title: 'منصة أعمال تجريبية',
  description: 'وصف مشروع اصطناعي.',
  budgetMin: 4000,
  budgetMax: 6000,
  budgetFixed: null,
  deliveryDays: 21,
  requirements: ['TypeScript'],
  specialty: 'تطوير الويب',
});

const proposalFeedback = {
  suggestedTitle: 'عرض تقني',
  suggestedMessage: 'خطة تنفيذ اصطناعية.',
  qualityScore: 88,
  qualityTag: 'GOOD' as const,
  priceAudit: {
    recommendedMin: 4000,
    recommendedMax: 6000,
    priceTag: 'FAIR' as const,
    justification: 'متوافق مع النطاق.',
  },
  recommendedAdvantages: ['تنفيذ مرحلي'],
};

const successfulAiResult = {
  success: true as const,
  data: proposalFeedback,
  metadata: {
    executionId: 'execution-fixture',
    provider: 'openai' as const,
    capability: 'proposals' as const,
    operation: 'proposal_feedback',
    model: 'test-model',
    latencyMs: 1,
    success: true,
    attempts: 1,
  },
};

const getRouteHandlers = (
  router: AnyRecord,
  path: string,
  method: 'get' | 'post'
): Function[] => {
  const layer = router.stack.find(
    (candidate: AnyRecord) =>
      candidate.route?.path === path && Boolean(candidate.route.methods?.[method])
  );

  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} to be registered.`);
  return layer.route.stack.map((routeLayer: AnyRecord) => routeLayer.handle);
};

const expectAppError = async (
  action: () => Promise<unknown>,
  statusCode: number
): Promise<AppError> => {
  try {
    await action();
    assert.fail(`Expected AppError(${statusCode}).`);
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, statusCode);
    return error;
  }
};

const assertActorScopedProjectAuthorizationQuery = (args: AnyRecord): void => {
  assert.equal(args.where?.id, PROJECT_ID);
  assert.equal(args.select?.projectProposals?.where?.providerId, ACTOR_ID);
  assert.equal(args.select?.proposals?.where?.providerId, ACTOR_ID);

  for (const field of [
    'title',
    'description',
    'requirements',
    'outputs',
    'customConditions',
    'deliveryDays',
    'budgetType',
    'budgetMin',
    'budgetMax',
    'budgetFixed',
    'budgetHourly',
  ]) {
    assert.equal(
      args.select?.[field],
      undefined,
      `Authorization query must not select ${field}.`
    );
  }
};

const assertDetailedProjectQuery = (args: AnyRecord): void => {
  assert.equal(args.where?.id, PROJECT_ID);
  assert.equal(args.select?.title, true);
  assert.equal(args.select?.description, true);
};

const assertApprovedSpecialtyQuery = (args: AnyRecord): void => {
  assert.equal(args.where?.userId, ACTOR_ID);
  assert.deepEqual(args.include?.providerSpecialties?.where, {
    isActive: true,
    status: SpecialtyVerificationStatus.APPROVED,
  });
};

const invokeMiddleware = async (
  handler: Function,
  req: Request,
  res: Response
): Promise<{ nextCalled: boolean; error: unknown }> => {
  let nextCalled = false;
  let error: unknown;

  await Promise.resolve(handler(
    req,
    res,
    ((nextError?: unknown) => {
      nextCalled = true;
      error = nextError;
    }) as NextFunction
  ));

  return { nextCalled, error };
};

const createResponseRecorder = () => {
  let statusCode: number | undefined;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  return {
    response,
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
};

const mockProjectSummaryQueries = (
  context: TestContext,
  authorizationResult: AnyRecord | null,
  detailsResult: AnyRecord = projectDetails()
) => {
  let callCount = 0;
  const mock = replaceProxyMethod(
    context,
    prisma.project as AnyRecord,
    'findUnique',
    async (args: AnyRecord) => {
      callCount += 1;
      if (callCount === 1) {
        assertActorScopedProjectAuthorizationQuery(args);
        return authorizationResult;
      }
      if (callCount === 2) {
        assertDetailedProjectQuery(args);
        return detailsResult;
      }
      throw new Error('Unexpected additional project query.');
    }
  );

  return { mock, getCallCount: () => callCount };
};

const assertProjectSummaryAllowed = async (
  context: TestContext,
  authorizationResult: AnyRecord,
  actorOverrides: AnyRecord = {}
): Promise<void> => {
  const queries = mockProjectSummaryQueries(context, authorizationResult);
  const service = new ProjectService();

  const summary = await service.getProjectSummary(PROJECT_ID, {
    userId: ACTOR_ID,
    accountType: AccountType.CLIENT_INDIVIDUAL,
    ...actorOverrides,
  });

  assert.equal(queries.getCallCount(), 2);
  assert.deepEqual(summary, {
    id: PROJECT_ID,
    title: 'منصة أعمال تجريبية',
    description: 'وصف مشروع اصطناعي لا يحتوي على بيانات شخصية.',
    specialty: 'تطوير الويب',
    subSpecialties: ['واجهات المستخدم'],
    requirements: ['TypeScript'],
    outputs: 'تطبيق ويب',
    clientType: 'فرد',
    deliveryDays: 21,
    budgetType: 'fixed',
    budgetMin: 4000,
    budgetMax: 6000,
    budgetFixed: 5000,
    budgetHourly: null,
    status: ProjectStatus.OPEN,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    proposalsCount: 3,
    client: {
      id: 'client-fixture',
      name: 'عميل تجريبي',
      avatarUrl: null,
      isVerified: true,
    },
  });
};

describe('project details and summary authorization', () => {
  test('both project detail routes require authentication and active status', () => {
    const expectedHandlers = [
      authenticate,
      requireActiveUser,
      projectController.getSummary,
    ];

    assert.deepEqual(getRouteHandlers(projectRoutes, '/:id', 'get'), expectedHandlers);
    assert.deepEqual(
      getRouteHandlers(projectRoutes, '/:id/summary', 'get'),
      expectedHandlers
    );
  });

  test('nonexistent project returns 404 without a detail query', async context => {
    const queries = mockProjectSummaryQueries(context, null);
    const error = await expectAppError(
      () => new ProjectService().getProjectSummary(PROJECT_ID, {
        userId: ACTOR_ID,
        accountType: AccountType.PROVIDER_INDIVIDUAL,
      }),
      404
    );

    assert.equal(queries.getCallCount(), 1);
    assert.equal(error.message, 'المشروع غير موجود أو لا تملك صلاحية الوصول إليه');
  });

  test('inaccessible project returns the equivalent 404 without detailed fields', async context => {
    const queries = mockProjectSummaryQueries(context, accessProject());
    const error = await expectAppError(
      () => new ProjectService().getProjectSummary(PROJECT_ID, {
        userId: ACTOR_ID,
        accountType: AccountType.CLIENT_INDIVIDUAL,
      }),
      404
    );

    assert.equal(queries.getCallCount(), 1);
    assert.equal(error.message, 'المشروع غير موجود أو لا تملك صلاحية الوصول إليه');
    const authorizationSelect = queries.mock.mock.calls[0].arguments[0].select;
    assert.equal(authorizationSelect.title, undefined);
    assert.equal(authorizationSelect.description, undefined);
    assert.equal(authorizationSelect.requirements, undefined);
  });

  test('client owner is allowed and summary response remains compatible', async context => {
    await assertProjectSummaryAllowed(
      context,
      accessProject({ clientId: ACTOR_ID })
    );
  });

  test('assigned provider is allowed', async context => {
    await assertProjectSummaryAllowed(
      context,
      accessProject({ providerId: ACTOR_ID }),
      { accountType: AccountType.PROVIDER_INDIVIDUAL }
    );
  });

  test('contract client is allowed', async context => {
    await assertProjectSummaryAllowed(
      context,
      accessProject({ contract: { clientId: ACTOR_ID, providerId: OTHER_USER_ID } })
    );
  });

  test('contract provider is allowed', async context => {
    await assertProjectSummaryAllowed(
      context,
      accessProject({ contract: { clientId: OTHER_USER_ID, providerId: ACTOR_ID } }),
      { accountType: AccountType.PROVIDER_INDIVIDUAL }
    );
  });

  test('exact-project proposal owner is allowed', async context => {
    await assertProjectSummaryAllowed(
      context,
      accessProject({ projectProposals: [{ id: 'proposal-fixture' }] }),
      { accountType: AccountType.PROVIDER_INDIVIDUAL }
    );
  });

  test('unrelated users cannot access non-public projects', async context => {
    const queries = mockProjectSummaryQueries(
      context,
      accessProject({ status: ProjectStatus.IN_PROGRESS })
    );

    await expectAppError(
      () => new ProjectService().getProjectSummary(PROJECT_ID, {
        userId: ACTOR_ID,
        accountType: AccountType.PROVIDER_INDIVIDUAL,
      }),
      404
    );
    assert.equal(queries.getCallCount(), 1);
  });

  test('OPEN status alone does not grant a non-provider access', async context => {
    const queries = mockProjectSummaryQueries(
      context,
      accessProject({ status: ProjectStatus.OPEN })
    );
    const specialtyLookup = replaceProxyMethod(
      context,
      prisma.providerProfile as AnyRecord,
      'findUnique',
      async () => approvedMatchingProviderProfile()
    );

    await expectAppError(
      () => new ProjectService().getProjectSummary(PROJECT_ID, {
        userId: ACTOR_ID,
        accountType: AccountType.CLIENT_INDIVIDUAL,
      }),
      404
    );
    assert.equal(queries.getCallCount(), 1);
    assert.equal(specialtyLookup.mock.callCount(), 0);
  });

  test('approved active matching specialty grants OPEN-project access', async context => {
    mockProjectSummaryQueries(
      context,
      accessProject({ status: ProjectStatus.OPEN })
    );
    const specialtyLookup = replaceProxyMethod(
      context,
      prisma.providerProfile as AnyRecord,
      'findUnique',
      async (args: AnyRecord) => {
        assertApprovedSpecialtyQuery(args);
        return approvedMatchingProviderProfile();
      }
    );

    const summary = await new ProjectService().getProjectSummary(PROJECT_ID, {
      userId: ACTOR_ID,
      accountType: AccountType.PROVIDER_INDIVIDUAL,
    });

    assert.equal(summary.id, PROJECT_ID);
    assert.equal(specialtyLookup.mock.callCount(), 1);
    assert.deepEqual(
      specialtyLookup.mock.calls[0].arguments[0].include.providerSpecialties.where,
      {
        isActive: true,
        status: SpecialtyVerificationStatus.APPROVED,
      }
    );
  });

  test('inactive or unapproved specialties are excluded and deny OPEN-project access', async context => {
    const queries = mockProjectSummaryQueries(
      context,
      accessProject({ status: ProjectStatus.OPEN })
    );
    const specialtyLookup = replaceProxyMethod(
      context,
      prisma.providerProfile as AnyRecord,
      'findUnique',
      async (args: AnyRecord) => {
        assertApprovedSpecialtyQuery(args);
        return { providerSpecialties: [] };
      }
    );

    await expectAppError(
      () => new ProjectService().getProjectSummary(PROJECT_ID, {
        userId: ACTOR_ID,
        accountType: AccountType.PROVIDER_INDIVIDUAL,
      }),
      404
    );

    assert.equal(queries.getCallCount(), 1);
    assert.deepEqual(
      specialtyLookup.mock.calls[0].arguments[0].include.providerSpecialties.where,
      {
        isActive: true,
        status: SpecialtyVerificationStatus.APPROVED,
      }
    );
  });

  test('wrong specialty denies OPEN-project access', async context => {
    const queries = mockProjectSummaryQueries(
      context,
      accessProject({ status: ProjectStatus.OPEN })
    );
    replaceProxyMethod(
      context,
      prisma.providerProfile as AnyRecord,
      'findUnique',
      async (args: AnyRecord) => {
        assertApprovedSpecialtyQuery(args);
        return {
          providerSpecialties: [
            {
              specialtyId: 'wrong-specialty',
              subSpecialties: [],
              specialty: { nameAr: 'تصميم داخلي' },
            },
          ],
        };
      }
    );

    await expectAppError(
      () => new ProjectService().getProjectSummary(PROJECT_ID, {
        userId: ACTOR_ID,
        accountType: AccountType.PROVIDER_INDIVIDUAL,
      }),
      404
    );
    assert.equal(queries.getCallCount(), 1);
  });
});

const mockProposalProjectQueries = (
  context: TestContext,
  authorizationResult: AnyRecord,
  detailedResult: AnyRecord = proposalProjectDetails()
) => {
  let callCount = 0;
  const mock = replaceProxyMethod(
    context,
    prisma.project as AnyRecord,
    'findUnique',
    async (args: AnyRecord) => {
      callCount += 1;
      if (callCount === 1) {
        assertActorScopedProjectAuthorizationQuery(args);
        return authorizationResult;
      }
      if (callCount === 2) {
        assertDetailedProjectQuery(args);
        return detailedResult;
      }
      throw new Error('Unexpected additional proposal project query.');
    }
  );
  return { mock, getCallCount: () => callCount };
};

const assertProposalAiAllowed = async (
  context: TestContext,
  authorizationResult: AnyRecord
): Promise<void> => {
  const queries = mockProposalProjectQueries(context, authorizationResult);
  const execution = context.mock.method(
    structuredAiExecutionService as AnyRecord,
    'execute',
    async () => successfulAiResult
  );

  const result = await aiProposalService.evaluateAndSuggestProposal(
    PROJECT_ID,
    ACTOR_ID,
    'عنوان حالي',
    'رسالة حالية',
    ['ميزة']
  );

  assert.deepEqual(result, proposalFeedback);
  assert.equal(queries.getCallCount(), 2);
  assert.equal(execution.mock.callCount(), 1);
};

describe('proposal AI authorization', () => {
  test('route behaviorally enforces account types and DTO validation in the expected order', async () => {
    const handlers = getRouteHandlers(proposalRoutes, '/ai-suggest', 'post');

    assert.equal(handlers[0], authenticate);
    assert.equal(handlers[1], requireActiveUser);
    assert.equal(handlers[3], aiLimiter);
    assert.equal(handlers.at(-1), proposalController.aiSuggest);
    assert.equal(handlers.length, 6);

    for (const accountType of [
      AccountType.PROVIDER_INDIVIDUAL,
      AccountType.PROVIDER_COMPANY,
      AccountType.MARKETING_BROKER,
    ]) {
      const authorization = await invokeMiddleware(
        handlers[2],
        { user: { id: ACTOR_ID, userId: ACTOR_ID, accountType } } as unknown as Request,
        {} as Response
      );
      assert.equal(authorization.nextCalled, true);
      assert.equal(authorization.error, undefined);
    }

    const unauthorized = await invokeMiddleware(
      handlers[2],
      {
        user: {
          id: ACTOR_ID,
          userId: ACTOR_ID,
          accountType: AccountType.CLIENT_INDIVIDUAL,
        },
      } as unknown as Request,
      {} as Response
    );
    assert.equal(unauthorized.nextCalled, true);
    assert.ok(unauthorized.error instanceof AppError);
    assert.equal(unauthorized.error.statusCode, 403);

    const validRequest = { body: { projectId: PROJECT_ID } } as Request;
    const validDto = await invokeMiddleware(handlers[4], validRequest, {} as Response);
    assert.equal(validDto.nextCalled, true);
    assert.equal(validDto.error, undefined);
    assert.deepEqual(validRequest.body, { projectId: PROJECT_ID, advantages: [] });

    const invalidResponse = createResponseRecorder();
    const invalidDto = await invokeMiddleware(
      handlers[4],
      { body: {} } as Request,
      invalidResponse.response
    );
    assert.equal(invalidDto.nextCalled, false);
    assert.equal(invalidResponse.getStatusCode(), 400);
    const invalidBody = invalidResponse.getBody() as AnyRecord;
    assert.equal(invalidBody.success, false);
    assert.equal(
      invalidBody.message,
      'خطأ في التحقق من البيانات المرسلة (Validation Error)'
    );
    assert.equal(invalidBody.errors?.length, 1);
    assert.equal(invalidBody.errors[0].field, 'projectId');
    assert.equal(typeof invalidBody.errors[0].message, 'string');
    assert.ok(invalidBody.errors[0].message.length > 0);
  });

  test('controller uses authenticated actor identity rather than request body', async context => {
    const evaluation = context.mock.method(
      aiProposalService as AnyRecord,
      'evaluateAndSuggestProposal',
      async () => proposalFeedback
    );
    const req = {
      user: { userId: ACTOR_ID, id: ACTOR_ID },
      body: {
        projectId: PROJECT_ID,
        actorUserId: 'body-supplied-user',
        currentTitle: 'عنوان',
        currentMessage: 'رسالة',
        advantages: [],
      },
    } as unknown as Request;
    let responseBody: unknown;
    const res = {
      status(code: number) {
        assert.equal(code, 200);
        return this;
      },
      json(body: unknown) {
        responseBody = body;
        return this;
      },
    } as unknown as Response;
    let nextError: unknown;

    await proposalController.aiSuggest(
      req,
      res,
      ((error?: unknown) => { nextError = error; }) as NextFunction
    );

    assert.equal(nextError, undefined);
    assert.deepEqual(responseBody, {
      success: true,
      message: 'تم تحليل العرض واقتراح التحسينات الذكية بنجاح',
      data: proposalFeedback,
    });
    assert.equal(evaluation.mock.calls[0].arguments[1], ACTOR_ID);
  });

  test('inaccessible project returns 404, fetches no detail context, and executes no AI', async context => {
    const queries = mockProposalProjectQueries(context, accessProject());
    const execution = context.mock.method(
      structuredAiExecutionService as AnyRecord,
      'execute',
      async () => successfulAiResult
    );

    await expectAppError(
      () => aiProposalService.evaluateAndSuggestProposal(PROJECT_ID, ACTOR_ID),
      404
    );

    assert.equal(queries.getCallCount(), 1);
    assert.equal(execution.mock.callCount(), 0);
    const authorizationSelect = queries.mock.mock.calls[0].arguments[0].select;
    assert.equal(authorizationSelect.title, undefined);
    assert.equal(authorizationSelect.description, undefined);
    assert.equal(authorizationSelect.requirements, undefined);
  });

  test('wrong specialty denies access with zero AI executions', async context => {
    const queries = mockProposalProjectQueries(
      context,
      accessProject({ status: ProjectStatus.OPEN })
    );
    replaceProxyMethod(
      context,
      prisma.providerProfile as AnyRecord,
      'findUnique',
      async (args: AnyRecord) => {
        assertApprovedSpecialtyQuery(args);
        return {
          providerSpecialties: [
            {
              specialtyId: 'wrong-specialty',
              subSpecialties: [],
              specialty: { nameAr: 'تصميم داخلي' },
            },
          ],
        };
      }
    );
    const execution = context.mock.method(
      structuredAiExecutionService as AnyRecord,
      'execute',
      async () => successfulAiResult
    );

    await expectAppError(
      () => aiProposalService.evaluateAndSuggestProposal(PROJECT_ID, ACTOR_ID),
      404
    );
    assert.equal(queries.getCallCount(), 1);
    assert.equal(execution.mock.callCount(), 0);
  });

  test('exact-project proposal owner reaches one structured AI execution', async context => {
    await assertProposalAiAllowed(
      context,
      accessProject({ projectProposals: [{ id: 'proposal-fixture' }] })
    );
  });

  test('assigned provider reaches one structured AI execution', async context => {
    await assertProposalAiAllowed(
      context,
      accessProject({ providerId: ACTOR_ID })
    );
  });

  test('contracted provider reaches one structured AI execution', async context => {
    await assertProposalAiAllowed(
      context,
      accessProject({ contract: { providerId: ACTOR_ID } })
    );
  });

  test('approved marketplace provider reaches one structured AI execution', async context => {
    mockProposalProjectQueries(
      context,
      accessProject({ status: ProjectStatus.OPEN })
    );
    const specialtyLookup = replaceProxyMethod(
      context,
      prisma.providerProfile as AnyRecord,
      'findUnique',
      async (args: AnyRecord) => {
        assertApprovedSpecialtyQuery(args);
        return approvedMatchingProviderProfile();
      }
    );
    const execution = context.mock.method(
      structuredAiExecutionService as AnyRecord,
      'execute',
      async () => successfulAiResult
    );

    const result = await aiProposalService.evaluateAndSuggestProposal(
      PROJECT_ID,
      ACTOR_ID
    );

    assert.deepEqual(result, proposalFeedback);
    assert.equal(specialtyLookup.mock.callCount(), 1);
    assert.equal(execution.mock.callCount(), 1);
  });
});

const invokeActiveUserMiddleware = (user?: AnyRecord) => {
  const req = { user } as unknown as Request;
  const res = {} as Response;
  let called = false;
  let error: unknown;

  requireActiveUser(
    req,
    res,
    ((nextError?: unknown) => {
      called = true;
      error = nextError;
    }) as NextFunction
  );

  return { called, error };
};

describe('client request AI active-user enforcement', () => {
  test('route middleware order is authenticate, active-user, limiter, controller', () => {
    assert.deepEqual(
      getRouteHandlers(clientRequestRoutes, '/ai-suggest', 'post'),
      [authenticate, requireActiveUser, aiLimiter, clientRequestsController.aiSuggest]
    );
  });

  test('unauthenticated user is denied by the actual authenticate middleware with 401', async () => {
    const result = await invokeMiddleware(
      authenticate,
      { headers: {} } as Request,
      {} as Response
    );
    assert.equal(result.nextCalled, true);
    assert.ok(result.error instanceof AppError);
    assert.equal(result.error.statusCode, 401);
  });

  test('pending-verification user is denied with 403', () => {
    const result = invokeActiveUserMiddleware({
      id: ACTOR_ID,
      status: UserStatus.PENDING_VERIFICATION,
    });
    assert.ok(result.error instanceof AppError);
    assert.equal(result.error.statusCode, 403);
  });

  test('suspended user is denied with 403', () => {
    const result = invokeActiveUserMiddleware({
      id: ACTOR_ID,
      status: UserStatus.SUSPENDED,
    });
    assert.ok(result.error instanceof AppError);
    assert.equal(result.error.statusCode, 403);
  });

  test('active authenticated user can proceed', () => {
    const result = invokeActiveUserMiddleware({
      id: ACTOR_ID,
      status: UserStatus.ACTIVE,
    });
    assert.equal(result.called, true);
    assert.equal(result.error, undefined);
  });

  test('actual active-user and controller chain stops inactive users and permits active users', async context => {
    const handlers = getRouteHandlers(clientRequestRoutes, '/ai-suggest', 'post');
    const activeUserGuard = handlers[1];
    const downstreamController = handlers[3];
    const execution = context.mock.method(
      clientRequestsService as AnyRecord,
      'generateAiSuggest',
      async () => ({ suggestions: [] })
    );

    const runGuardAndController = async (status: UserStatus) => {
      const req = {
        user: { id: ACTOR_ID, userId: ACTOR_ID, status },
        body: {},
      } as unknown as Request;
      const response = createResponseRecorder();
      let nextError: unknown;
      let controllerPromise: Promise<unknown> | undefined;

      activeUserGuard(
        req,
        response.response,
        ((error?: unknown) => {
          if (error) {
            nextError = error;
            return;
          }
          controllerPromise = Promise.resolve(downstreamController(
            req,
            response.response,
            ((controllerError?: unknown) => {
              nextError = controllerError;
            }) as NextFunction
          ));
        }) as NextFunction
      );

      await controllerPromise;
      return { nextError, response };
    };

    const inactive = await runGuardAndController(UserStatus.SUSPENDED);
    assert.ok(inactive.nextError instanceof AppError);
    assert.equal(inactive.nextError.statusCode, 403);
    assert.equal(execution.mock.callCount(), 0);

    const active = await runGuardAndController(UserStatus.ACTIVE);
    assert.equal(active.nextError, undefined);
    assert.equal(execution.mock.callCount(), 1);
    assert.equal(active.response.getStatusCode(), 200);
    assert.deepEqual(active.response.getBody(), {
      success: true,
      data: { suggestions: [] },
    });
  });
});
