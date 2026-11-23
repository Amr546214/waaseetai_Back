import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';

for (const party of ['CLIENT', 'PROVIDER'] as const) test(`setup progression ${party}: matches open setup without granting KYC, other outcomes remain closed`, async t => {
 process.env.IDENTITY_AUTO_CHECK = 'on'; t.after(() => delete process.env.IDENTITY_AUTO_CHECK);
 let state = 'MATCHED'; let kyc = 'PENDING'; let writes = 0; let legalName = 'عمرو محمود'; let dob: Date | null = new Date('1990-01-01');
 const row = () => ({ idNumber: '29001011234567', idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', dob, frontIdUrl: 'private:front', backIdUrl: null, kycStatus: kyc, identityApprovedDigest: null });
 const profile = { findUnique: async () => row(), update: async () => { writes++; }, updateMany: async () => { writes++; } };
 const db: any = { user: { findUnique: async () => ({ legalName }) }, clientProfile: profile, providerProfile: profile, clientOnboarding: { findUnique: async () => ({ status: 'PENDING', updatedAt: new Date() }) }, profileModificationRequest: { count: async () => 0 } };
 t.mock.module('./identity-field-check.service', { namedExports: { identityFieldCheckService: { getCurrentMatch: async () => ({ state }), triggerSafe() {} }, isIdentityAutoCheckEnabled: () => process.env.IDENTITY_AUTO_CHECK === 'on' } });
 const { identityGateService } = await import(`./identity-gate.service.ts?fixture=${Date.now()}-${party}`);
 const matched = await identityGateService.getState('u', party, db);
 assert.equal(matched.canAdvance, true); assert.equal(matched.status, 'UNDER_REVIEW'); assert.equal(matched.automaticCheck, 'MATCHED');
 await identityGateService.assertApproved('u', party, db);
 await identityGateService.assertApprovedForSubmission('u', party, {}, db);
 assert.equal(writes, 0, 'a match does not approve KYC, rewrite the profile or remove the human review');
 await assert.rejects(() => identityGateService.assertApprovedForSubmission('u', party, { idNumber: '29001011234568' }, db), (e: any) => e.code === 'IDENTITY_NOT_APPROVED');
 for (const bad of ['CHECKING', 'NEEDS_REVIEW', 'NOT_CHECKED']) { state = bad; assert.equal((await identityGateService.getState('u', party, db)).canAdvance, false); await assert.rejects(() => identityGateService.assertApproved('u', party, db)); }
 legalName = ''; dob = null;
 const incomplete = await identityGateService.getState('u', party, db);
 assert.deepEqual(incomplete.automaticCheckMissing, ['legalName', 'dob']);
 assert.equal(incomplete.data.hasFront, true); assert.equal(incomplete.canAdvance, false);
 assert.equal(incomplete.missing.includes('frontId'), false); assert.equal(writes, 0);
 legalName = 'عمرو محمود'; dob = new Date('1990-01-01');
 state = 'MATCHED'; kyc = 'REJECTED'; assert.equal((await identityGateService.getState('u', party, db)).canAdvance, false);
 kyc = 'PENDING'; delete process.env.IDENTITY_AUTO_CHECK; assert.equal((await identityGateService.getState('u', party, db)).canAdvance, false);
});
