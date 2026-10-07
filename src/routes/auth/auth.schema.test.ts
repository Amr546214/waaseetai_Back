import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSchema, googleAuthSchema, PublicAccountTypeEnum } from './auth.schema';

// P0-1 remediation — same privilege-escalation class as addAccountType, found
// in the public/unauthenticated new-account signup paths: both email/password
// registration and Google sign-up previously validated `accountType` against
// the FULL Prisma AccountType enum (via z.nativeEnum(AccountType)), which
// includes ADMIN, SUPER_ADMIN and EMPLOYEE. Since registerUser/googleAuth
// write `accountType` straight onto the new User row, and auth.middleware's
// authorize() grants access on a direct accountType match, an unauthenticated
// caller could previously register (or Google sign-up) directly as ADMIN.

const validRegisterBody = {
  firstName: 'Amr',
  lastName: 'Okasha',
  email: 'amr@example.com',
  phoneCountryCode: '+966',
  phoneNumber: '500000000',
  password: 'Password1',
  agreedToTerms: true as const
};

test('PublicAccountTypeEnum: accepts the individual / marketer self-service account types (company types are unavailable, see below)', () => {
  for (const accountType of ['CLIENT_INDIVIDUAL', 'PROVIDER_INDIVIDUAL', 'MARKETING_BROKER']) {
    assert.equal(PublicAccountTypeEnum.safeParse(accountType).success, true);
  }
});

test('company accounts are outside the current launch: registration and Google sign-up refuse them in Arabic', () => {
  for (const accountType of ['CLIENT_COMPANY', 'PROVIDER_COMPANY']) {
    for (const r of [registerSchema.safeParse({ body: { ...validRegisterBody, accountType } }), googleAuthSchema.safeParse({ body: { idToken: 't', accountType } })]) {
      assert.equal(r.success, false);
      assert.equal(!r.success && r.error.issues.some(i => i.message === 'حسابات الشركات غير متاحة حاليًا'), true);
    }
  }
  for (const accountType of ['CLIENT_INDIVIDUAL', 'PROVIDER_INDIVIDUAL', 'MARKETING_BROKER']) {
    assert.equal(registerSchema.safeParse({ body: { ...validRegisterBody, accountType } }).success, true);
  }
});

test('PublicAccountTypeEnum: rejects ADMIN, SUPER_ADMIN and EMPLOYEE', () => {
  assert.equal(PublicAccountTypeEnum.safeParse('ADMIN').success, false);
  assert.equal(PublicAccountTypeEnum.safeParse('SUPER_ADMIN').success, false);
  assert.equal(PublicAccountTypeEnum.safeParse('EMPLOYEE').success, false);
});

test('registerSchema: public signup cannot request accountType=ADMIN', () => {
  const result = registerSchema.safeParse({ body: { ...validRegisterBody, accountType: 'ADMIN' } });
  assert.equal(result.success, false);
});

test('registerSchema: public signup cannot request accountType=SUPER_ADMIN', () => {
  const result = registerSchema.safeParse({ body: { ...validRegisterBody, accountType: 'SUPER_ADMIN' } });
  assert.equal(result.success, false);
});

test('registerSchema: legitimate account types (e.g. PROVIDER_INDIVIDUAL) still validate successfully', () => {
  const result = registerSchema.safeParse({ body: { ...validRegisterBody, accountType: 'PROVIDER_INDIVIDUAL' } });
  assert.equal(result.success, true);
});

test('googleAuthSchema: new-account Google signup cannot request accountType=ADMIN', () => {
  const result = googleAuthSchema.safeParse({ body: { idToken: 'x', accountType: 'ADMIN' } });
  assert.equal(result.success, false);
});

test('googleAuthSchema: new-account Google signup cannot request accountType=SUPER_ADMIN', () => {
  const result = googleAuthSchema.safeParse({ body: { idToken: 'x', accountType: 'SUPER_ADMIN' } });
  assert.equal(result.success, false);
});

test('googleAuthSchema: accountType remains optional (existing-user Google login unaffected) and legitimate types still validate', () => {
  assert.equal(googleAuthSchema.safeParse({ body: { idToken: 'x' } }).success, true);
  assert.equal(googleAuthSchema.safeParse({ body: { idToken: 'x', accountType: 'CLIENT_INDIVIDUAL' } }).success, true);
});
