import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

async function loadServiceWithMockPrisma(t: TestContext, prismaMock: any) {
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./project-amendment.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const { projectAmendmentService } = await import(moduleUrl);
  return projectAmendmentService;
}

function amendmentFixture(overrides: Partial<any> = {}) {
  return {
    id: 'amend-1',
    projectId: 'project-1',
    contractId: 'contract-abcdef123',
    clientId: 'client-1',
    providerId: 'provider-1',
    requestedById: 'provider-1',
    requestedByRole: 'PROVIDER',
    type: 'DURATION',
    title: 'تمديد المدة',
    description: 'بسبب توسيع النطاق',
    budgetDelta: null,
    durationDeltaDays: 7,
    status: 'PENDING_OTHER_PARTY',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    respondedAt: null,
    project: { title: 'مشروع تجريبي' },
    provider: { firstName: 'نورة', lastName: 'التصميم' },
    ...overrides
  };
}

// ── listAmendments ────────────────────────────────────────────────────────

test('listAmendments: returns real fields mapped from the DB row, including a resolved conversationId', async (t) => {
  const findManySpy = t.mock.fn(async () => [amendmentFixture()]);
  const conversationFindManySpy = t.mock.fn(async () => [{ id: 'conv-1', projectId: 'project-1', providerId: 'provider-1' }]);
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { findMany: findManySpy },
    conversation: { findMany: conversationFindManySpy }
  });

  const result = await service.listAmendments('client-1');

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: 'amend-1',
    projectId: 'project-1',
    projectTitle: 'مشروع تجريبي',
    contractId: 'contract-abcdef123',
    contractRef: 'CT-CONTRA',
    providerId: 'provider-1',
    providerName: 'نورة التصميم',
    requestedByRole: 'PROVIDER',
    type: 'DURATION',
    title: 'تمديد المدة',
    description: 'بسبب توسيع النطاق',
    budgetDelta: null,
    durationDeltaDays: 7,
    status: 'PENDING_OTHER_PARTY',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    respondedAt: null,
    conversationId: 'conv-1'
  });
});

test('listAmendments: exposes only whitelisted fields — no private/internal data leaks', async (t) => {
  const findManySpy = t.mock.fn(async () => [amendmentFixture()]);
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { findMany: findManySpy },
    conversation: { findMany: async () => [] }
  });

  const result = await service.listAmendments('client-1');
  const keys = Object.keys(result[0]).sort();
  assert.deepEqual(keys, [
    'budgetDelta', 'contractId', 'contractRef', 'conversationId', 'createdAt', 'description',
    'durationDeltaDays', 'id', 'projectId', 'projectTitle', 'providerId', 'providerName',
    'requestedByRole', 'respondedAt', 'status', 'title', 'type', 'updatedAt'
  ].sort());
});

test('listAmendments: query is scoped to the calling client only (never another client\'s data)', async (t) => {
  const findManySpy = t.mock.fn(async () => []);
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { findMany: findManySpy },
    conversation: { findMany: async () => [] }
  });

  await service.listAmendments('client-1');

  assert.equal(findManySpy.mock.callCount(), 1);
  const args = findManySpy.mock.calls[0].arguments[0];
  assert.deepEqual(args.where, { clientId: 'client-1' });
});

test('listAmendments: orders by newest activity first (updatedAt desc)', async (t) => {
  const findManySpy = t.mock.fn(async () => []);
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { findMany: findManySpy },
    conversation: { findMany: async () => [] }
  });

  await service.listAmendments('client-1');

  const args = findManySpy.mock.calls[0].arguments[0];
  assert.deepEqual(args.orderBy, { updatedAt: 'desc' });
});

test('listAmendments: an empty result returns a clean empty array', async (t) => {
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { findMany: async () => [] },
    conversation: { findMany: async () => [] }
  });

  const result = await service.listAmendments('client-1');
  assert.deepEqual(result, []);
});

test('listAmendments: conversationId is null (not fabricated) when no real conversation exists yet for that project+provider', async (t) => {
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { findMany: async () => [amendmentFixture()] },
    conversation: { findMany: async () => [] }
  });

  const result = await service.listAmendments('client-1');
  assert.equal(result[0].conversationId, null);
});

// ── createAmendment ────────────────────────────────────────────────────────

test('createAmendment: client creates an amendment on their own active contract', async (t) => {
  const contract = { id: 'contract-abcdef123', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', status: 'ACTIVE' };
  const createSpy = t.mock.fn(async (args: any) => ({
    ...args.data,
    id: 'amend-new',
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-01T00:00:00Z'),
    respondedAt: null,
    project: { title: 'مشروع تجريبي' },
    provider: { firstName: 'نورة', lastName: 'التصميم' }
  }));
  const service = await loadServiceWithMockPrisma(t, {
    contract: { findFirst: async () => contract },
    projectAmendment: { create: createSpy },
    conversation: { findMany: async () => [] }
  });

  const result = await service.createAmendment('client-1', 'project-1', { title: 'تمديد المدة', type: 'DURATION', durationDeltaDays: 5 });

  assert.equal(createSpy.mock.callCount(), 1);
  const data = createSpy.mock.calls[0].arguments[0].data;
  assert.equal(data.requestedByRole, 'CLIENT');
  assert.equal(data.requestedById, 'client-1');
  assert.equal(data.clientId, 'client-1');
  assert.equal(data.providerId, 'provider-1');
  assert.equal(data.contractId, 'contract-abcdef123');
  assert.equal(data.status, 'PENDING_OTHER_PARTY');
  assert.equal(result.status, 'PENDING_OTHER_PARTY');
  assert.equal(result.requestedByRole, 'CLIENT');
});

test('createAmendment: cannot create for a project/contract the caller does not own as client', async (t) => {
  const findFirstSpy = t.mock.fn(async (args: any) => (args.where.clientId === 'real-owner' ? { id: 'c1', clientId: 'real-owner', providerId: 'p1', status: 'ACTIVE' } : null));
  const service = await loadServiceWithMockPrisma(t, {
    contract: { findFirst: findFirstSpy },
    projectAmendment: { create: async () => { throw new Error('must not be called'); } }
  });

  await assert.rejects(
    () => service.createAmendment('someone-else', 'project-1', { title: 'x', type: 'BUDGET', budgetDelta: 100 }),
    /العقد غير نشط أو لا تملك صلاحية/
  );
  assert.equal(findFirstSpy.mock.calls[0].arguments[0].where.clientId, 'someone-else');
});

test('createAmendment: rejects an invalid type before touching the DB', async (t) => {
  const service = await loadServiceWithMockPrisma(t, {
    contract: { findFirst: async () => { throw new Error('must not be called'); } },
    projectAmendment: { create: async () => { throw new Error('must not be called'); } }
  });

  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'x', type: 'NOT_A_REAL_TYPE', budgetDelta: 100 }),
    /نوع التعديل غير صالح/
  );
});

// ── createAmendment: basic input hygiene ───────────────────────────────────

test('createAmendment: a whitespace-only title is rejected', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: '   ', type: 'BUDGET', budgetDelta: 100 }),
    /أضف عنوانًا لطلب التعديل/
  );
});

test('createAmendment: a title over 200 characters is rejected', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'ط'.repeat(201), type: 'BUDGET', budgetDelta: 100 }),
    /العنوان طويل جدًا/
  );
});

test('createAmendment: a description over 5000 characters is rejected', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'SCOPE', description: 'و'.repeat(5001) }),
    /الوصف طويل جدًا/
  );
});

test('createAmendment: BUDGET without a budgetDelta is rejected', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'BUDGET' }),
    /تعديل الميزانية يتطلب قيمة تغيير فعلية/
  );
});

test('createAmendment: BUDGET with a zero budgetDelta is rejected (zero means no real change)', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'BUDGET', budgetDelta: 0 }),
    /تعديل الميزانية يتطلب قيمة تغيير فعلية/
  );
});

test('createAmendment: DURATION without a durationDeltaDays is rejected', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'DURATION' }),
    /تعديل المدة يتطلب عدد أيام تغيير فعلي/
  );
});

test('createAmendment: DURATION with a non-integer duration is rejected', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'DURATION', durationDeltaDays: 2.5 }),
    /قيمة المدة غير صالحة/
  );
});

test('createAmendment: DURATION with zero is rejected', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'DURATION', durationDeltaDays: 0 }),
    /تعديل المدة يتطلب عدد أيام تغيير فعلي/
  );
});

test('createAmendment: SCOPE without a meaningful description is rejected — must not silently represent only a budget/duration change', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'SCOPE', budgetDelta: 100, durationDeltaDays: 3 }),
    /تعديل النطاق يتطلب وصفًا/
  );
});

test('createAmendment: MIXED with only one real change dimension is rejected', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'MIXED', budgetDelta: 100 }),
    /التعديل المتعدد يتطلب بُعدين على الأقل/
  );
});

test('createAmendment: MIXED with two real change dimensions is accepted', async (t) => {
  const contract = { id: 'contract-1', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', status: 'ACTIVE' };
  const createSpy = t.mock.fn(async (args: any) => ({
    ...args.data, id: 'amend-new', createdAt: new Date(), updatedAt: new Date(), respondedAt: null,
    project: { title: 'مشروع' }, provider: { firstName: 'م', lastName: '' }
  }));
  const service = await loadServiceWithMockPrisma(t, {
    contract: { findFirst: async () => contract },
    projectAmendment: { create: createSpy },
    conversation: { findMany: async () => [] }
  });

  await service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'MIXED', budgetDelta: 100, durationDeltaDays: 3 });
  assert.equal(createSpy.mock.callCount(), 1);
});

test('createAmendment: a negative finite budget delta is accepted (a reduction is a valid amendment)', async (t) => {
  const contract = { id: 'contract-1', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', status: 'ACTIVE' };
  const createSpy = t.mock.fn(async (args: any) => ({
    ...args.data, id: 'amend-new', createdAt: new Date(), updatedAt: new Date(), respondedAt: null,
    project: { title: 'مشروع' }, provider: { firstName: 'م', lastName: '' }
  }));
  const service = await loadServiceWithMockPrisma(t, {
    contract: { findFirst: async () => contract },
    projectAmendment: { create: createSpy },
    conversation: { findMany: async () => [] }
  });

  await service.createAmendment('client-1', 'project-1', { title: 'تخفيض', type: 'BUDGET', budgetDelta: -500 });
  assert.equal(createSpy.mock.calls[0].arguments[0].data.budgetDelta, -500);
});

test('createAmendment: a negative integer duration delta is accepted (shortening the project is valid)', async (t) => {
  const contract = { id: 'contract-1', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', status: 'ACTIVE' };
  const createSpy = t.mock.fn(async (args: any) => ({
    ...args.data, id: 'amend-new', createdAt: new Date(), updatedAt: new Date(), respondedAt: null,
    project: { title: 'مشروع' }, provider: { firstName: 'م', lastName: '' }
  }));
  const service = await loadServiceWithMockPrisma(t, {
    contract: { findFirst: async () => contract },
    projectAmendment: { create: createSpy },
    conversation: { findMany: async () => [] }
  });

  await service.createAmendment('client-1', 'project-1', { title: 'تقصير', type: 'DURATION', durationDeltaDays: -2 });
  assert.equal(createSpy.mock.calls[0].arguments[0].data.durationDeltaDays, -2);
});

test('createAmendment: NaN budgetDelta is rejected outright, never silently coerced to null and accepted', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'BUDGET', budgetDelta: NaN }),
    /قيمة الميزانية غير صالحة/
  );
});

test('createAmendment: Infinity durationDeltaDays is rejected outright, never silently coerced to null and accepted', async (t) => {
  const service = await loadServiceWithMockPrisma(t, { contract: { findFirst: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    () => service.createAmendment('client-1', 'project-1', { title: 'عنوان', type: 'DURATION', durationDeltaDays: Infinity }),
    /قيمة المدة غير صالحة/
  );
});

// ── respondToAmendment ─────────────────────────────────────────────────────
//
// Mocked to match the REAL Prisma updateMany()/findFirst() contract: a small
// mutable "table" holds one row, updateMany() only mutates it and returns
// { count: 1 } when every predicate in `where` matches the row's CURRENT
// state at call time (never an impossible/fabricated response), otherwise
// { count: 0 } with no mutation — exactly how Postgres would behave under a
// conditional UPDATE.

function createMockAmendmentTable(initialRow: any) {
  let row: any = { ...initialRow };
  const updateMany = async (args: any) => {
    const w = args.where;
    const matches = row.id === w.id && row.clientId === w.clientId && row.requestedByRole === w.requestedByRole && row.status === w.status;
    if (!matches) return { count: 0 };
    row = { ...row, ...args.data };
    return { count: 1 };
  };
  const findFirst = async (args: any) => {
    const w = args.where;
    if (w.id !== row.id) return null;
    if (w.clientId && w.clientId !== row.clientId) return null;
    return { ...row };
  };
  return { updateMany, findFirst, getRow: () => row };
}

test('respondToAmendment (A): the first valid response succeeds and persists the real decision', async (t) => {
  const table = createMockAmendmentTable(amendmentFixture({ requestedByRole: 'PROVIDER', status: 'PENDING_OTHER_PARTY' }));
  const updateManySpy = t.mock.fn(table.updateMany);
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { updateMany: updateManySpy, findFirst: table.findFirst },
    conversation: { findMany: async () => [] }
  });

  const result = await service.respondToAmendment('client-1', 'amend-1', 'approve');

  assert.equal(updateManySpy.mock.callCount(), 1);
  assert.equal(result.status, 'APPROVED');
  assert.equal(table.getRow().status, 'APPROVED');
  assert.ok(table.getRow().respondedAt instanceof Date);
});

test('respondToAmendment (B): a second response after the status is no longer PENDING_OTHER_PARTY cannot overwrite the first decision', async (t) => {
  const table = createMockAmendmentTable(amendmentFixture({ requestedByRole: 'PROVIDER', status: 'PENDING_OTHER_PARTY' }));
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { updateMany: table.updateMany, findFirst: table.findFirst },
    conversation: { findMany: async () => [] }
  });

  // First call (e.g. the winner of a race) commits APPROVED.
  await service.respondToAmendment('client-1', 'amend-1', 'approve');
  assert.equal(table.getRow().status, 'APPROVED');

  // A second, later call (e.g. the race loser, or simply a stale retry) must
  // be rejected — and must NOT flip the already-decided row to REJECTED.
  await assert.rejects(
    () => service.respondToAmendment('client-1', 'amend-1', 'reject'),
    /تم الرد على طلب التعديل هذا مسبقًا/
  );
  assert.equal(table.getRow().status, 'APPROVED', 'first successful decision must win — never overwritten');
});

test('respondToAmendment (C): the atomic update predicates on id, clientId, requestedByRole=PROVIDER, and status=PENDING_OTHER_PARTY together', async (t) => {
  const table = createMockAmendmentTable(amendmentFixture({ requestedByRole: 'PROVIDER', status: 'PENDING_OTHER_PARTY' }));
  const updateManySpy = t.mock.fn(table.updateMany);
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { updateMany: updateManySpy, findFirst: table.findFirst },
    conversation: { findMany: async () => [] }
  });

  await service.respondToAmendment('client-1', 'amend-1', 'approve');

  assert.deepEqual(updateManySpy.mock.calls[0].arguments[0].where, {
    id: 'amend-1',
    clientId: 'client-1',
    requestedByRole: 'PROVIDER',
    status: 'PENDING_OTHER_PARTY'
  });
});

test('respondToAmendment (D): zero affected rows from the atomic update never produces a success — it is diagnosed and rejected', async (t) => {
  // Row already APPROVED before this call even starts (not a live race —
  // simply a stale/second attempt) — updateMany's WHERE will match zero rows.
  const table = createMockAmendmentTable(amendmentFixture({ requestedByRole: 'PROVIDER', status: 'APPROVED' }));
  const updateManySpy = t.mock.fn(table.updateMany);
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { updateMany: updateManySpy, findFirst: table.findFirst }
  });

  await assert.rejects(
    () => service.respondToAmendment('client-1', 'amend-1', 'approve'),
    /تم الرد على طلب التعديل هذا مسبقًا/
  );
  assert.equal(updateManySpy.mock.callCount(), 1);
  assert.equal(table.getRow().status, 'APPROVED', 'no write occurred from the failed conditional update');
});

test('respondToAmendment: a client cannot respond to their OWN client-created pending amendment', async (t) => {
  const table = createMockAmendmentTable(amendmentFixture({ requestedByRole: 'CLIENT', status: 'PENDING_OTHER_PARTY' }));
  const updateManySpy = t.mock.fn(table.updateMany);
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { updateMany: updateManySpy, findFirst: table.findFirst }
  });

  await assert.rejects(
    () => service.respondToAmendment('client-1', 'amend-1', 'approve'),
    /لا يمكنك الرد على طلب تعديل رفعته أنت/
  );
  // The conditional update is attempted (and correctly matches zero rows,
  // since requestedByRole=PROVIDER is one of its predicates) — the row is
  // never mutated regardless.
  assert.equal(table.getRow().status, 'PENDING_OTHER_PARTY');
});

test('respondToAmendment: another client cannot respond (ownership-scoped predicates never match)', async (t) => {
  const table = createMockAmendmentTable(amendmentFixture({ requestedByRole: 'PROVIDER', status: 'PENDING_OTHER_PARTY', clientId: 'real-owner' }));
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { updateMany: table.updateMany, findFirst: table.findFirst }
  });

  await assert.rejects(
    () => service.respondToAmendment('someone-else', 'amend-1', 'approve'),
    /طلب التعديل غير موجود أو لا تملك صلاحية الوصول إليه/
  );
  assert.equal(table.getRow().status, 'PENDING_OTHER_PARTY');
});

test('respondToAmendment: does NOT mutate escrow, contract price, or stage amounts as a side effect', async (t) => {
  const table = createMockAmendmentTable(amendmentFixture({ requestedByRole: 'PROVIDER', status: 'PENDING_OTHER_PARTY' }));
  const contractUpdateSpy = t.mock.fn(async () => { throw new Error('must not be called: contract must never be touched by respondToAmendment'); });
  const escrowUpdateSpy = t.mock.fn(async () => { throw new Error('must not be called: escrow must never be touched by respondToAmendment'); });
  const stageUpdateSpy = t.mock.fn(async () => { throw new Error('must not be called: stage amounts must never be touched by respondToAmendment'); });
  const service = await loadServiceWithMockPrisma(t, {
    projectAmendment: { updateMany: table.updateMany, findFirst: table.findFirst },
    contract: { update: contractUpdateSpy, updateMany: contractUpdateSpy },
    escrow: { update: escrowUpdateSpy, updateMany: escrowUpdateSpy },
    projectStage: { update: stageUpdateSpy, updateMany: stageUpdateSpy },
    conversation: { findMany: async () => [] }
  });

  await service.respondToAmendment('client-1', 'amend-1', 'approve');

  assert.equal(contractUpdateSpy.mock.callCount(), 0);
  assert.equal(escrowUpdateSpy.mock.callCount(), 0);
  assert.equal(stageUpdateSpy.mock.callCount(), 0);
});
