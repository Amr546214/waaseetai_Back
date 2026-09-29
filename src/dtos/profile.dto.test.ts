import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateProfileSchema } from './profile.dto';

// Payout P2-A: paypalPayoutEmail validation lives entirely on this schema —
// the service layer trusts an already-parsed DTO, so format/normalization
// rules must be proven here, not against the service.

test('updateProfileSchema: B. an invalid paypalPayoutEmail is rejected', () => {
  const result = updateProfileSchema.safeParse({ paypalPayoutEmail: 'not-an-email' });
  assert.equal(result.success, false);
});

test('updateProfileSchema: B. a valid paypalPayoutEmail is accepted', () => {
  const result = updateProfileSchema.safeParse({ paypalPayoutEmail: 'provider@example.com' });
  assert.equal(result.success, true);
});

test('updateProfileSchema: C. paypalPayoutEmail is trimmed and lowercased', () => {
  const result = updateProfileSchema.safeParse({ paypalPayoutEmail: '  Provider@Example.COM  ' });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.paypalPayoutEmail, 'provider@example.com');
  }
});

test('updateProfileSchema: paypalPayoutEmail accepts an empty string (the "cleared" representation)', () => {
  const result = updateProfileSchema.safeParse({ paypalPayoutEmail: '' });
  assert.equal(result.success, true);
});

test('updateProfileSchema: paypalPayoutEmail is optional and omitting it is valid', () => {
  const result = updateProfileSchema.safeParse({});
  assert.equal(result.success, true);
});
