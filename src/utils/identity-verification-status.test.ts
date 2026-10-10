import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIdentityVerification } from './identity-verification-status';

const at = new Date('2026-10-10T10:00:00Z');
test('waiting for the admin -> PENDING_REVIEW with the request id and submission time (even if a document is already stored)', () => {
  const r = deriveIdentityVerification({ pendingDocumentReview: true, storedIdDocument: true, latestDocumentRequest: { id: 'r1', status: 'PENDING_HUMAN_REVIEW', createdAt: at, rejectionReason: null } });
  assert.deepEqual(r, { status: 'PENDING_REVIEW', requestId: 'r1', submittedAt: at.toISOString(), rejectionReason: null });
});
test('approved (document stored, nothing waiting) -> VERIFIED', () => {
  assert.equal(deriveIdentityVerification({ pendingDocumentReview: false, storedIdDocument: true, latestDocumentRequest: null }).status, 'VERIFIED');
});
test('rejected with nothing stored -> REJECTED with the admin reason; a stored document wins over an old rejection', () => {
  const rej = { id: 'r2', status: 'REJECTED', createdAt: at, rejectionReason: 'الصورة غير واضحة' };
  assert.deepEqual(deriveIdentityVerification({ pendingDocumentReview: false, storedIdDocument: false, latestDocumentRequest: rej }), { status: 'REJECTED', requestId: 'r2', submittedAt: at.toISOString(), rejectionReason: 'الصورة غير واضحة' });
  assert.equal(deriveIdentityVerification({ pendingDocumentReview: false, storedIdDocument: true, latestDocumentRequest: rej }).status, 'VERIFIED');
});
test('nothing sent -> NOT_SUBMITTED', () => {
  assert.deepEqual(deriveIdentityVerification({ pendingDocumentReview: false, storedIdDocument: false, latestDocumentRequest: null }), { status: 'NOT_SUBMITTED', requestId: null, submittedAt: null, rejectionReason: null });
});
