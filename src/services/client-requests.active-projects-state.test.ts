import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

// A5: an unfunded project awaiting signature is never presented as running. It stays visible (the client has to sign/fund) with status 'pending' (never 'wait' = awaiting the client's REVIEW),
// rawStatus PENDING_SIGNATURE, progress 0, nothing held and an accurate nextStep; the real provider name is shown from the selected offer/contract.
const NOW = new Date();
const providerUser = { firstName: 'سارة', lastName: 'الأحمد', status: 'ACTIVE', providerProfile: null };

function project(over: any = {}) {
  return {
    id: 'proj-1', title: 'متجر', status: 'PENDING_SIGNATURE', deliveryDays: 20, updatedAt: NOW, createdAt: NOW,
    projectProposals: [], proposals: [], escrow: null,
    contract: { id: 'c1', clientSignedAt: null, stages: [], provider: providerUser },
    ...over
  };
}

function setup(t: TestContext, projects: any[]) {
  const prismaMock: any = {
    clientProfile: { findUnique: async () => ({ id: 'cp1' }) },
    clientRequest: { findMany: async () => [] },
    project: { findMany: async () => projects },
    escrow: { findMany: async () => projects.filter(p => p.escrow).map(p => ({ projectId: p.id, ...p.escrow })) },
    contract: { findMany: async () => projects.filter(p => p.contract).map(p => ({ id: p.contract.id, projectId: p.id })) }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
}
const run = async (t: TestContext, projects: any[]) => {
  setup(t, projects);
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  return (await new ClientRequestsService().getActiveProjects('client-1')).projects;
};

test('R4: PENDING_SIGNATURE with no escrow is awaiting funding, not running (no run status, 0 progress, nothing held, accurate nextStep)', async (t) => {
  const [p] = await run(t, [project({ projectProposals: [{ status: 'PENDING_SIGNATURE', totalPrice: 500, provider: providerUser, milestones: [{ title: 'م1', days: 5, stepOrder: 1 }] }] })]);
  assert.equal(p.rawStatus, 'PENDING_SIGNATURE');
  assert.equal(p.status, 'pending');
  assert.equal(p.phase, 'awaiting_funding');
  assert.equal(p.funded, false);
  assert.equal(p.daysLeft, null, 'no countdown before the contract starts');
  assert.equal(p.progress, 0);
  assert.equal(p.heldAmount, 0);
  assert.equal(p.completedStages, 0);
  assert.equal(p.nextStep, 'توقيع العقد وإيداع الضمان لبدء التنفيذ');
});

test('PENDING_SIGNATURE with funded escrow waits for the provider signature', async (t) => {
  const [p] = await run(t, [project({ escrow: { status: 'HELD', amount: 500, releasedAmount: 0 } })]);
  assert.equal(p.status, 'pending');
  assert.equal(p.phase, 'awaiting_provider_signature');
  assert.equal(p.funded, true);
  assert.equal(p.heldAmount, 500);
  assert.equal(p.nextStep, 'بانتظار توقيع مقدم الخدمة لبدء التنفيذ');
});

test('the real provider name comes from the selected (PENDING_SIGNATURE) offer, not the generic fallback', async (t) => {
  const [p] = await run(t, [project({ proposals: [{ status: 'PENDING_SIGNATURE', price: 500, provider: providerUser }] })]);
  assert.equal(p.provider.name, 'سارة الأحمد');
});

test('the real provider name comes from the contract when no offer row is loaded', async (t) => {
  const [p] = await run(t, [project()]);
  assert.equal(p.provider.name, 'سارة الأحمد');
});

test('a funded, signed, running project is unchanged: run status, held amount, work step', async (t) => {
  const [p] = await run(t, [project({ status: 'IN_PROGRESS', escrow: { status: 'HELD', amount: 500, releasedAmount: 100 }, projectProposals: [{ status: 'ACCEPTED', totalPrice: 500, provider: providerUser, milestones: [] }], contract: { id: 'c1', clientSignedAt: NOW, stages: [], provider: providerUser } })]);
  assert.equal(p.status, 'run');
  assert.equal(p.heldAmount, 400);
  assert.equal(p.nextStep, 'متابعة تنفيذ المشروع');
});

test('progress is the approved stages only: no time-based guess for a running project without stage rows, and a stage share for approved ones', async (t) => {
  const old = new Date(Date.now() - 30 * 86400000);
  const [noStages] = await run(t, [project({ status: 'IN_PROGRESS', updatedAt: old, escrow: { status: 'HELD', amount: 500, releasedAmount: 0 }, projectProposals: [{ status: 'ACCEPTED', totalPrice: 500, provider: providerUser, milestones: [{ title: 'م1', days: 5, stepOrder: 1 }, { title: 'م2', days: 5, stepOrder: 2 }] }], contract: { id: 'c1', clientSignedAt: old, signedAt: old, stages: [], provider: providerUser } })]);
  assert.equal(noStages.progress, 0);
  assert.equal(noStages.completedStages, 0);
});

test('progress counts approved stages by their share; a submitted stage makes the project wait for the client review', async (t) => {
  const stages = [{ title: 'م1', status: 'APPROVED', percentage: 40, days: 5 }, { title: 'م2', status: 'SUBMITTED', percentage: 60, days: 5 }];
  const [p] = await run(t, [project({ status: 'AWAITING_DELIVERY', escrow: { status: 'HELD', amount: 500, releasedAmount: 200 }, contract: { id: 'c1', clientSignedAt: NOW, signedAt: NOW, stages, provider: providerUser } })]);
  assert.equal(p.progress, 40);
  assert.equal(p.completedStages, 1);
  assert.equal(p.status, 'wait');
  assert.equal(p.heldAmount, 300);
});

test('the overall KPI never says "جيد" without a reason, and the held KPI sums only really held escrows', async (t) => {
  setup(t, [project(), project({ id: 'proj-2', escrow: { status: 'HELD', amount: 500, releasedAmount: 0 } })]);
  const { ClientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`);
  const { kpis } = await new ClientRequestsService().getActiveProjects('client-1');
  assert.equal(kpis[1].value, 500);
  assert.notEqual(kpis[3].value, 'جيد');
});
