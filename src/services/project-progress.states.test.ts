import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// getProjectProgress exposes precise, server-derived delivery / revision / escrow state (see utils/delivery-state.ts).

async function load(t: TestContext) {
  const state: any = { contractStatus: 'ACTIVE', escrow: { status: 'HELD', amount: 300, releasedAmount: 0 }, stages: [] as any[] };
  const d = (id: string, status: string, reviewNote: string | null = null) => ({ id, status, note: 'n', files: [], reviewNote, submittedAt: new Date() });
  state.d = d;
  const contract = () => ({
    id: 'contract-1', projectId: 'project-1', providerId: 'p1', clientId: 'c1', price: 300, durationDays: 10, status: state.contractStatus, signedAt: new Date(), createdAt: new Date(), offerId: null,
    project: { title: 'T', escrow: state.escrow, assignedEmployee: null, conversations: [{ id: 'conv', providerId: 'p1', clientId: 'c1', messages: [] }] },
    client: { id: 'c1', firstName: 'C', lastName: 'L' }, provider: { id: 'p1', firstName: 'P', lastName: 'L' }
  });
  const prismaMock = {
    contract: { findFirst: async () => contract() },
    projectStage: { findMany: async () => state.stages },
    dispute: { findFirst: async () => null, count: async () => 0 },
    review: { findFirst: async () => null }
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./notification.service', { namedExports: { notificationService: {} } });
  t.mock.module('./email.service', { namedExports: { emailService: {} } });
  const { projectProgressService } = await import(`./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { svc: projectProgressService, state };
}

const stage = (id: string, stepOrder: number, status: string, deliveries: any[], amount = 100) => ({ id, stepOrder, title: `S${stepOrder}`, description: '', amount, percentage: 50, days: 5, status, approvedAt: null, deliveries, stageReviews: [] });

test('pending-signature contract: no upload permission, a reason, nothing "held" without a funded escrow', async t => {
  const { svc, state } = await load(t);
  state.contractStatus = 'PENDING_PROVIDER_SIGNATURE'; state.escrow = null;
  state.stages = [stage('s1', 1, 'PENDING', [])];
  const r = await svc.getProjectProgress('p1', 'project-1');
  assert.equal(r.contractStatus, 'PENDING_PROVIDER_SIGNATURE');
  assert.equal(r.canUploadDelivery, false);
  assert.match(r.uploadBlockedReason, /توقيعك/);
  assert.equal(r.escrowFunded, false);
  assert.equal(r.escrowHeld, 0);
  assert.equal(r.stages[0].canUploadDelivery, false);
  assert.equal(r.stages[0].amountHeld, false);
  assert.equal(r.statusLabel, 'بانتظار توقيعك على العقد');
});

test('revision requested -> re-submitted -> approved moves the edit card and the stage flags', async t => {
  const { svc, state } = await load(t);
  const d = state.d;
  state.stages = [stage('s1', 1, 'REVISION_REQUESTED', [d('d1', 'REVISION_REQUESTED', 'عدّل الشعار من فضلك')])];
  let r = await svc.getProjectProgress('p1', 'project-1');
  assert.equal(r.canUploadDelivery, true);
  assert.equal(r.revisionRequested, true);
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].status, 'waiting');
  assert.equal(r.edits[0].canUploadDelivery, true);
  assert.equal(r.stages[0].amountHeld, true);

  state.stages = [stage('s1', 1, 'SUBMITTED', [d('d1', 'REVISION_REQUESTED', 'عدّل الشعار من فضلك'), d('d2', 'SUBMITTED')])];
  r = await svc.getProjectProgress('p1', 'project-1');
  assert.equal(r.revisionRequested, false);
  assert.equal(r.revisionResubmitted, true);
  assert.equal(r.awaitingClientReview, true);
  assert.equal(r.canUploadDelivery, false);
  assert.ok(r.uploadBlockedReason);
  assert.equal(r.edits[0].status, 'resubmitted');
  assert.equal(r.edits[0].canUploadDelivery, false);

  state.stages = [stage('s1', 1, 'APPROVED', [d('d1', 'REVISION_REQUESTED', 'عدّل الشعار من فضلك'), d('d2', 'APPROVED')])];
  r = await svc.getProjectProgress('p1', 'project-1');
  assert.equal(r.edits[0].status, 'approved');
  assert.notEqual(r.edits[0].statusText, 'بانتظار إعادة التسليم');
  assert.equal(r.revisionResubmitted, false);
  assert.equal(r.stages[0].amountHeld, false);
});

test('the client side of the shared endpoint never gets an upload permission', async t => {
  const { svc, state } = await load(t);
  state.stages = [stage('s1', 1, 'IN_PROGRESS', [])];
  const r = await svc.getProjectProgress('c1', 'project-1');
  assert.equal(r.role, 'client');
  assert.equal(r.canUploadDelivery, false);
  assert.equal(r.stages[0].canUploadDelivery, false);
});
