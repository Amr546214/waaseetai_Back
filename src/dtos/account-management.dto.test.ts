import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddAccountTypeSchema, SwitchActiveRoleSchema, SelfServiceUserRoleEnum } from './account-management.dto';

// P0-1 remediation — defense-in-depth layer 1: the request DTO itself must
// reject ADMIN/SUPER_ADMIN before the service layer ever sees them. These
// roles are internal/operator roles provisioned out-of-band, never through a
// self-service request body.

test('SelfServiceUserRoleEnum: accepts CLIENT, PROVIDER, AFFILIATE', () => {
  for (const role of ['CLIENT', 'PROVIDER', 'AFFILIATE']) {
    assert.equal(SelfServiceUserRoleEnum.safeParse(role).success, true);
  }
});

test('SelfServiceUserRoleEnum: rejects ADMIN and SUPER_ADMIN', () => {
  assert.equal(SelfServiceUserRoleEnum.safeParse('ADMIN').success, false);
  assert.equal(SelfServiceUserRoleEnum.safeParse('SUPER_ADMIN').success, false);
});

test('AddAccountTypeSchema: rejects targetRole=ADMIN', () => {
  const result = AddAccountTypeSchema.safeParse({ targetRole: 'ADMIN' });
  assert.equal(result.success, false);
});

test('AddAccountTypeSchema: rejects targetRole=SUPER_ADMIN', () => {
  const result = AddAccountTypeSchema.safeParse({ targetRole: 'SUPER_ADMIN' });
  assert.equal(result.success, false);
});

test('AddAccountTypeSchema: still accepts CLIENT/PROVIDER/AFFILIATE with optional profileMetadata', () => {
  for (const role of ['CLIENT', 'PROVIDER', 'AFFILIATE']) {
    const result = AddAccountTypeSchema.safeParse({ targetRole: role, profileMetadata: { coName: 'Acme' } });
    assert.equal(result.success, true);
  }
});

test('SwitchActiveRoleSchema: rejects targetRole=ADMIN and SUPER_ADMIN', () => {
  assert.equal(SwitchActiveRoleSchema.safeParse({ targetRole: 'ADMIN' }).success, false);
  assert.equal(SwitchActiveRoleSchema.safeParse({ targetRole: 'SUPER_ADMIN' }).success, false);
});

test('SwitchActiveRoleSchema: still accepts CLIENT/PROVIDER/AFFILIATE (existing multi-role switch behavior preserved)', () => {
  for (const role of ['CLIENT', 'PROVIDER', 'AFFILIATE']) {
    assert.equal(SwitchActiveRoleSchema.safeParse({ targetRole: role }).success, true);
  }
});
