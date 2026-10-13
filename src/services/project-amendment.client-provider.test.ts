import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// C1: a client-raised change request (a) is recorded once per contract (one pending), (b) notifies the PROVIDER, and (c) the PROVIDER of that
// contract can answer it (record only: nothing about price / duration / escrow / stages is touched). The provider can never answer its own request.

const CONTRACT = { id: 'contract-abcdef123', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', status: 'ACTIVE', price: 1000, durationDays: 14 };
const ROW = (o: Record<string, unknown> = {}) => ({
  id: 'amend-1', projectId: 'project-1', contractId: CONTRACT.id, clientId: 'client-1', providerId: 'provider-1', requestedById: 'client-1', requestedByRole: 'CLIENT',
  type: 'BUDGET', title: 'زيادة', description: null, budgetDelta: 200, durationDeltaDays: null, status: 'PENDING_OTHER_PARTY',
  createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date('2026-02-01T00:00:00Z'), respondedAt: null,
  project: { title: 'مشروع' }, provider: { firstName: 'نورة', lastName: 'م' }, ...o
});

async function load(t: TestContext, opts: { pending?: number; lockCount?: number; contractFound?: boolean; stored?: any } = {}) {
  const state = { created: [] as any[], notifications: [] as any[], lockArgs: [] as any[], countArgs: [] as any[], contractFindArgs: [] as any[], amendUpdates: [] as any[], forbiddenWrites: 0 };
  let stored = opts.stored === undefined ? ROW() : opts.stored;
  const tx = {
    contract: { updateMany: async (args: any) => { state.lockArgs.push(args); return { count: opts.lockCount ?? 1 }; } },
    projectAmendment: {
      count: async (args: any) => { state.countArgs.push(args); return opts.pending ?? 0; },
      create: async (args: any) => { const row = ROW({ ...args.data, id: 'amend-new' }); state.created.push(row); return row; }
    },
    notification: { create: async (args: any) => { state.notifications.push(args.data); return args.data; } }
  };
  const forbidden = new Proxy({}, { get: () => async () => { state.forbiddenWrites++; return {}; } });
  const prismaMock = {
    contract: { findFirst: async (args: any) => { state.contractFindArgs.push(args); return opts.contractFound === false ? null : { ...CONTRACT }; }, updateMany: forbidden, update: forbidden },
    escrow: forbidden, projectStage: forbidden,
    conversation: { findMany: async () => [{ id: 'conv-1', projectId: 'project-1', providerId: 'provider-1' }] },
    projectAmendment: {
      // the provider answer: one conditional write repeating every guard
      updateMany: async (args: any) => {
        state.amendUpdates.push(args);
        const w = args.where;
        const ok = stored && w.id === stored.id && w.providerId === stored.providerId && w.requestedByRole === stored.requestedByRole && w.status === stored.status;
        if (!ok) return { count: 0 };
        stored = { ...stored, ...args.data };
        return { count: 1 };
      },
      findFirst: async (args: any) => (stored && args.where.id === stored.id && (!args.where.providerId || args.where.providerId === stored.providerId) ? stored : null)
    },
    notification: { create: async (args: any) => { state.notifications.push(args.data); return args.data; } },
    $transaction: async (fn: any) => fn(tx)
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const { projectAmendmentService } = await import(`./project-amendment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { svc: projectAmendmentService, state };
}
const refused = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => e.statusCode === status && (!re || re.test(e.message)));
const VALID = { type: 'BUDGET', title: 'زيادة الميزانية', description: 'توسيع النطاق', budgetDelta: 200 };

// ---------- client create ----------
test('client create: recorded as raised by the CLIENT for the right contract / provider, and the PROVIDER is notified', async (t) => {
  const { svc, state } = await load(t);
  const out = await svc.createAmendment('client-1', 'project-1', VALID);
  assert.equal(state.created.length, 1);
  const c = state.created[0];
  assert.deepEqual([c.requestedByRole, c.requestedById, c.clientId, c.providerId, c.contractId, c.status], ['CLIENT', 'client-1', 'client-1', 'provider-1', CONTRACT.id, 'PENDING_OTHER_PARTY']);
  assert.equal(out.requestedByRole, 'CLIENT');
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].userId, 'provider-1'); // the provider, not the client
  assert.equal(state.notifications[0].type, 'PROJECT_AMENDMENT');
  assert.match(state.notifications[0].actionUrl, /provider-overview/);
  assert.equal(state.notifications[0].metadata.amendmentId, 'amend-new');
});
test('client create: a SECOND pending client request on the same contract is refused (409) and writes nothing', async (t) => {
  const { svc, state } = await load(t, { pending: 1 });
  await refused(svc.createAmendment('client-1', 'project-1', VALID), 409, /معلّق/);
  assert.equal(state.created.length, 0);
  assert.equal(state.notifications.length, 0);
  assert.deepEqual(state.countArgs[0].where, { contractId: CONTRACT.id, requestedByRole: 'CLIENT', status: 'PENDING_OTHER_PARTY' });
});
test('client create: the pending check runs under a lock on the contract row (two simultaneous requests cannot both pass)', async (t) => {
  const { svc, state } = await load(t);
  await svc.createAmendment('client-1', 'project-1', VALID);
  assert.equal(state.lockArgs.length, 1);
  assert.deepEqual(state.lockArgs[0].where, { id: CONTRACT.id, clientId: 'client-1', status: 'ACTIVE' });
  assert.deepEqual(Object.keys(state.lockArgs[0].data), ['updatedAt']); // a harmless touch, not a contract change
});
test('client create: a lost lock (contract changed meanwhile) is 403 and writes nothing', async (t) => {
  const { svc, state } = await load(t, { lockCount: 0 });
  await refused(svc.createAmendment('client-1', 'project-1', VALID), 403);
  assert.equal(state.created.length, 0);
  assert.equal(state.notifications.length, 0);
});
test('client create: only the owning client of an ACTIVE contract (403 otherwise); the lookup is scoped by clientId', async (t) => {
  const { svc, state } = await load(t, { contractFound: false });
  await refused(svc.createAmendment('someone-else', 'project-1', VALID), 403);
  assert.deepEqual(state.contractFindArgs[0].where, { projectId: 'project-1', clientId: 'someone-else', status: 'ACTIVE' });
  assert.equal(state.created.length, 0);
});
test('client create: validation of the type and its fields is unchanged (400) and writes nothing', async (t) => {
  const { svc, state } = await load(t);
  for (const bad of [{ type: 'NOPE', title: 't', description: 'x' }, { type: 'BUDGET', title: 't' }, { type: 'DURATION', title: 't', durationDeltaDays: 2.5 }, { type: 'SCOPE', title: 't' }, { type: 'MIXED', title: 't', budgetDelta: 5 }, { type: 'SCOPE', description: 'x' }, {}])
    await refused(svc.createAmendment('client-1', 'project-1', bad), 400);
  assert.equal(state.created.length, 0);
});
test('client create changes nothing about the contract (no contract / escrow / stage write besides the lock touch)', async (t) => {
  const { svc, state } = await load(t);
  await svc.createAmendment('client-1', 'project-1', VALID);
  assert.equal(state.forbiddenWrites, 0);
});

// ---------- provider respond ----------
test('provider respond: the provider of the contract approves a CLIENT request — decision recorded, client notified', async (t) => {
  const { svc, state } = await load(t);
  const out = await svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve');
  assert.equal(out.status, 'APPROVED');
  assert.ok(out.respondedAt);
  assert.deepEqual(state.amendUpdates[0].where, { id: 'amend-1', providerId: 'provider-1', requestedByRole: 'CLIENT', status: 'PENDING_OTHER_PARTY' });
  assert.deepEqual(Object.keys(state.amendUpdates[0].data).sort(), ['respondedAt', 'status']);
  assert.equal(state.notifications[0].userId, 'client-1');
  assert.match(state.notifications[0].message, /لا يغيّر السعر أو المدة أو الضمان/);
});
test('provider respond: reject is recorded as REJECTED', async (t) => {
  const { svc } = await load(t);
  assert.equal((await svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'reject')).status, 'REJECTED');
});
test('provider respond: NEVER touches price / duration / escrow / stages', async (t) => {
  const { svc, state } = await load(t);
  await svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve');
  assert.equal(state.forbiddenWrites, 0);
});
test('provider respond: another provider is refused (403) and nothing changes', async (t) => {
  const { svc, state } = await load(t);
  await refused(svc.respondToAmendmentAsProvider('other-provider', 'amend-1', 'approve'), 403);
  assert.equal(state.notifications.length, 0);
});
test('provider respond: a request the PROVIDER raised cannot be answered by the provider (403)', async (t) => {
  const { svc, state } = await load(t, { stored: ROW({ requestedByRole: 'PROVIDER', requestedById: 'provider-1' }) });
  await refused(svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve'), 403, /رفعته أنت/);
  assert.equal(state.notifications.length, 0);
});
test('provider respond: answering twice is refused (409); the first decision stands', async (t) => {
  const { svc, state } = await load(t);
  await svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'approve');
  await refused(svc.respondToAmendmentAsProvider('provider-1', 'amend-1', 'reject'), 409, /مسبقًا/);
  assert.equal(state.notifications.length, 1);
});
test('provider respond: an unknown request is 403 and an invalid decision is 400 (no query at all)', async (t) => {
  const { svc, state } = await load(t, { stored: null });
  await refused(svc.respondToAmendmentAsProvider('provider-1', 'nope', 'approve'), 403);
  for (const d of ['maybe', '', undefined, 'APPROVE', 1]) await refused(svc.respondToAmendmentAsProvider('provider-1', 'amend-1', d as any), 400);
  assert.equal(state.amendUpdates.length, 1); // only the unknown-id attempt reached the DB
});
