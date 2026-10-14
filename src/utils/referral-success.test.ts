import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveReferralStatus, isRealDueCommission, successfulReferralIds, realCommissionWhere } from './referral-success';

test('a referral is successful only through a REAL due commission: a stage release (sourceStageId) that is APPROVED or PAID', () => {
  assert.equal(isRealDueCommission({ type: 'STAGE_RELEASE', sourceStageId: 's1', status: 'APPROVED' }), true);
  assert.equal(isRealDueCommission({ type: 'STAGE_RELEASE', sourceStageId: 's1', status: 'PAID' }), true);
  assert.equal(isRealDueCommission({ type: 'STAGE_RELEASE', sourceStageId: 's1', status: 'PENDING' }), false, 'not due yet');
  assert.equal(isRealDueCommission({ type: 'FIRST_PROJECT_COMPLETED', sourceStageId: null, status: 'APPROVED' }), false, 'a seeded / manual ledger row has no real operation');
  assert.equal(isRealDueCommission({ type: 'STAGE_RELEASE', sourceStageId: null, status: 'APPROVED' }), false, 'no source stage = not a real release');
});

test('the status shown is CONVERTED for a successful referral whatever is stored, otherwise the stored one', () => {
  assert.equal(effectiveReferralStatus('PENDING', true), 'CONVERTED');
  assert.equal(effectiveReferralStatus('QUALIFIED', true), 'CONVERTED');
  assert.equal(effectiveReferralStatus('PENDING', false), 'PENDING');
});

test('successful ids are distinct referrals (two commissions of one referral count once; null referrals are ignored) and the query excludes seeds and unpaid rows', async () => {
  let seen: any;
  const db: any = { commissionLog: { groupBy: async (args: any) => { seen = args; return [{ referralId: 'r1' }, { referralId: 'r1' }, { referralId: null }, { referralId: 'r2' }]; } } };
  const ids = await successfulReferralIds(db, 'aff-1');
  assert.deepEqual([...ids].sort(), ['r1', 'r2']);
  assert.deepEqual(seen.where, realCommissionWhere('aff-1'));
  assert.deepEqual(seen.where.sourceStageId, { not: null });
  assert.deepEqual(seen.where.status, { in: ['APPROVED', 'PAID'] });
  assert.equal(seen.where.type, 'STAGE_RELEASE');
});
