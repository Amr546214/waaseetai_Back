import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentUpdate } from './identity-document-context';
import { assertVerifiedIdentityUnchanged, identitySubmissionChanged } from './kyc-identity-guard';

test('international passport numbers require a complete document context, while legacy input retains its rule', () => {
  const passport = { idIssuingCountry: 'GB', idDocumentType: 'PASSPORT' };
  assert.deepEqual(documentUpdate({ ...passport, idNumber: 'A01234-9' }), passport);
  assert.throws(() => documentUpdate({ idIssuingCountry: 'GB', idNumber: 'A01234-9' }));
  assert.throws(() => documentUpdate({ idNumber: 'A01234-9' }));
  assert.deepEqual(documentUpdate({ idNumber: '1234567890' }), {});
  assert.throws(() => documentUpdate({ idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', idNumber: 'A01234-9' }));
  assert.deepEqual(documentUpdate({ idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', idNumber: '29001011234567' }), { idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID' });
});

test('changing the issuing country counts as a new identity and cannot bypass the verified lock', () => {
  const saved = { idNumber: 'A01234-9', idIssuingCountry: 'GB', idDocumentType: 'PASSPORT', kycStatus: 'VERIFIED' };
  const change = { idIssuingCountry: 'CA', idDocumentType: 'PASSPORT' };
  assert.equal(identitySubmissionChanged(saved, change, {}), true);
  assert.throws(() => assertVerifiedIdentityUnchanged(saved, change));
  assert.doesNotThrow(() => assertVerifiedIdentityUnchanged(saved, saved));
});
