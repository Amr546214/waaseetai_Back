import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreateIdentityRequestSchema } from './profile-requests.dto';

// Post-safety-review decision: EMAIL must never be acceptable through the
// public marketer identity-change request payload (see profile-requests.
// dto.ts for the full reasoning). `.strict()` means a client sending `email`
// gets a validation error rather than having it silently stripped.

test('CreateIdentityRequestSchema: rejects a payload containing email', () => {
  const result = CreateIdentityRequestSchema.safeParse({ email: 'new@example.com' });
  assert.equal(result.success, false);
});

test('CreateIdentityRequestSchema: rejects email even alongside a valid field', () => {
  const result = CreateIdentityRequestSchema.safeParse({ nationalId: '2000000000', email: 'new@example.com' });
  assert.equal(result.success, false);
});

test('CreateIdentityRequestSchema: still accepts nationalId alone', () => {
  const result = CreateIdentityRequestSchema.safeParse({ nationalId: '2000000000' });
  assert.equal(result.success, true);
});

test('CreateIdentityRequestSchema: still accepts phoneNumber alone', () => {
  const result = CreateIdentityRequestSchema.safeParse({ phoneNumber: '0511111111' });
  assert.equal(result.success, true);
});

test('CreateIdentityRequestSchema: accepts both nationalId and phoneNumber together', () => {
  const result = CreateIdentityRequestSchema.safeParse({ nationalId: '2000000000', phoneNumber: '0511111111' });
  assert.equal(result.success, true);
});

test('CreateIdentityRequestSchema: rejects an empty payload (no field to change)', () => {
  const result = CreateIdentityRequestSchema.safeParse({});
  assert.equal(result.success, false);
});
