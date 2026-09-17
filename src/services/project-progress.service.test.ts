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
