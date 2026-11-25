import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approvedIdentityFields } from './identity-inheritance';

const VERIFIED = { idNumber: '1051245098', idIssuingCountry: 'SA', idDocumentType: 'NATIONAL_ID', dob: new Date('1985-06-20'), frontIdUrl: 'private:front', backIdUrl: null, kycStatus: 'VERIFIED', identityApprovedDigest: 'abc', country: 'السعودية', city: 'الرياض' };
const tx = (client: any, provider: any = null) => ({ clientProfile: { findUnique: async () => client }, providerProfile: { findUnique: async () => provider } });

test('an approved client identity is carried to the new provider role, with its approval digest and the verified flag', async () => {
  const f = await approvedIdentityFields(tx(VERIFIED), 'u', 'PROVIDER');
  assert.equal(f.kycStatus, 'VERIFIED'); assert.equal(f.identityApprovedDigest, 'abc'); assert.equal(f.isVerified, true);
  assert.equal(f.idNumber, '1051245098'); assert.equal(f.frontIdUrl, 'private:front'); assert.equal(f.city, 'الرياض');
});
test('a pending, rejected, unsubmitted or digest-less identity is never carried', async () => {
  for (const over of [{ kycStatus: 'PENDING' }, { kycStatus: 'REJECTED' }, { kycStatus: 'UNVERIFIED' }, { identityApprovedDigest: null }, { frontIdUrl: null }, { idNumber: ' ' }]) {
    assert.deepEqual(await approvedIdentityFields(tx({ ...VERIFIED, ...over }), 'u', 'PROVIDER'), {}, JSON.stringify(over));
  }
  assert.deepEqual(await approvedIdentityFields(tx(null), 'u', 'PROVIDER'), {});
});
test('a provider identity is the source for a new client role (no verified flag on the client)', async () => {
  const f = await approvedIdentityFields(tx(null, VERIFIED), 'u', 'CLIENT');
  assert.equal(f.kycStatus, 'VERIFIED'); assert.equal('isVerified' in f, false);
});
test('a marketer role gets «verified» and the document reference from an approved client or provider identity, and nothing from an unapproved one', async () => {
  assert.deepEqual(await approvedIdentityFields(tx(VERIFIED), 'u', 'AFFILIATE'), { identityVerified: true, kycDocumentUrl: 'private:front' });
  assert.deepEqual(await approvedIdentityFields(tx(null, VERIFIED), 'u', 'AFFILIATE'), { identityVerified: true, kycDocumentUrl: 'private:front' });
  assert.deepEqual(await approvedIdentityFields(tx({ ...VERIFIED, kycStatus: 'PENDING' }, { ...VERIFIED, kycStatus: 'REJECTED' }), 'u', 'AFFILIATE'), {});
});
test('wiring: adding the provider role seeds the profile with the carried identity', () => {
  const src = readFileSync('src/services/account-management.service.ts', 'utf8');
  assert.match(src, /approvedIdentityFields\(tx, user\.id, 'PROVIDER'\)/);
  assert.match(src, /approvedIdentityFields\(tx, user\.id, 'CLIENT'\)/);
  assert.match(src, /approvedIdentityFields\(tx, user\.id, 'AFFILIATE'\)/);
  assert.match(src, /\.\.\.inherited,/);
});
