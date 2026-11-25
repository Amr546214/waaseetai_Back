import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (f: string) => readFileSync(join(process.cwd(), 'src/services', f), 'utf8');

// The claim is taken by the administrator's approval and freed by every way an approval ends: asserted on the real code paths.
test('wiring: both approvals take the claim inside their transaction, both rejections and every cancellation release it', () => {
  const onboarding = src('onboarding.service.ts');
  const approveClient = onboarding.slice(onboarding.indexOf('async approveOnboarding('), onboarding.indexOf('async rejectOnboarding('));
  assert.match(approveClient, /identityClaimService\.claim\(tx, item\.userId, 'CLIENT', evidence\)/);
  assert.ok(approveClient.indexOf('identityClaimService.claim') > approveClient.indexOf('approvalDigest('), 'the claim is taken together with the approval digest, on the locked row');
  assert.match(approveClient, /assertNoPossibleDuplicate\(tx, item\.userId, \{ legalName, dob: evidence\.dob \}, confirmNotDuplicate\)/);
  const rejectClient = onboarding.slice(onboarding.indexOf('async rejectOnboarding('), onboarding.indexOf('async listProviderKyc('));
  assert.match(rejectClient, /identityClaimService\.release\(tx, item\.userId, 'CLIENT'\)/);
  const approveProvider = onboarding.slice(onboarding.indexOf('async approveProviderKyc('), onboarding.indexOf('async rejectProviderKyc('));
  assert.match(approveProvider, /identityClaimService\.claim\(tx, userId, 'PROVIDER'/);
  assert.match(approveProvider, /assertNoPossibleDuplicate\(tx, userId, \{ legalName, dob: \(profile as any\)\.dob \}, confirmNotDuplicate\)/);
  const controller = src('../controllers/onboarding.controller.ts');
  assert.equal((controller.match(/req\.body\?\.confirmNotDuplicate === true/g) ?? []).length, 2, 'both approve endpoints read the administrator confirmation');
  const rejectProvider = onboarding.slice(onboarding.indexOf('async rejectProviderKyc('));
  assert.match(rejectProvider, /identityClaimService\.release\(tx, userId, 'PROVIDER'\)/);
  const gate = src('identity-gate.service.ts');
  assert.match(gate.slice(gate.indexOf('async cancelIfChanged(')), /identityClaimService\.release\(tx, userId, party\)/);
  assert.match(gate.slice(gate.indexOf('async saveIdentity(')), /if \(kyc === 'VERIFIED'\) await identityClaimService\.release\(tx, userId, party\)/);
  assert.match(src('legal-name.service.ts'), /identityClaimService\.release\(tx, userId, 'CLIENT'\)/);
});

test('saveIdentity refuses a duplicate identity BEFORE any file is stored (flag on, another account holds the number)', async () => {
  const stored: string[] = [];
  const claimOwner = { userId: 'someone-else' };
  const db: any = {
    clientProfile: { findUnique: async () => ({ kycStatus: 'UNVERIFIED' }) },
    providerProfile: { findUnique: async () => null },
    identityClaim: { findUnique: async () => claimOwner },
    $transaction: async () => { throw new Error('must not reach the transaction'); },
  };
  mock.module('../config/db', { namedExports: { prisma: db } });
  mock.module('../utils/cloudinary-storage', { namedExports: { storeKycFileIfNeeded: async (v: unknown) => { stored.push(String(v)); return 'https://example.test/x.jpg'; } } });
  process.env.IDENTITY_UNIQUE_ENFORCEMENT = 'on';
  try {
    const { IdentityGateService } = await import('./identity-gate.service?wiring');
    await assert.rejects(() => new IdentityGateService().saveIdentity('me', 'CLIENT', { idNumber: '1234567890', idIssuingCountry: 'SA', idDocumentType: 'NATIONAL_ID', frontId: 'data:image/png;base64,AAAA' }), (e: any) => e.statusCode === 409 && e.code === 'IDENTITY_ALREADY_REGISTERED');
    assert.deepEqual(stored, [], 'nothing was stored for the refused submission');
  } finally { delete process.env.IDENTITY_UNIQUE_ENFORCEMENT; mock.reset(); }
});

test('wiring: both approvals sweep other waiting accounts holding the same identity, after the commit', () => {
  const onboarding = src('onboarding.service.ts');
  const approveClient = onboarding.slice(onboarding.indexOf('async approveOnboarding('), onboarding.indexOf('async rejectPendingDuplicates(') > 0 ? onboarding.indexOf('async rejectPendingDuplicates(') : onboarding.indexOf('async rejectOnboarding('));
  assert.match(approveClient, /rejectPendingDuplicates\(item\.userId/);
  const approveProvider = onboarding.slice(onboarding.indexOf('async approveProviderKyc('), onboarding.indexOf('async rejectProviderKyc('));
  assert.match(approveProvider, /rejectPendingDuplicates\(userId/);
  const sweep = onboarding.slice(onboarding.indexOf('async rejectPendingDuplicates('), onboarding.indexOf('async rejectOnboarding('));
  assert.match(sweep, /identityUniqueEnforced\(\)/);
  assert.match(sweep, /IDENTITY_ALREADY_REGISTERED_MESSAGE/);
  assert.match(sweep, /rejectOnboarding\(/); assert.match(sweep, /rejectProviderKyc\(/);
});
