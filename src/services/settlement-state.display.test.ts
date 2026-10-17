import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// a separate module instance (query string) so the DB-mocked tests below load their own settlement-state module against the mocked client
const lib = () => import('./settlement-state.service.ts?pure=1');
const { SETTLED_LABEL_AR, SETTLED_STAGE_LABEL_AR } = { SETTLED_LABEL_AR: 'أُغلق بتسوية نزاع', SETTLED_STAGE_LABEL_AR: 'أُغلقت بالتسوية' };

test('stage display: only unreleased stages of a settled project read "closed by the settlement"; an approved one never does; not settled changes nothing', async () => {
  const { stageDisplayStatus, displayProjectStatus, hasFinancialSettlement, deliveryCompletedProject, NOT_SETTLED_PROJECT, adminSettledView } = await lib();
  for (const s of ['PENDING', 'IN_PROGRESS', 'SUBMITTED', 'REVISION_REQUESTED']) {
    assert.deepEqual(stageDisplayStatus(s, true), { displayStatus: 'CLOSED_BY_SETTLEMENT', displayStatusLabel: SETTLED_STAGE_LABEL_AR });
    assert.deepEqual(stageDisplayStatus(s, false), { displayStatus: null, displayStatusLabel: null });
  }
  assert.deepEqual(stageDisplayStatus('APPROVED', true), { displayStatus: null, displayStatusLabel: null });
});

test('project display status: settled COMPLETED/DISPUTED is "closed by a dispute settlement", never "completed"', async () => {
  const { stageDisplayStatus, displayProjectStatus, hasFinancialSettlement, deliveryCompletedProject, NOT_SETTLED_PROJECT, adminSettledView } = await lib();
  assert.deepEqual(displayProjectStatus('COMPLETED', true), { code: 'CLOSED_BY_SETTLEMENT', label: SETTLED_LABEL_AR });
  assert.deepEqual(displayProjectStatus('COMPLETED', false), { code: 'COMPLETED', label: null });
  assert.deepEqual(displayProjectStatus('IN_PROGRESS', true), { code: 'IN_PROGRESS', label: null });
});

test('the one shared rule: delivery-completed = COMPLETED and no financially-resolved dispute; a TEXT closure does not settle', async () => {
  const { stageDisplayStatus, displayProjectStatus, hasFinancialSettlement, deliveryCompletedProject, NOT_SETTLED_PROJECT, adminSettledView } = await lib();
  const w: any = deliveryCompletedProject({ providerId: 'p1' });
  assert.equal(w.status, 'COMPLETED'); assert.equal(w.providerId, 'p1');
  assert.deepEqual(w.disputes, NOT_SETTLED_PROJECT.disputes);
  assert.equal(hasFinancialSettlement([{ status: 'RESOLVED', resolution: 'SPLIT' }]), true);
  assert.equal(hasFinancialSettlement([{ status: 'RESOLVED', resolution: 'TEXT_ONLY' }, { status: 'OPEN', resolution: null }]), false);
  assert.equal(adminSettledView({ settled: false }), null);
  assert.deepEqual(adminSettledView({ settled: true, disputeId: 'd1', outcome: 'SPLIT', outcomeLabel: 'x', settledAt: null }), { disputeId: 'd1', outcome: 'SPLIT', label: SETTLED_LABEL_AR });
});

async function completedList(t: TestContext, settledProjectIds: string[], reviews: any[] = []) {
  const mk = (id: string) => ({ id: `c-${id}`, projectId: id, providerId: 'pr', status: 'COMPLETED', price: 20, updatedAt: new Date(), project: { title: id, status: 'COMPLETED', escrow: null, serviceCatalog: null, specialty: 's' }, provider: { firstName: 'ا', lastName: 'ب', providerProfile: null } });
  const db: any = {
    contract: { count: async () => 2, findMany: async () => [mk('p-settled'), mk('p-delivered')] },
    review: { findMany: async () => reviews },
    dispute: { findMany: async () => settledProjectIds.map(projectId => ({ id: `d-${projectId}`, projectId, resolution: 'SPLIT' })) }
  };
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  return (await new ClientRequestsService().getCompletedProjects('client-1')).items;
}

test('client completed list: a settled project carries adminSettled + the settled label and offers no NEW rating; a delivered one still can be rated', async (t) => {
  const items = await completedList(t, ['p-settled']);
  const settled = items.find((i: any) => i.projectId === 'p-settled'); const delivered = items.find((i: any) => i.projectId === 'p-delivered');
  assert.deepEqual(settled.adminSettled, { disputeId: 'd-p-settled', outcome: 'SPLIT', label: SETTLED_LABEL_AR });
  assert.equal(settled.statusLabel, SETTLED_LABEL_AR); assert.equal(settled.canRate, false);
  assert.equal(delivered.adminSettled, null); assert.equal(delivered.canRate, true);
});

test('client completed list: a review saved before the settlement stays readable (hasRated / rating untouched)', async (t) => {
  const items = await completedList(t, ['p-settled'], [{ projectId: 'p-settled', rating: 4, comment: 'جيد', createdAt: new Date() }]);
  const settled = items.find((i: any) => i.projectId === 'p-settled');
  assert.equal(settled.canRate, false); assert.equal(settled.hasRated, true); assert.equal(settled.rating, 4); assert.equal(settled.ratingComment, 'جيد');
});
