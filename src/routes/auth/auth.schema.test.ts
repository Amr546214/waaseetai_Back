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
  legalName: 'Amr Mahmoud',
  username: 'Amr',
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
      assert.equal(!r.success && r.error.issues.some(i => i.message === 'حسابات الشركات قريبًا'), true);
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

test('registerSchema: the legal name and the username are two required, separate fields; a one-word username is fine and differs from the legal name', () => {
  const base = { ...validRegisterBody, accountType: 'PROVIDER_INDIVIDUAL' } as Record<string, unknown>;
  const ok = registerSchema.safeParse({ body: { ...base, username: 'عمرو', legalName: '  عمرو   محمود ' } });
  assert.equal(ok.success, true);
  if (ok.success) { assert.equal(ok.data.body.legalName, 'عمرو محمود'); assert.equal(ok.data.body.username, 'عمرو'); assert.notEqual(ok.data.body.legalName, ok.data.body.username); }
  const { legalName: _l, ...noLegal } = base; const { username: _u, ...noUser } = base;
  assert.equal(registerSchema.safeParse({ body: noLegal }).success, false, 'no legal name, no account');
  assert.equal(registerSchema.safeParse({ body: noUser }).success, false, 'no username, no account');
  for (const bad of ['عمرو', 'عمرو 12', '<b></b>', '']) assert.equal(registerSchema.safeParse({ body: { ...base, legalName: bad } }).success, false, `legal ${bad}`);
  for (const bad of ['', 'a@b.com', 'ع']) assert.equal(registerSchema.safeParse({ body: { ...base, username: bad } }).success, false, `username ${bad}`);
  // the legacy first/last name fields are no longer part of sign-up (ignored if an old client still sends them)
  const legacy = registerSchema.safeParse({ body: { ...base, firstName: 'X', lastName: 'Y' } });
  assert.equal(legacy.success, true); if (legacy.success) assert.equal((legacy.data.body as any).firstName, undefined);
});
