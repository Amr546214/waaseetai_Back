import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientSetupSchema } from './client-profile-setup.dto';
import { updateBankingSchema } from './profile-tab.dto';

// PayPal is the only money method: bank / IBAN / holder / wallet values are rejected by the schemas, never silently saved.

test('banking tab accepts a PayPal email only; bank / wallet fields are rejected', () => {
  assert.equal(updateBankingSchema.safeParse({ paymentMethod: 'paypal', paypalPayoutEmail: 'a@b.com' }).success, true);
  for (const extra of [{ iban: 'SA03' }, { bankName: 'x' }, { accountHolder: 'x' }, { walletPhone: '050' }, { walletProvider: 'x' }]) {
    assert.equal(updateBankingSchema.safeParse({ paypalPayoutEmail: 'a@b.com', ...extra }).success, false, JSON.stringify(extra));
  }
});

test('setup payload: bank object with non-PayPal keys or a non-PayPal paymentType is rejected', () => {
  const base = (bank: any) => clientSetupSchema.safeParse({ bank } as any);
  const bad = [{ paymentType: 'bank' }, { paymentType: 'paypal', iban: 'SA03' }, { paypalPayoutEmail: 'a@b.com', walletNumber: '1' }];
  for (const b of bad) assert.equal(base(b).success === true && JSON.stringify(base(b).data?.bank).includes('iban'), false);
  for (const b of bad) assert.equal(base(b).success, false, JSON.stringify(b));
});
