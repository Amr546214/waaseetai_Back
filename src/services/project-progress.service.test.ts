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
  // Simulates the exact DB-level race window Batch 1's stage-approval fix
  // protects: the OUTER pre-check (prisma.projectStage.findFirst) always
  // sees SUBMITTED (as it would mid-race, since it runs before either
  // transaction starts), but a concurrent/already-committed transaction has
  // already flipped the row to APPROVED by the time the IN-TRANSACTION
  // conditional updateMany runs.
  dbStageAlreadyApproved?: boolean;
  // P-LG-012 affiliate commission engine fixtures — all default to "nothing
  // qualifies" (no active dispute, no matching referral) so every
  // pre-existing test above, which never sets these, exercises zero
  // commission-engine reads/writes even when the flag happens to be on.
  disputeActive?: boolean;
  referrals?: any[];
  commissionCreateImpl?: (args: any) => any;
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
    title: 'المرحلة الأولى',
    amount: 100,
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
  const stageDeliveryUpdateSpy = t.mock.fn(async () => ({}));
  const accountAuditLogCreateSpy = t.mock.fn(async () => ({ id: 'audit-1' }));
  const projectStageUpdateManySpy = t.mock.fn(async () => (opts.dbStageAlreadyApproved ? { count: 0 } : { count: 1 }));

  // P-LG-012 affiliate commission engine mocks — only ever reached when
  // AFFILIATE_COMMISSION_ENGINE_ENABLED === 'true' (createCommissionsForStageReleaseEvent
  // returns before touching any of these otherwise).
  const disputeFindFirstSpy = t.mock.fn(async () => (opts.disputeActive ? { id: 'dispute-1' } : null));
  const referralFindManySpy = t.mock.fn(async () => opts.referrals ?? []);
  const commissionLogs: any[] = [];
  const commissionLogCreateSpy = t.mock.fn(async (args: any) => {
    if (opts.commissionCreateImpl) return opts.commissionCreateImpl(args);
    const row = { id: `commission-${commissionLogs.length + 1}`, ...args.data };
    commissionLogs.push(row);
    return row;
  });

  const tx = {
    stageDelivery: { update: stageDeliveryUpdateSpy },
    projectStage: {
      // The current-stage SUBMITTED -> APPROVED/REVISION_REQUESTED
      // transition (Batch 1's race fix) — conditional, via updateMany.
      updateMany: projectStageUpdateManySpy,
      // Only used for the NEXT stage's SUBMITTED -> IN_PROGRESS transition
      // (a different row, unconditional — unaffected by this fix).
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
    accountAuditLog: { create: accountAuditLogCreateSpy },
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
    notification: { create: async () => ({ id: 'notif-1' }) },
    dispute: { findFirst: disputeFindFirstSpy },
    referral: { findMany: referralFindManySpy },
    commissionLog: { create: commissionLogCreateSpy }
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
    stageDeliveryUpdateSpy, accountAuditLogCreateSpy, projectStageUpdateManySpy,
    disputeFindFirstSpy, referralFindManySpy, commissionLogCreateSpy,
    getPointTransactions: () => pointTransactions,
    getUserState: () => userState,
    getGamificationState: () => gamificationState,
    getCommissionLogs: () => commissionLogs
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
    completedProjectsCount: 3,
    avgRating: 3.5,
    seedPointTransactions: [51] // total after award = 101, exactly level 2's reqPoints
  });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  const state = getGamificationState();
  assert.equal(state.points, 101);
  assert.equal(state.completedProjects, 3);
  assert.equal(state.avgRating, 3.5);
  // Level 2 requires points>=101, completedProjects>=3, avgRating>=3.5 — all exactly met.
  assert.equal(state.currentLevelIndex, 2);
  assert.equal(state.currentCommission, 4.8);
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

// ============================================================================
// Financial Safety Batch 1, item 1 — intermediate ProjectStage approval race
// (double-increment of Escrow.releasedAmount) + item 4 — stage-release
// audit trail.
// ============================================================================

test('reviewDelivery (intermediate stage, approve): releases stage.amount exactly once', async (t) => {
  const nextStage = { id: 'stage-2' };
  const { projectProgressService, escrowUpdateManySpy, contractUpdateManySpy, projectStageUpdateManySpy } =
    await loadProjectProgressServiceWithFixture(t, { nextStage });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  // The intermediate path releases via increment, never touches Contract
  // completion, and the conditional stage transition ran exactly once.
  assert.equal(projectStageUpdateManySpy.mock.callCount(), 1);
  assert.deepEqual(projectStageUpdateManySpy.mock.calls[0].arguments[0].where, { id: 'stage-1', status: 'SUBMITTED' });
  assert.equal(escrowUpdateManySpy.mock.callCount(), 1);
  assert.deepEqual(escrowUpdateManySpy.mock.calls[0].arguments[0].data, { releasedAmount: { increment: 100 } });
  assert.equal(contractUpdateManySpy.mock.callCount(), 0);
});

test('reviewDelivery (intermediate stage, approve): an already-approved stage cannot release again — the conditional updateMany matches zero rows and no financial write happens', async (t) => {
  const nextStage = { id: 'stage-2' };
  const { projectProgressService, escrowUpdateManySpy, stageDeliveryUpdateSpy, accountAuditLogCreateSpy, projectStageUpdateManySpy } =
    await loadProjectProgressServiceWithFixture(t, { nextStage, dbStageAlreadyApproved: true });

  await assert.rejects(
    () => projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve'),
    /لا يوجد تسليم جديد بانتظار المراجعة/
  );

  // The guard ran (and lost), but nothing downstream of it ever executed:
  // no StageDelivery transition, no escrow release, no audit entry. This is
  // the atomicity property from item 4 in miniature — everything after the
  // failed conditional update is provably never reached.
  assert.equal(projectStageUpdateManySpy.mock.callCount(), 1);
  assert.equal(stageDeliveryUpdateSpy.mock.callCount(), 0);
  assert.equal(escrowUpdateManySpy.mock.callCount(), 0);
  assert.equal(accountAuditLogCreateSpy.mock.callCount(), 0);
});

test('reviewDelivery (intermediate stage, approve): two concurrent approval requests for the same stage — only the one that wins the conditional transition releases escrow, the other gets the conflict error with zero side effects', async (t) => {
  // A mocked $transaction cannot reproduce Postgres's actual row-lock/
  // re-evaluate-on-unblock behavior, so this proves the CODE-LEVEL contract
  // that behavior depends on: whichever call's projectStage.updateMany sees
  // status still SUBMITTED proceeds and releases exactly once; whichever
  // call sees it already APPROVED (simulating having lost the real DB race)
  // takes zero further action. Two DISTINCT loaded instances simulate the
  // two requests, one already-won and one already-lost, run concurrently
  // via Promise.allSettled — proving the "loser" path in isolation cannot
  // itself cause a second release, which is the actual invariant at risk.
  const nextStage = { id: 'stage-2' };
  // t.mock.module() can only mock a given path once per TestContext, so the
  // two independently-loaded module instances each need their own
  // sub-TestContext (node:test's mock tracker is per-context) — run as two
  // concurrent subtests rather than two loads under the same `t`.
  let winner: Awaited<ReturnType<typeof loadProjectProgressServiceWithFixture>>;
  let loser: Awaited<ReturnType<typeof loadProjectProgressServiceWithFixture>>;
  let winnerResult: PromiseSettledResult<unknown>;
  let loserResult: PromiseSettledResult<unknown>;

  await Promise.all([
    t.test('winner', async (t2) => {
      winner = await loadProjectProgressServiceWithFixture(t2, { nextStage, dbStageAlreadyApproved: false });
      [winnerResult] = await Promise.allSettled([winner.projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve')]);
    }),
    t.test('loser', async (t2) => {
      loser = await loadProjectProgressServiceWithFixture(t2, { nextStage, dbStageAlreadyApproved: true });
      [loserResult] = await Promise.allSettled([loser.projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve')]);
    })
  ]);

  assert.equal(winnerResult!.status, 'fulfilled');
  assert.equal(loserResult!.status, 'rejected');
  assert.equal(winner!.escrowUpdateManySpy.mock.callCount(), 1);
  assert.equal(loser!.escrowUpdateManySpy.mock.callCount(), 0);
  assert.equal(winner!.accountAuditLogCreateSpy.mock.callCount(), 1);
  assert.equal(loser!.accountAuditLogCreateSpy.mock.callCount(), 0);
});

test('reviewDelivery (intermediate stage, approve): writes a durable AccountAuditLog entry correlating project/contract/stage/amount/approving client, in the same transaction as the escrow release', async (t) => {
  const nextStage = { id: 'stage-2' };
  const { projectProgressService, accountAuditLogCreateSpy } = await loadProjectProgressServiceWithFixture(t, { nextStage });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(accountAuditLogCreateSpy.mock.callCount(), 1);
  const entry = accountAuditLogCreateSpy.mock.calls[0].arguments[0].data;
  assert.equal(entry.userId, 'provider-1');
  assert.equal(entry.eventType, 'STAGE_FUND_RELEASED');
  assert.equal(entry.category, 'SYSTEM_AUDIT');
  assert.equal(entry.metaData.projectId, 'project-1');
  assert.equal(entry.metaData.contractId, 'contract-1');
  assert.equal(entry.metaData.stageId, 'stage-1');
  assert.equal(entry.metaData.releasedAmount, 100);
  assert.equal(entry.metaData.currency, 'USD');
  assert.equal(entry.metaData.isFinalStage, false);
  assert.equal(entry.metaData.approvedByClientId, 'client-1');
});

test('reviewDelivery (final stage, approve): the existing contract-completion protection is unweakened by the stage-level fix, and also writes a final-stage audit entry', async (t) => {
  const { projectProgressService, contractUpdateManySpy, escrowUpdateManySpy, accountAuditLogCreateSpy, projectStageUpdateManySpy } =
    await loadProjectProgressServiceWithFixture(t); // no nextStage -> final-stage branch, as every pre-existing test in this file already exercises

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(projectStageUpdateManySpy.mock.callCount(), 1);
  assert.equal(contractUpdateManySpy.mock.callCount(), 1);
  assert.equal(escrowUpdateManySpy.mock.callCount(), 1);
  assert.equal(escrowUpdateManySpy.mock.calls[0].arguments[0].data.status, 'RELEASED');
  assert.equal(accountAuditLogCreateSpy.mock.callCount(), 1);
  assert.equal(accountAuditLogCreateSpy.mock.calls[0].arguments[0].data.metaData.isFinalStage, true);
});

test('reviewDelivery (intermediate stage, revision): an already-approved stage cannot be reverted to REVISION_REQUESTED by a racing revision request either — same conditional guard applied to both decision branches', async (t) => {
  const { projectProgressService, projectStageUpdateManySpy, escrowUpdateManySpy } =
    await loadProjectProgressServiceWithFixture(t, { dbStageAlreadyApproved: true });

  await assert.rejects(
    () => projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'revision', 'يرجى تعديل التصميم من فضلك'),
    /لا يوجد تسليم جديد بانتظار المراجعة/
  );
  assert.equal(projectStageUpdateManySpy.mock.callCount(), 1);
  assert.equal(escrowUpdateManySpy.mock.callCount(), 0);
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

// ============================================================================
// P-LG-012 affiliate commission engine — hook wired into reviewDelivery()'s
// approve path, at both the intermediate-stage and final-stage escrow
// release points, inside the SAME transaction. Gated behind
// AFFILIATE_COMMISSION_ENGINE_ENABLED (default OFF — see
// affiliate-commission-engine.util.ts for the flag
// reasoning this default protects).
// ============================================================================

function withCommissionEngineFlag(t: TestContext, value: 'true' | undefined) {
  const previous = process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED;
  if (value === undefined) delete process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED;
  else process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED = value;
  t.after(() => {
    if (previous === undefined) delete process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED;
    else process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED = previous;
  });
}

function referralFixture(overrides: any = {}) {
  return {
    id: 'referral-1',
    referredUserId: 'client-1',
    affiliate: { id: 'affiliate-1', level: 3, userId: 'affiliate-user-1' },
    ...overrides
  };
}

test('commission engine (flag disabled, the default): reviewDelivery never reads or writes anything commission-related', async (t) => {
  withCommissionEngineFlag(t, undefined);
  const { projectProgressService, disputeFindFirstSpy, referralFindManySpy, commissionLogCreateSpy } =
    await loadProjectProgressServiceWithFixture(t, { referrals: [referralFixture()] });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(disputeFindFirstSpy.mock.callCount(), 0);
  assert.equal(referralFindManySpy.mock.callCount(), 0);
  assert.equal(commissionLogCreateSpy.mock.callCount(), 0);
});

test('commission engine (flag explicitly "false"): still a complete no-op — only the literal string \'true\' opens the gate', async (t) => {
  withCommissionEngineFlag(t, undefined);
  process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED = 'false';
  const { projectProgressService, commissionLogCreateSpy } =
    await loadProjectProgressServiceWithFixture(t, { referrals: [referralFixture()] });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(commissionLogCreateSpy.mock.callCount(), 0);
});

test('commission engine (flag enabled, final stage): creates exactly one APPROVED, USD CommissionLog for the referred client, computed from stage.amount and the affiliate\'s level percentage', async (t) => {
  withCommissionEngineFlag(t, 'true');
  const { projectProgressService, commissionLogCreateSpy, getCommissionLogs } =
    await loadProjectProgressServiceWithFixture(t, { referrals: [referralFixture({ affiliate: { id: 'affiliate-1', level: 3, userId: 'affiliate-user-1' } })] });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(commissionLogCreateSpy.mock.callCount(), 1);
  const data = getCommissionLogs()[0];
  assert.equal(data.affiliateId, 'affiliate-1');
  assert.equal(data.referralId, 'referral-1');
  assert.equal(data.referredUserId, 'client-1');
  assert.equal(data.type, 'STAGE_RELEASE');
  assert.equal(data.currency, 'USD'); // USD
  assert.equal(data.status, 'APPROVED');
  assert.equal(data.baseAmount, 100); // this fixture's final-stage stage.amount
  assert.equal(data.appliedPercentage, 1.5); // level 3 = 'موصل' = 1.50% per P-LG-012
  assert.equal(data.level, 3);
  assert.equal(data.amount, 1.5); // 100 * 1.5%
  assert.equal(data.sourceProjectId, 'project-1');
  assert.equal(data.sourceStageId, 'stage-1');
});

test('commission engine (flag enabled, intermediate stage): uses stage.amount as the base, not contract.price', async (t) => {
  withCommissionEngineFlag(t, 'true');
  const nextStage = { id: 'stage-2' };
  const { projectProgressService, getCommissionLogs } =
    await loadProjectProgressServiceWithFixture(t, { nextStage, referrals: [referralFixture({ affiliate: { id: 'affiliate-1', level: 1, userId: 'affiliate-user-1' } })] });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  const data = getCommissionLogs()[0];
  assert.equal(data.baseAmount, 100); // stage.amount, not contract.price (1000)
  assert.equal(data.appliedPercentage, 1.0); // level 1 = 'مسوق' = 1.00%
  assert.equal(data.amount, 1);
});

test('commission engine (flag enabled, no matching referral): zero CommissionLog rows created', async (t) => {
  withCommissionEngineFlag(t, 'true');
  const { projectProgressService, referralFindManySpy, commissionLogCreateSpy } =
    await loadProjectProgressServiceWithFixture(t, { referrals: [] });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(referralFindManySpy.mock.callCount(), 1);
  // Looks up both the client and provider side generically, per P-LG-012's
  // referred-role-agnostic trigger.
  assert.deepEqual(referralFindManySpy.mock.calls[0].arguments[0].where.referredUserId.in, ['client-1', 'provider-1']);
  assert.equal(commissionLogCreateSpy.mock.callCount(), 0);
});

test('commission engine (flag enabled, disputed project): skips commission creation entirely — never even reads Referral', async (t) => {
  withCommissionEngineFlag(t, 'true');
  const { projectProgressService, disputeFindFirstSpy, referralFindManySpy, commissionLogCreateSpy } =
    await loadProjectProgressServiceWithFixture(t, { disputeActive: true, referrals: [referralFixture()] });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(disputeFindFirstSpy.mock.callCount(), 1);
  assert.equal(referralFindManySpy.mock.callCount(), 0);
  assert.equal(commissionLogCreateSpy.mock.callCount(), 0);
});

test('commission engine (flag enabled, self-referral defense-in-depth): an affiliate somehow attributed to themselves never gets a commission', async (t) => {
  withCommissionEngineFlag(t, 'true');
  const selfReferral = referralFixture({ affiliate: { id: 'affiliate-1', level: 5, userId: 'client-1' } }); // affiliate.userId === referredUserId
  const { projectProgressService, commissionLogCreateSpy } =
    await loadProjectProgressServiceWithFixture(t, { referrals: [selfReferral] });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(commissionLogCreateSpy.mock.callCount(), 0);
});

test('commission engine (flag enabled, duplicate/retried release event): a P2002 on the exactly-once dedup constraint is swallowed as a safe no-op, never a fatal error', async (t) => {
  withCommissionEngineFlag(t, 'true');
  const { Prisma } = await import('@prisma/client');
  const duplicateError = new Prisma.PrismaClientKnownRequestError(
    'duplicate key value violates unique constraint "commission_logs_affiliateId_referralId_type_sourceStageId_key"',
    { code: 'P2002', clientVersion: 'test', meta: { target: ['commission_logs_affiliateId_referralId_type_sourceStageId_key'] } }
  );
  const { projectProgressService, commissionLogCreateSpy } = await loadProjectProgressServiceWithFixture(t, {
    referrals: [referralFixture()],
    commissionCreateImpl: () => { throw duplicateError; }
  });

  // Must resolve successfully (the duplicate is a safe no-op), not reject.
  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(commissionLogCreateSpy.mock.callCount(), 1);
});

test('commission engine (flag enabled, an UNRELATED P2002): propagates unmodified, never silently swallowed as "already processed"', async (t) => {
  withCommissionEngineFlag(t, 'true');
  const { Prisma } = await import('@prisma/client');
  const unrelatedError = new Prisma.PrismaClientKnownRequestError(
    'duplicate key value violates unique constraint "some_other_unrelated_constraint"',
    { code: 'P2002', clientVersion: 'test', meta: { target: ['some_other_unrelated_constraint'] } }
  );
  const { projectProgressService } = await loadProjectProgressServiceWithFixture(t, {
    referrals: [referralFixture()],
    commissionCreateImpl: () => { throw unrelatedError; }
  });

  await assert.rejects(() => projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve'));
});

test('commission engine (flag enabled, two referrals on the same release — client AND provider both attributed): creates one independent CommissionLog per referral', async (t) => {
  withCommissionEngineFlag(t, 'true');
  const clientReferral = referralFixture({ id: 'referral-client', referredUserId: 'client-1', affiliate: { id: 'affiliate-a', level: 1, userId: 'aff-user-a' } });
  const providerReferral = referralFixture({ id: 'referral-provider', referredUserId: 'provider-1', affiliate: { id: 'affiliate-b', level: 2, userId: 'aff-user-b' } });
  const { projectProgressService, commissionLogCreateSpy, getCommissionLogs } =
    await loadProjectProgressServiceWithFixture(t, { referrals: [clientReferral, providerReferral] });

  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');

  assert.equal(commissionLogCreateSpy.mock.callCount(), 2);
  const logs = getCommissionLogs();
  assert.equal(logs.find((l: any) => l.affiliateId === 'affiliate-a')?.referredUserId, 'client-1');
  assert.equal(logs.find((l: any) => l.affiliateId === 'affiliate-b')?.referredUserId, 'provider-1');
});
