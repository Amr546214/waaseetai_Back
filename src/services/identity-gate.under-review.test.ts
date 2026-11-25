import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

const row = (over: Record<string, unknown> = {}) => ({ idNumber: '30408012203296', idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', dob: new Date('2004-08-01'), frontIdUrl: 'private:front', backIdUrl: null, kycStatus: 'PENDING', identityApprovedDigest: null, notes: null, ...over });
const db = (r: any) => ({ providerProfile: { findUnique: async () => r }, clientProfile: { findUnique: async () => r }, user: { findUnique: async () => ({ legalName: 'عمرو محمود يحيى محمد' }) }, profileModificationRequest: { count: async () => 0 }, clientOnboarding: { findUnique: async () => null } });

// A provider whose document has been SENT may carry on with the later steps while the admin decides; nothing else opens.
test('assertApproved: under review passes only when allowUnderReview is set; not submitted / rejected never pass', async t => {
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  const { identityGateService } = await import(`./identity-gate.service.ts?fixture=${Date.now()}`);
  await assert.rejects(() => identityGateService.assertApproved('u', 'PROVIDER', db(row())), (e: any) => e.statusCode === 409);
  await identityGateService.assertApproved('u', 'PROVIDER', db(row()), { allowUnderReview: true });
  await assert.rejects(() => identityGateService.assertApproved('u', 'PROVIDER', db(row({ frontIdUrl: null })), { allowUnderReview: true }), (e: any) => e.statusCode === 409);
  await assert.rejects(() => identityGateService.assertApproved('u', 'PROVIDER', db(row({ kycStatus: 'REJECTED' })), { allowUnderReview: true }), (e: any) => e.statusCode === 409);
});

test('assertApprovedForSubmission: a provider and a client under review pass (the client registration is sent while the review is pending); changing the evidence is still refused', async t => {
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  const { identityGateService } = await import(`./identity-gate.service.ts?fixture=${Date.now()}b`);
  await identityGateService.assertApprovedForSubmission('u', 'PROVIDER', {}, db(row()));
  await identityGateService.assertApprovedForSubmission('u', 'CLIENT', {}, db(row()));
  await assert.rejects(() => identityGateService.assertApprovedForSubmission('u', 'CLIENT', {}, db(row({ frontIdUrl: null }))), (e: any) => e.statusCode === 409); // not submitted: still refused
  await assert.rejects(() => identityGateService.assertApprovedForSubmission('u', 'PROVIDER', { idNumber: '30408012203269' }, db(row())), (e: any) => e.statusCode === 409);
});
