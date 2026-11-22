import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.QA_ISOLATED_PG_URL;
const opts = { skip: !(url && url === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(url)) };
process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x';

for (const [accountType, party] of [['CLIENT_INDIVIDUAL', 'CLIENT'], ['CLIENT_COMPANY', 'CLIENT'], ['PROVIDER_INDIVIDUAL', 'PROVIDER'], ['PROVIDER_COMPANY', 'PROVIDER']] as const) test(`PG ${accountType}: a persisted full match opens setup without KYC approval; changed evidence closes it`, opts, async t => {
 const { prisma } = await import('../config/db');
 const { IdentityFieldCheckService, identityFieldCheckService } = await import('./identity-field-check.service');
 const { identityGateService } = await import('./identity-gate.service');
 const { IdentityCompareTestDouble, syntheticImage } = await import('../testing/identity-compare.test-double');
 const previousFlag = process.env.IDENTITY_AUTO_CHECK; process.env.IDENTITY_AUTO_CHECK = 'on';
 t.after(() => { if (previousFlag === undefined) delete process.env.IDENTITY_AUTO_CHECK; else process.env.IDENTITY_AUTO_CHECK = previousFlag; });
 // Only suppress unrelated background work; persisted checks and the gate use the REAL database.
 t.mock.method(identityFieldCheckService, 'triggerSafe', () => undefined);
 const uid = randomUUID(); const legalName = 'اسم مطابق كامل';
 await prisma.user.create({ data: { id: uid, accountType, status: 'ACTIVE', roles: [party], activeRole: party, firstName: 'Public', lastName: 'Name', legalName, email: `progress-${uid}@pg.test` } });
 const model = party === 'CLIENT' ? prisma.clientProfile : prisma.providerProfile;
 const front = `private:image:jpg:waseetai/${party.toLowerCase()}/${uid}/identity/front-id-a`;
 await model.create({ data: { userId: uid, idNumber: '29001011234567', idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', dob: new Date('1990-01-01'), frontIdUrl: front, kycStatus: 'PENDING' } } as any);
 if (party === 'CLIENT') await prisma.clientOnboarding.create({ data: { userId: uid, documentType: 'NATIONAL_ID', documentUrl: front, documentName: 'هوية تجريبية', status: 'PENDING' } });
 const ai = new IdentityCompareTestDouble();
 const checker = new IdentityFieldCheckService({ db: prisma, ai, fetchImage: async () => ({ bytes: syntheticImage({ name: legalName, dob: '1990-01-01', id: '29001011234567' }), mimeType: 'image/jpeg' }), enabled: () => true, now: () => new Date() });
 await checker.trigger(uid, party);
 let state = await identityGateService.getState(uid, party);
 assert.equal(state.status, 'UNDER_REVIEW'); assert.equal(state.canAdvance, true); assert.equal(state.automaticCheck, 'MATCHED');
 await identityGateService.assertApproved(uid, party);
 await identityGateService.assertApprovedForSubmission(uid, party, {});
 await assert.rejects(() => identityGateService.assertApprovedForSubmission(uid, party, { idNumber: '29001011234568' }), (e: any) => e.code === 'IDENTITY_NOT_APPROVED');
 if (party === 'CLIENT') {
  const { clientProfileController } = await import('../controllers/client-profile.controller');
  const response: any = { code: 0, body: null, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
  let error: any;
  await clientProfileController.saveSetupData({ user: { userId: uid, id: uid }, body: { details: { idNumber: '29001011234567', idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', dob: '1990-01-01', country: 'مصر', city: 'القاهرة', occupation: 'مهندس', address: 'عنوان تجريبي' }, identity: {}, documents: {}, agreements: { accurate: true, terms: true, privacy: true } } } as any, response, e => { error = e; });
  assert.equal(error, undefined); assert.equal(response.code, 200, JSON.stringify(response.body)); assert.equal(response.body.data.isProfileComplete, true, 'the REAL final setup handler completes without an admin approval');
 }
 const profile: any = await model.findUnique({ where: { userId: uid } } as any);
 assert.equal(profile.kycStatus, 'PENDING'); assert.equal(profile.identityApprovedDigest, null);
 if (party === 'PROVIDER') assert.equal(profile.isVerified, false);
 if (party === 'CLIENT') assert.equal((await prisma.clientOnboarding.findUniqueOrThrow({ where: { userId: uid } })).status, 'PENDING');
 assert.equal(await prisma.identityClaim.count({ where: { userId: uid } }), 0);
 const check = await prisma.identityFieldCheck.findFirstOrThrow({ where: { userId: uid }, orderBy: { seq: 'desc' } });
 for (const field of ['fullName', 'birthDate', 'nationalId']) {
  const bad = structuredClone(check.fieldResults) as any; bad[field] = { status: 'MISMATCH' };
  await prisma.identityFieldCheck.update({ where: { id: check.id }, data: { fieldResults: bad } });
  assert.equal((await identityGateService.getState(uid, party)).canAdvance, false, field);
  await assert.rejects(() => identityGateService.assertApproved(uid, party), (e: any) => e.code === 'IDENTITY_NOT_APPROVED');
 }
 await prisma.identityFieldCheck.update({ where: { id: check.id }, data: { fieldResults: check.fieldResults as any } });
 await prisma.user.update({ where: { id: uid }, data: { legalName: 'اسم محفوظ جديد' } });
 state = await identityGateService.getState(uid, party); assert.equal(state.canAdvance, false); assert.equal(state.automaticCheck, 'NOT_CHECKED');
 await prisma.user.update({ where: { id: uid }, data: { legalName } });
 await model.update({ where: { userId: uid }, data: { frontIdUrl: front + '-changed' } } as any);
 assert.equal((await identityGateService.getState(uid, party)).canAdvance, false);
 assert.deepEqual((await prisma.user.findUniqueOrThrow({ where: { id: uid } })).firstName, 'Public');
});
