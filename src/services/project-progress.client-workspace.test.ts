import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// The client's project workspace tells the truth about money and whose turn it is: nothing is "held" before the escrow is HELD, the contract
// status is worded for the client (not the provider), and each stage keeps its real state (submitted / revision requested / resubmitted / approved).
const NOW = new Date();
const stage = (over: any) => ({ id: 's', contractId: 'c1', stepOrder: 1, title: 'م', description: '', amount: 100, percentage: 50, days: 3, status: 'PENDING', approvedAt: null, deliveries: [], stageReviews: [], ...over });
const delivery = (status: string) => ({ id: `d-${status}`, status, submittedAt: NOW, note: 'ن', files: [], reviewNote: null });

async function workspace(t: TestContext, o: { contract?: any; escrow?: any; stages?: any[]; preProject?: any }) {
  const contract = o.preProject ? null : {
    id: 'c1', projectId: 'p1', clientId: 'client-1', providerId: 'prov-1', price: 200, durationDays: 10, signedAt: null, createdAt: NOW, status: 'PENDING_CLIENT_SIGNATURE', ...o.contract,
    project: { title: 'مشروع', escrow: o.escrow ?? null, conversations: [{ providerId: 'prov-1', clientId: 'client-1', id: 'conv', messages: [] }], assignedEmployee: null },
    client: { id: 'client-1', firstName: 'ع', lastName: '' }, provider: { id: 'prov-1', firstName: 'سارة', lastName: 'م' }
  };
  const prismaMock: any = {
    contract: { findFirst: async () => contract },
    project: { findFirst: async () => o.preProject ?? null },
    projectStage: { findMany: async () => o.stages ?? [] },
    dispute: { findFirst: async () => null, count: async () => 0 },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const mod = await import(`./project-progress.service.ts?f=${Date.now()}-${Math.random()}`);
  return mod.projectProgressService.getProjectProgress('client-1', 'p1');
}

test('unfunded contract: nothing held, funded=false, status worded for the client (sign + fund), no running state', async t => {
  const r = await workspace(t, { stages: [stage({ id: 's1' })] });
  assert.equal(r.escrowHeld, 0);
  assert.equal(r.escrowFunded, false);
  assert.equal(r.statusLabel, 'بانتظار توقيعك وإيداع الضمان');
  assert.equal(r.stages[0].amountHeld, false);
});

test('funded contract waiting for the provider signature: held money is real, and the label names the provider, not the client', async t => {
  const r = await workspace(t, { contract: { status: 'PENDING_PROVIDER_SIGNATURE' }, escrow: { status: 'HELD', amount: 200, releasedAmount: 0 }, stages: [stage({ id: 's1' })] });
  assert.equal(r.escrowHeld, 200);
  assert.equal(r.escrowFunded, true);
  assert.equal(r.statusLabel, 'بانتظار توقيع مقدم الخدمة');
});

test('unfunded contract in the provider-signature state is never "waiting for the provider only"', async t => {
  const r = await workspace(t, { contract: { status: 'PENDING_PROVIDER_SIGNATURE' }, stages: [stage({ id: 's1' })] });
  assert.equal(r.escrowHeld, 0);
  assert.notEqual(r.statusLabel, 'بانتظار توقيع مقدم الخدمة');
});

test('pre-contract fallback: an escrow row that is not HELD holds nothing; the selected offer (PENDING_SIGNATURE) gives the price and provider name', async t => {
  const r = await workspace(t, { preProject: { id: 'p1', clientId: 'client-1', title: 'مشروع', deliveryDays: 10, escrow: { status: 'REFUNDED', amount: 200 }, proposals: [{ price: 200, status: 'PENDING_SIGNATURE', provider: { id: 'prov-1', firstName: 'سارة', lastName: 'م' } }], assignedEmployee: null } });
  assert.equal(r.escrowHeld, 0);
  assert.equal(r.price, 200);
  assert.equal(r.clientName, 'سارة م');
  assert.equal(r.statusLabel, 'بانتظار توقيعك وإيداع الضمان');
});

test('each stage keeps its real state: pending / submitted / revision requested / resubmitted / approved', async t => {
  const r = await workspace(t, {
    contract: { status: 'ACTIVE' }, escrow: { status: 'HELD', amount: 200, releasedAmount: 100 },
    stages: [
      stage({ id: 'a', stepOrder: 1, status: 'APPROVED', deliveries: [delivery('APPROVED')] }),
      stage({ id: 'b', stepOrder: 2, status: 'SUBMITTED', deliveries: [delivery('SUBMITTED')] }),
    ]
  });
  const [a, b] = r.stages;
  assert.equal(a.status, 'completed'); assert.equal(a.amountHeld, false);
  assert.equal(b.status, 'submitted'); assert.equal(b.awaitingClientReview, true); assert.equal(b.revisionResubmitted, false); assert.equal(b.amountHeld, true);

});

test('a revision request and the provider\'s resubmission are told apart', async t => {
  const rev = await workspace(t, { contract: { status: 'ACTIVE' }, escrow: { status: 'HELD', amount: 200, releasedAmount: 0 }, stages: [stage({ id: 'r', status: 'REVISION_REQUESTED', deliveries: [delivery('REVISION_REQUESTED')] })] });
  assert.equal(rev.stages[0].status, 'revision');
  assert.equal(rev.stages[0].revisionRequested, true);
  assert.equal(rev.stages[0].awaitingClientReview, false);
});

test('a resubmitted stage (revision asked earlier, delivered again) waits for the client and says so', async t => {
  const r = await workspace(t, { contract: { status: 'ACTIVE' }, escrow: { status: 'HELD', amount: 200, releasedAmount: 0 }, stages: [stage({ id: 'x', status: 'SUBMITTED', deliveries: [delivery('REVISION_REQUESTED'), delivery('SUBMITTED')] })] });
  assert.equal(r.stages[0].revisionResubmitted, true);
  assert.equal(r.stages[0].awaitingClientReview, true);
  assert.match(r.stages[0].statusText, /أُعيد التسليم/);
});
