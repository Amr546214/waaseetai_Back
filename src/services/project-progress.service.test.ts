import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Phase 3D.3A: reviewDelivery()'s final-stage-completion branch already
// created a +50 PointTransaction and mirrored totalPoints onto
// User.currentPoints and ProviderGamification.points/completedProjects. It
// now ALSO derives and persists ProviderGamification.avgRating (sourced from
// a live Review aggregate, same as gamification.service.ts#getLevelDetails)
// and currentLevelIndex/currentCommission (via the shared pure
// deriveProviderProgression helper) — all inside the SAME existing
// transaction, with NO change to the financial/project/escrow behavior or
// the existing contract-completion idempotency guard.

function createReviewDeliveryMockPrisma(t: TestContext, opts: {
  completedProjectsCount?: number;
  avgRating?: number | null;
  seedPointTransactions?: number[];
  nextStage?: any;
} = {}) {
  const contract = {
    id: 'contract-1',
    projectId: 'project-1',
    providerId: 'provider-1',
    clientId: 'client-1',
    price: 1000,
    status: 'ACTIVE',
    project: { title: 'مشروع تجريبي' },
    provider: { firstName: 'Okasha', lastName: 'Expert', email: 'provider@example.com' }
  };
  const stage = {
    id: 'stage-1',
    contractId: 'contract-1',
    stepOrder: 1,
    status: 'SUBMITTED',
    deliveries: [{ id: 'delivery-1', status: 'SUBMITTED' }]
  };

  const pointTransactions: any[] = (opts.seedPointTransactions || []).map((amount, i) => ({
    id: `seed-${i}`, providerId: 'provider-1', amount, reason: 'SEED', description: 'seed'
  }));
  let userState: any = { id: 'provider-1', currentPoints: 0 };
  let gamificationState: any = null;
  // Simulates the real DB-level race window the `tx.contract.updateMany`
  // guard protects against: the OUTER pre-check (prisma.contract.findFirst)
  // always sees 'ACTIVE' (as it would mid-race), but a concurrent/retried
  // transaction has already flipped the row in the DB by the time the
  // IN-TRANSACTION guard runs.
  let dbAlreadyCompleted = false;

  const pointTransactionCreateSpy = t.mock.fn((args: any) => {
    const row = { id: `pt-${pointTransactions.length + 1}`, ...args.data };
    pointTransactions.push(row);
    return row;
  });
  const userUpdateSpy = t.mock.fn((args: any) => { userState = { ...userState, ...args.data }; return { ...userState }; });
  const gamificationUpsertSpy = t.mock.fn((args: any) => {
    gamificationState = gamificationState ? { ...gamificationState, ...args.update } : { ...args.create };
    return { ...gamificationState };
  });
  const gamificationRuleUpsertSpy = t.mock.fn(async () => ({}));
  const contractUpdateManySpy = t.mock.fn(async () => {
    if (dbAlreadyCompleted) return { count: 0 };
    dbAlreadyCompleted = true;
    return { count: 1 };
  });
  const escrowUpdateManySpy = t.mock.fn(async () => ({ count: 1 }));
  const clientRequestUpdateManySpy = t.mock.fn(async () => ({ count: 1 }));
  const projectUpdateSpy = t.mock.fn(async () => ({}));

  const tx = {
    stageDelivery: { update: t.mock.fn(async () => ({})) },
    projectStage: {
      update: t.mock.fn(async () => ({})),
      findFirst: async () => opts.nextStage ?? null
    },
    project: {
      update: projectUpdateSpy,
      count: async () => opts.completedProjectsCount ?? 1
    },
    escrow: { updateMany: escrowUpdateManySpy },
    clientRequest: { updateMany: clientRequestUpdateManySpy },
    contract: { updateMany: contractUpdateManySpy },
    pointTransaction: {
      create: pointTransactionCreateSpy,
      aggregate: async () => ({ _sum: { amount: pointTransactions.reduce((sum, p) => sum + p.amount, 0) } })
    },
    review: {
      aggregate: async () => ({ _avg: { rating: opts.avgRating === undefined ? null : opts.avgRating } })
    },
    user: { update: userUpdateSpy },
    providerGamification: { upsert: gamificationUpsertSpy },
    gamificationRule: { upsert: gamificationRuleUpsertSpy },
    notification: { create: async () => ({ id: 'notif-1' }) }
  };

  const prismaMock = {
    contract: { findFirst: async () => ({ ...contract }) },
    projectStage: { findFirst: async () => ({ ...stage }) },
    $transaction: async (fn: any) => fn(tx)
  };

  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { emitStored: async () => {} } } });
  t.mock.module('./email.service', { namedExports: { emailService: { sendProjectCompletionRewardEmail: async () => {} } } });

  return {
    pointTransactionCreateSpy, userUpdateSpy, gamificationUpsertSpy, gamificationRuleUpsertSpy,
    contractUpdateManySpy, escrowUpdateManySpy, clientRequestUpdateManySpy, projectUpdateSpy,
    getPointTransactions: () => pointTransactions,
    getUserState: () => userState,
    getGamificationState: () => gamificationState
  };
}

async function loadProjectProgressServiceWithFixture(t: TestContext, opts: Parameters<typeof createReviewDeliveryMockPrisma>[1] = {}) {
  const mocks = createReviewDeliveryMockPrisma(t, opts);
  const moduleUrl = `./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { projectProgressService } = await import(moduleUrl);
  return { projectProgressService, ...mocks };
}

test('reviewDelivery (final stage, approve): creates the +50 PointTransaction exactly once', async (t) => {
  const { projectProgressService, pointTransactionCreateSpy, getPointTransactions } = await loadProjectProgressServiceWithFixture(t);

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(pointTransactionCreateSpy.mock.callCount(), 1);
  assert.equal(getPointTransactions().length, 1);
  assert.equal(getPointTransactions()[0].amount, 50);
  assert.equal(getPointTransactions()[0].reason, 'PROJECT_COMPLETED');
});

test('reviewDelivery: the existing contract-completion idempotency guard still prevents a duplicate award on a racing/retried call', async (t) => {
  const { projectProgressService, pointTransactionCreateSpy, contractUpdateManySpy } = await loadProjectProgressServiceWithFixture(t);

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');
  assert.equal(pointTransactionCreateSpy.mock.callCount(), 1);

  await assert.rejects(
    () => projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve'),
    /مسبقاً/
  );
  // The guard rejected before a second point award could ever be created.
  assert.equal(pointTransactionCreateSpy.mock.callCount(), 1);
  assert.equal(contractUpdateManySpy.mock.callCount(), 2);
});

test('reviewDelivery: total points are derived from the PointTransaction ledger aggregate, including pre-existing rows', async (t) => {
  const { projectProgressService, getUserState, getGamificationState } = await loadProjectProgressServiceWithFixture(t, {
    seedPointTransactions: [20]
  });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(getUserState().currentPoints, 70); // 20 seeded + 50 awarded
  assert.equal(getGamificationState().points, 70);
});

test('reviewDelivery: completedProjects is sourced from the authoritative Project count, not a running counter', async (t) => {
  const { projectProgressService, getGamificationState } = await loadProjectProgressServiceWithFixture(t, {
    completedProjectsCount: 7
  });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(getGamificationState().completedProjects, 7);
});

test('reviewDelivery: avgRating is sourced from the live Review aggregate (same source getLevelDetails uses)', async (t) => {
  const { projectProgressService, getGamificationState } = await loadProjectProgressServiceWithFixture(t, {
    avgRating: 4.5
  });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(getGamificationState().avgRating, 4.5);
});

test('reviewDelivery: ProviderGamification persists points, completedProjects, avgRating, currentLevelIndex and currentCommission together, consistently', async (t) => {
  const { projectProgressService, getGamificationState } = await loadProjectProgressServiceWithFixture(t, {
    completedProjectsCount: 2,
    avgRating: 3.5,
    seedPointTransactions: [0] // total after award = 50, exactly level 2's reqPoints
  });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  const state = getGamificationState();
  assert.equal(state.points, 50);
  assert.equal(state.completedProjects, 2);
  assert.equal(state.avgRating, 3.5);
  // Level 2 requires points>=50, completedProjects>=2, avgRating>=3.5 — all exactly met.
  assert.equal(state.currentLevelIndex, 2);
  assert.equal(state.currentCommission, 15.0);
});

test('reviewDelivery: the existing User.currentPoints compatibility mirror is unchanged (still written, still from the ledger total)', async (t) => {
  const { projectProgressService, userUpdateSpy, getUserState } = await loadProjectProgressServiceWithFixture(t);

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(userUpdateSpy.mock.callCount(), 1);
  assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.currentPoints, 50);
  assert.equal(getUserState().currentPoints, 50);
  // No legacy currentLevel/pointsToNextLevel write introduced.
  assert.equal('currentLevel' in userUpdateSpy.mock.calls[0].arguments[0].data, false);
  assert.equal('pointsToNextLevel' in userUpdateSpy.mock.calls[0].arguments[0].data, false);
});

test('reviewDelivery: financial/project/escrow writes remain behaviorally unchanged', async (t) => {
  const { projectProgressService, escrowUpdateManySpy, clientRequestUpdateManySpy, projectUpdateSpy, contractUpdateManySpy } =
    await loadProjectProgressServiceWithFixture(t);

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(contractUpdateManySpy.mock.callCount(), 1);
  assert.equal(escrowUpdateManySpy.mock.callCount(), 1);
  assert.equal(escrowUpdateManySpy.mock.calls[0].arguments[0].data.status, 'RELEASED');
  assert.equal(escrowUpdateManySpy.mock.calls[0].arguments[0].data.releasedAmount, 1000);
  assert.equal(clientRequestUpdateManySpy.mock.callCount(), 1);
  assert.equal(clientRequestUpdateManySpy.mock.calls[0].arguments[0].data.status, 'COMPLETED');
  const projectCompletionCall = projectUpdateSpy.mock.calls.find((c: any) => c.arguments[0].data.status === 'COMPLETED');
  assert.notEqual(projectCompletionCall, undefined);
});

test('regression: revision decision does not touch points/gamification at all', async (t) => {
  const { projectProgressService, pointTransactionCreateSpy, gamificationUpsertSpy, userUpdateSpy } =
    await loadProjectProgressServiceWithFixture(t);

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'revision', 'يرجى تعديل التصميم من فضلك');

  assert.equal(pointTransactionCreateSpy.mock.callCount(), 0);
  assert.equal(gamificationUpsertSpy.mock.callCount(), 0);
  assert.equal(userUpdateSpy.mock.callCount(), 0);
});

// ============================================================================
// "مراجعة التسليم" feature — pending-review ownership/idempotency regression
// coverage (existing guards, verified not weakened by this change).
// ============================================================================

async function loadProjectProgressServiceWithCustomPrisma(t: TestContext, prismaMock: any) {
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { emitStored: async () => {} } } });
  t.mock.module('./email.service', { namedExports: { emailService: { sendProjectCompletionRewardEmail: async () => {} } } });
  const moduleUrl = `./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { projectProgressService } = await import(moduleUrl);
  return projectProgressService;
}

test('reviewDelivery: a provider (or any non-owning caller) can never match the client-scoped contract lookup', async (t) => {
  const findFirstSpy = t.mock.fn(async (args: any) => (args.where.clientId === 'real-client' ? {
    id: 'contract-1', projectId: 'project-1', providerId: 'provider-1', clientId: 'real-client', price: 1000, status: 'ACTIVE',
    project: { title: 'مشروع' }, provider: { firstName: 'م', lastName: '', email: 'p@example.com' }
  } : null));
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, { contract: { findFirst: findFirstSpy } });

  // Caller id ('provider-1' — e.g. the provider trying to hit the client's own approval endpoint) never matches.
  await assert.rejects(
    () => projectProgressService.reviewDelivery('provider-1', 'contract-1', 'stage-1', 'approve'),
    /لا تملك صلاحية المراجعة/
  );
  assert.equal(findFirstSpy.mock.callCount(), 1);
  assert.equal(findFirstSpy.mock.calls[0].arguments[0].where.clientId, 'provider-1');
});

test('reviewDelivery: the real owning client DOES pass the ownership check (proceeds to the stage lookup, not rejected as unauthorized)', async (t) => {
  const findFirstSpy = t.mock.fn(async (args: any) => (args.where.clientId === 'real-client' ? {
    id: 'contract-1', projectId: 'project-1', providerId: 'provider-1', clientId: 'real-client', price: 1000, status: 'ACTIVE',
    project: { title: 'مشروع' }, provider: { firstName: 'م', lastName: '', email: 'p@example.com' }
  } : null));
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, {
    contract: { findFirst: findFirstSpy },
    projectStage: { findFirst: async () => null }
  });

  // Fails later for an unrelated reason (no matching stage in this fixture) — proving ownership itself was NOT what rejected it.
  await assert.rejects(
    () => projectProgressService.reviewDelivery('real-client', 'contract-1', 'stage-1', 'approve'),
    /لا يوجد تسليم جديد بانتظار المراجعة/
  );
});

test('reviewDelivery: an already-approved stage (not just a mid-transaction race) is rejected before any write, with no ambiguity', async (t) => {
  const contract = {
    id: 'contract-1', projectId: 'project-1', providerId: 'provider-1', clientId: 'client-1', price: 1000, status: 'ACTIVE',
    project: { title: 'مشروع' }, provider: { firstName: 'م', lastName: '', email: 'p@example.com' }
  };
  const transactionSpy = t.mock.fn(async (fn: any) => fn({}));
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, {
    contract: { findFirst: async () => ({ ...contract }) },
    // Stage already APPROVED from a prior successful approval — the exact state a second click would see.
    projectStage: { findFirst: async () => ({ id: 'stage-1', contractId: 'contract-1', stepOrder: 1, status: 'APPROVED', deliveries: [{ id: 'delivery-1', status: 'APPROVED' }] }) },
    $transaction: transactionSpy
  });

  await assert.rejects(
    () => projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve'),
    /لا يوجد تسليم جديد بانتظار المراجعة/
  );
  // Rejected before the transaction (and therefore before any escrow/points write) ever runs.
  assert.equal(transactionSpy.mock.callCount(), 0);
});

// ============================================================================
// getPendingReviewDeliveries — "مراجعة التسليم" list source.
// ============================================================================

function stageFixture(overrides: Partial<any> = {}) {
  return {
    id: 'stage-1', stepOrder: 2, title: 'الهوية الكاملة', amount: 1500, status: 'SUBMITTED',
    contract: { id: 'contract-abcdef123', projectId: 'project-1', project: { title: 'مشروع تجريبي' }, provider: { firstName: 'نورة', lastName: 'التصميم' } },
    deliveries: [{ id: 'delivery-1', status: 'SUBMITTED', submittedAt: new Date('2026-01-01T00:00:00Z'), files: ['a.png', 'b.pdf'] }],
    ...overrides
  };
}

test('getPendingReviewDeliveries: returns real project/stage/provider/file metadata for a genuinely reviewable stage', async (t) => {
  const findManySpy = t.mock.fn(async () => [stageFixture()]);
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, { projectStage: { findMany: findManySpy } });

  const result = await projectProgressService.getPendingReviewDeliveries('client-1');

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    projectId: 'project-1',
    projectTitle: 'مشروع تجريبي',
    stageId: 'stage-1',
    stageNumber: 2,
    stageTitle: 'الهوية الكاملة',
    amount: 1500,
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    providerName: 'نورة التصميم',
    filesCount: 2,
    contractRef: 'CT-CONTRA'
  });
});

test('getPendingReviewDeliveries: filters the query to the calling client\'s ACTIVE contracts and SUBMITTED stages only (never another client\'s data)', async (t) => {
  const findManySpy = t.mock.fn(async () => []);
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, { projectStage: { findMany: findManySpy } });

  await projectProgressService.getPendingReviewDeliveries('client-1');

  assert.equal(findManySpy.mock.callCount(), 1);
  const where = findManySpy.mock.calls[0].arguments[0].where;
  assert.equal(where.status, 'SUBMITTED');
  assert.equal(where.contract.clientId, 'client-1');
  assert.equal(where.contract.status, 'ACTIVE');
});

test('getPendingReviewDeliveries: excludes a SUBMITTED stage whose latest delivery is no longer SUBMITTED (stale/already-decided)', async (t) => {
  const stale = stageFixture({ deliveries: [{ id: 'delivery-1', status: 'APPROVED', submittedAt: new Date(), files: [] }] });
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, { projectStage: { findMany: async () => [stale] } });

  const result = await projectProgressService.getPendingReviewDeliveries('client-1');

  assert.deepEqual(result, []);
});

test('getPendingReviewDeliveries: a stage with no delivery rows at all is excluded, not crashed on', async (t) => {
  const noDelivery = stageFixture({ deliveries: [] });
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, { projectStage: { findMany: async () => [noDelivery] } });

  const result = await projectProgressService.getPendingReviewDeliveries('client-1');

  assert.deepEqual(result, []);
});

test('getPendingReviewDeliveries: no pending deliveries returns a clean empty array', async (t) => {
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, { projectStage: { findMany: async () => [] } });

  const result = await projectProgressService.getPendingReviewDeliveries('client-1');

  assert.deepEqual(result, []);
});

test('getPendingReviewDeliveries: a stage with delivery history (revision cycle) never produces duplicate pending-list items — only the current/latest reviewable delivery is used', async (t) => {
  // Prisma's own `orderBy`/`take: 1` (asserted below) means the service never
  // actually receives more than one delivery per stage in `deliveries` — it
  // already IS the newest one, regardless of how many historical
  // StageDelivery rows exist for that stage after a revision-and-resubmit
  // cycle. This fixture reflects that real query contract, not an
  // impossible multi-row `deliveries` array the service would never see.
  const latestOfMany = stageFixture({
    deliveries: [{ id: 'delivery-3', status: 'SUBMITTED', submittedAt: new Date('2026-02-01T00:00:00Z'), files: ['final-1.png', 'final-2.png', 'final-3.png'] }]
  });
  const findManySpy = t.mock.fn(async () => [latestOfMany]);
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, { projectStage: { findMany: findManySpy } });

  const result = await projectProgressService.getPendingReviewDeliveries('client-1');

  // One ProjectStage row in the DB -> exactly one list item, never duplicated
  // by how many StageDelivery rows that stage has accumulated over time.
  assert.equal(result.length, 1);
  assert.equal(result[0].stageId, 'stage-1');
  // Uses the current/latest resubmission's own data, not an earlier attempt.
  assert.deepEqual(result[0].submittedAt, new Date('2026-02-01T00:00:00Z'));
  assert.equal(result[0].filesCount, 3);
});

test('getPendingReviewDeliveries: the Prisma query requests only the newest delivery (orderBy submittedAt desc, take 1) — regression guard against stale delivery metadata', async (t) => {
  const findManySpy = t.mock.fn(async () => [stageFixture()]);
  const projectProgressService = await loadProjectProgressServiceWithCustomPrisma(t, { projectStage: { findMany: findManySpy } });

  const result = await projectProgressService.getPendingReviewDeliveries('client-1');

  const deliveriesArg = findManySpy.mock.calls[0].arguments[0].include.deliveries;
  assert.deepEqual(deliveriesArg.orderBy, { submittedAt: 'desc' });
  assert.equal(deliveriesArg.take, 1);

  // The returned item's submittedAt/filesCount are read from exactly the
  // delivery that ordering/take selected (stageFixture()'s single delivery) —
  // if orderBy/take were ever removed from the real query, this is the
  // metadata that would silently go stale for a multi-delivery stage.
  assert.deepEqual(result[0].submittedAt, new Date('2026-01-01T00:00:00Z'));
  assert.equal(result[0].filesCount, 2);
});
