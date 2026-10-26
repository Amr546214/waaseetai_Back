import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Provider-raised change requests (ProjectAmendment, requestedByRole PROVIDER): recorded as PENDING_OTHER_PARTY, the client is notified, and
// nothing about the contract price / duration / escrow / stages is touched. One pending request per contract.

const CONTRACT = { id: 'contract-abcdef123', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', status: 'ACTIVE', price: 1000, durationDays: 14 };

async function load(t: TestContext, opts: { pending?: number; lockCount?: number; contractFound?: boolean } = {}) {
  const state = { created: [] as any[], notifications: [] as any[], contractUpdates: [] as any[], contractFindArgs: [] as any[], listArgs: [] as any[] };
  const tx = {
    contract: { updateMany: async (args: any) => { state.contractUpdates.push(args); return { count: opts.lockCount ?? 1 }; } },
    projectAmendment: {
      count: async () => opts.pending ?? 0,
      create: async (args: any) => { const row = { id: 'amend-new', createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date('2026-02-01T00:00:00Z'), respondedAt: null, project: { title: 'مشروع' }, provider: { firstName: 'نورة', lastName: 'م' }, ...args.data }; state.created.push(row); return row; }
    },
    notification: { create: async (args: any) => { state.notifications.push(args.data); return args.data; } }
  };
  const prismaMock = {
    contract: { findFirst: async (args: any) => { state.contractFindArgs.push(args); return opts.contractFound === false ? null : { ...CONTRACT }; } },
    conversation: { findMany: async () => [{ id: 'conv-1', projectId: 'project-1', providerId: 'provider-1' }] },
    projectAmendment: { findMany: async (args: any) => { state.listArgs.push(args); return [{ id: 'a1', projectId: 'project-1', contractId: CONTRACT.id, clientId: 'client-1', providerId: 'provider-1', requestedByRole: 'PROVIDER', type: 'BUDGET', title: 'x', description: null, budgetDelta: 100, durationDeltaDays: null, status: 'PENDING_OTHER_PARTY', createdAt: new Date(), updatedAt: new Date(), respondedAt: null, project: { title: 'مشروع' }, provider: { firstName: 'نورة', lastName: 'م' } }]; } },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const { projectAmendmentService } = await import(`./project-amendment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { svc: projectAmendmentService, state };
}
const refused = async (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => e.statusCode === status && (!re || re.test(e.message)));
const VALID = { type: 'BUDGET', title: 'زيادة الميزانية', description: 'توسيع النطاق', budgetDelta: 200 };

test('the provider of an ACTIVE contract creates a request: recorded PENDING_OTHER_PARTY as raised by the PROVIDER, for the right contract/client', async (t) => {
  const { svc, state } = await load(t);
  const out = await svc.createProviderAmendment('provider-1', 'project-1', VALID);
  assert.equal(state.created.length, 1);
  assert.deepEqual({ ...state.created[0], createdAt: undefined, updatedAt: undefined, respondedAt: undefined, project: undefined, provider: undefined, id: undefined, currency: undefined }, {
    projectId: 'project-1', contractId: CONTRACT.id, clientId: 'client-1', providerId: 'provider-1', requestedById: 'provider-1', requestedByRole: 'PROVIDER',
    type: 'BUDGET', title: 'زيادة الميزانية', description: 'توسيع النطاق', budgetDelta: 200, durationDeltaDays: null, status: 'PENDING_OTHER_PARTY',
    createdAt: undefined, updatedAt: undefined, respondedAt: undefined, project: undefined, provider: undefined, id: undefined, currency: undefined
  });
  assert.equal(out.requestedByRole, 'PROVIDER');
  assert.equal(out.status, 'PENDING_OTHER_PARTY');
  assert.equal(out.conversationId, 'conv-1');
  // the contract is looked up by THIS provider and must be ACTIVE
  assert.deepEqual(state.contractFindArgs[0].where, { projectId: 'project-1', providerId: 'provider-1', status: 'ACTIVE' });
});

test('creating a request changes nothing about the contract: no price / duration / escrow / stage write (only the row-lock touch)', async (t) => {
  const { svc, state } = await load(t);
  await svc.createProviderAmendment('provider-1', 'project-1', VALID);
  assert.equal(state.contractUpdates.length, 1);
  assert.deepEqual(Object.keys(state.contractUpdates[0].data), ['updatedAt']);
});

test('the client is notified (once) with a link to their amendments page', async (t) => {
  const { svc, state } = await load(t);
  await svc.createProviderAmendment('provider-1', 'project-1', VALID);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].userId, 'client-1');
  assert.equal(state.notifications[0].type, 'PROJECT_AMENDMENT');
  assert.equal(state.notifications[0].category, 'PROJECTS');
  assert.equal(state.notifications[0].actionUrl, '/client-overview/projects/amendments');
  assert.equal(state.notifications[0].metadata.projectId, 'project-1');
  assert.equal(state.notifications[0].metadata.amendmentId, 'amend-new');
});

test('a provider who is not the contract\'s provider, or a project without an ACTIVE contract, is refused (403) and nothing is written', async (t) => {
  const none = await load(t, { contractFound: false });
  await refused(none.svc.createProviderAmendment('other-provider', 'project-1', VALID), 403);
  assert.equal(none.state.created.length, 0);
  assert.equal(none.state.notifications.length, 0);
});

test('a contract that left ACTIVE between the lookup and the lock is refused (403) and nothing is written', async (t) => {
  const lostLock = await load(t, { lockCount: 0 });
  await refused(lostLock.svc.createProviderAmendment('provider-1', 'project-1', VALID), 403);
  assert.equal(lostLock.state.created.length, 0);
  assert.equal(lostLock.state.notifications.length, 0);
});

test('a pending request of the provider on the same contract -> 409 and no second row, no second notification', async (t) => {
  const { svc, state } = await load(t, { pending: 1 });
  await refused(svc.createProviderAmendment('provider-1', 'project-1', VALID), 409, /معلّق/);
  assert.equal(state.created.length, 0);
  assert.equal(state.notifications.length, 0);
});

test('validation by type: BUDGET needs a non-zero budgetDelta, DURATION a non-zero durationDeltaDays, SCOPE a description, MIXED two dimensions', async (t) => {
  const { svc, state } = await load(t);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'BUDGET', title: 't', description: 'x' }), 400, /الميزانية/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'BUDGET', title: 't', budgetDelta: 0 }), 400, /الميزانية/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'DURATION', title: 't', description: 'x' }), 400, /المدة/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'DURATION', title: 't', durationDeltaDays: 0 }), 400, /المدة/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'DURATION', title: 't', durationDeltaDays: 2.5 }), 400);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'SCOPE', title: 't' }), 400, /النطاق/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'SCOPE', title: 't', description: '   ' }), 400, /النطاق/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'MIXED', title: 't', budgetDelta: 5 }), 400, /بُعدين/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'NOPE', title: 't', description: 'x' }), 400, /نوع/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'SCOPE', title: '   ', description: 'x' }), 400, /عنوان/);
  await refused(svc.createProviderAmendment('provider-1', 'project-1', { type: 'BUDGET', title: 't', budgetDelta: Number.NaN }), 400);
  assert.equal(state.created.length, 0);
  // and the valid forms of each type go through
  await svc.createProviderAmendment('provider-1', 'project-1', { type: 'DURATION', title: 't', durationDeltaDays: -3 });
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].durationDeltaDays, -3);
});

test('list: only THIS provider\'s requests for THIS project (ownership in the WHERE), newest first, whitelisted shape', async (t) => {
  const { svc, state } = await load(t);
  const out = await svc.listProviderAmendments('provider-1', 'project-1');
  assert.deepEqual(state.listArgs[0].where, { providerId: 'provider-1', projectId: 'project-1' });
  assert.deepEqual(state.listArgs[0].orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ['actionBlockedReason', 'actionable', 'addedStageId', 'appliedAt', 'budgetDelta', 'contractId', 'contractRef', 'contractDurationDays', 'contractPrice', 'contractStatus', 'conversationId', 'createdAt', 'currency', 'description', 'durationAfter', 'durationBefore', 'durationDeltaDays', 'effect', 'effectNote', 'fundingAuthorized', 'fundingAuthorizedUntil', 'id', 'needsClientPayment', 'priceAfter', 'priceBefore', 'projectId', 'projectTitle', 'providerId', 'providerName', 'requestedByRole', 'respondedAt', 'status', 'title', 'type', 'updatedAt'].sort());
});
