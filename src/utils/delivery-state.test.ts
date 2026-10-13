import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractDeliveryState, editState, escrowFacts, listStatus, stageDeliveryState } from './delivery-state';

const held = { status: 'HELD', amount: 1000, releasedAmount: 250 };
const stage = (status: string, ...deliveries: string[]) => ({ status, deliveries: deliveries.map(status => ({ status })) });

test('pending-signature / pending-payment contract: no upload, with a visible reason', () => {
  for (const c of ['PENDING_PROVIDER_SIGNATURE', 'PENDING_CLIENT_SIGNATURE', 'PENDING_PAYMENT', 'COMPLETED', 'CANCELLED', 'DISPUTED']) {
    const s = contractDeliveryState(c, [stage('IN_PROGRESS')], null);
    assert.equal(s.canUploadDelivery, false, c);
    assert.equal(s.canSubmitDelivery, false, c);
    assert.ok(s.uploadBlockedReason, c);
    assert.equal(stageDeliveryState(c, stage('IN_PROGRESS')).canUploadDelivery, false, c);
  }
  assert.match(contractDeliveryState('PENDING_PROVIDER_SIGNATURE', [], null).uploadBlockedReason!, /توقيعك/);
});

test('active contract: only an IN_PROGRESS / REVISION_REQUESTED stage can be delivered', () => {
  assert.equal(stageDeliveryState('ACTIVE', stage('IN_PROGRESS')).canUploadDelivery, true);
  assert.equal(stageDeliveryState('ACTIVE', stage('IN_PROGRESS')).uploadBlockedReason, null);
  assert.equal(stageDeliveryState('ACTIVE', stage('REVISION_REQUESTED', 'REVISION_REQUESTED')).canUploadDelivery, true);
  for (const st of ['PENDING', 'SUBMITTED', 'APPROVED']) {
    const s = stageDeliveryState('ACTIVE', stage(st, 'SUBMITTED'));
    assert.equal(s.canUploadDelivery, false, st);
    assert.ok(s.uploadBlockedReason, st);
  }
});

test('revision requested, then re-submitted, changes the state', () => {
  const asked = stageDeliveryState('ACTIVE', stage('REVISION_REQUESTED', 'REVISION_REQUESTED'));
  assert.deepEqual([asked.revisionRequested, asked.revisionResubmitted, asked.awaitingClientReview, asked.canUploadDelivery], [true, false, false, true]);
  const again = stageDeliveryState('ACTIVE', stage('SUBMITTED', 'REVISION_REQUESTED', 'SUBMITTED'));
  assert.deepEqual([again.revisionRequested, again.revisionResubmitted, again.awaitingClientReview, again.canUploadDelivery], [false, true, true, false]);
  assert.equal(listStatus(contractDeliveryState('ACTIVE', [stage('SUBMITTED', 'REVISION_REQUESTED', 'SUBMITTED')], held), 5, 0).status, 'wait');
  assert.equal(listStatus(contractDeliveryState('ACTIVE', [stage('REVISION_REQUESTED', 'REVISION_REQUESTED')], held), 5, 0).statusLabel, 'مطلوب تعديل منك');
});

test('an approved stage is not "awaiting re-delivery" any more', () => {
  const approved = stageDeliveryState('ACTIVE', stage('APPROVED', 'REVISION_REQUESTED', 'APPROVED'));
  assert.deepEqual([approved.revisionRequested, approved.revisionResubmitted, approved.awaitingClientReview], [false, false, false]);
  assert.equal(editState('APPROVED', 0, 2).status, 'approved');
  assert.equal(editState('REVISION_REQUESTED', 0, 1).status, 'waiting');
  assert.equal(editState('SUBMITTED', 0, 2).status, 'resubmitted');
  assert.match(editState('SUBMITTED', 0, 2).statusText, /بانتظار مراجعة العميل/);
  assert.equal(editState('REVISION_REQUESTED', 0, 3).status, 'resubmitted'); // answered; a newer edit exists
});

test('escrow: held only when a funded (HELD) escrow exists', () => {
  assert.deepEqual(escrowFacts(null), { escrowStatus: null, escrowFunded: false, heldAmount: 0 });
  assert.deepEqual(escrowFacts(held), { escrowStatus: 'HELD', escrowFunded: true, heldAmount: 750 });
  assert.deepEqual(escrowFacts({ status: 'REFUNDED', amount: 500 }), { escrowStatus: 'REFUNDED', escrowFunded: false, heldAmount: 0 });
});

test('list status: unstarted contracts are pending, not "waiting for the client"', () => {
  assert.equal(listStatus(contractDeliveryState('PENDING_PAYMENT', [], null), 10, 0).status, 'pending');
  assert.equal(listStatus(contractDeliveryState('ACTIVE', [stage('IN_PROGRESS')], held), 10, 0).statusLabel, 'قيد التنفيذ');
  assert.equal(listStatus(contractDeliveryState('ACTIVE', [stage('IN_PROGRESS')], held), 0, 40).status, 'late');
  assert.equal(contractDeliveryState('ACTIVE', [stage('IN_PROGRESS')], held, 'OPEN').disputeStatus, 'OPEN');
});
