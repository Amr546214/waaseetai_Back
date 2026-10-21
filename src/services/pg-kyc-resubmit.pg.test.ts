import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL test: the identity re-submission cycle AFTER a refusal, on real rows (isolated local PostgreSQL only, see pg-admin-proofs.pg.test.ts):
 * the new document waits in the DOCUMENTS change-request queue; the admin queue shows it WITHOUT a private reference and can open it (access link by request id);
 * the KYC list says a new document waits and refuses to approve/reject the OLD one; approving the request VERIFIES the KYC review, refusing it refuses it with
 * the reason, so both queues and the provider's page agree; a VERIFIED account is never changed.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud';
process.env.CLOUDINARY_API_KEY ??= '123456789012345';
process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';
const id = () => randomUUID();

async function seed(kycStatus: string, extra: Record<string, any> = {}) {
	const { prisma } = await import('../config/db');
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'p', lastName: tag, email: `p-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const oldRef = `private:image:png:waseetai/providers/${user.id}/identity/old-${tag}`;
	await prisma.providerProfile.create({ data: { id: id(), userId: user.id, kycStatus: kycStatus as any, frontIdUrl: oldRef, ...extra } as any });
	const newRef = `private:image:png:waseetai/providers/${user.id}/documents/new-${tag}`;
	const req = await prisma.profileModificationRequest.create({ data: { id: id(), providerId: user.id, fieldName: 'DOCUMENTS', fieldLabel: 'المستندات الرسمية', currentValue: '{}', requestedValue: JSON.stringify({ idDocumentUrl: newRef }), category: 'DOCUMENTS', requiresOtp: true, otpVerifiedAt: new Date(), status: 'PENDING_HUMAN_REVIEW' as any, metadata: { requiresHumanReview: true, changes: { idDocumentUrl: newRef } } as any } as any });
	return { prisma, user, req, newRef, oldRef };
}
const admin = async () => { const { prisma } = await import('../config/db'); const t = id().slice(0, 8); return prisma.user.create({ data: { id: id(), accountType: 'ADMIN', firstName: 'ad', lastName: t, email: `ad-${t}@pg.test`, roles: ['ADMIN'], activeRole: 'ADMIN' } }); };

test('PG: the admin queue shows the new identity document WITHOUT its private reference, and the admin can open it by request id (the owner too, a stranger not)', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { createKycAccessLink } = await import('./kyc-document-access.service');
	const { prisma, user, req, newRef } = await seed('PENDING');
	const ad = await admin(); const stranger = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 's', lastName: 'x', email: `s-${id().slice(0, 8)}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const rows: any[] = await providerProfileService.getPendingSensitiveReviews();
	const mine = rows.find(r => r.id === req.id);
	assert.ok(mine, 'the request is in the admin queue');
	assert.ok(!JSON.stringify({ ...mine, metadata: undefined }).includes('private:'), 'no private reference in what the page receives');
	assert.equal(mine.documentsAccess.idDocumentUrl, true);
	const link = await createKycAccessLink({ id: ad.id, accountType: 'ADMIN' as any }, { document: 'profile_request_document', id: req.id });
	assert.equal(link.private, true);
	const own = await createKycAccessLink({ id: user.id, accountType: 'PROVIDER_INDIVIDUAL' as any }, { document: 'profile_request_document', id: req.id });
	assert.equal(own.private, true);
	await assert.rejects(createKycAccessLink({ id: stranger.id, accountType: 'PROVIDER_INDIVIDUAL' as any }, { document: 'profile_request_document', id: req.id }), /غير مصرح/);
	await assert.rejects(createKycAccessLink({ id: ad.id, accountType: 'ADMIN' as any }, { document: 'profile_request_document', id: id() }), /لا توجد وثيقة/);
	assert.ok(newRef.startsWith('private:'));
});

test('PG: with a new document waiting, the KYC list says so and KYC approve / reject on the OLD document are refused (409)', opts, async () => {
	const { onboardingService } = await import('./onboarding.service');
	const { prisma, user, req } = await seed('PENDING');
	const list: any = await onboardingService.listProviderKyc('PENDING', 1, 100, user.email);
	const row = list.items.find((i: any) => i.userId === user.id);
	assert.equal(row.pendingIdentityRequestId, req.id);
	await assert.rejects(onboardingService.approveProviderKyc(user.id), /مستند هوية جديد بانتظار المراجعة/);
	await assert.rejects(onboardingService.rejectProviderKyc(user.id, { rejectionReason: 'x' } as any), /مستند هوية جديد بانتظار المراجعة/);
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: user.id } }))!.kycStatus, 'PENDING');
	// with nothing waiting the old behaviour is unchanged
	const q = await seed('PENDING'); await prisma.profileModificationRequest.update({ where: { id: q.req.id }, data: { status: 'REJECTED' as any } });
	const done: any = await onboardingService.approveProviderKyc(q.user.id);
	assert.equal(done.kycStatus, 'VERIFIED');
});

test('PG: approving the new identity document VERIFIES the KYC review, applies the document, and the provider page then says VERIFIED', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { prisma, user, req, newRef } = await seed('PENDING', { notes: null });
	const ad = await admin();
	await providerProfileService.reviewSensitiveChange(req.id, true, undefined, { actorLabel: ad.email } as any);
	const p = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
	assert.equal(p!.kycStatus, 'VERIFIED'); assert.equal(p!.isVerified, true);
	assert.equal((await prisma.user.findUnique({ where: { id: user.id } }))!.idDocumentUrl, newRef);
});

test('PG: refusing the new identity document refuses the KYC review with the same reason; the provider can send again and the cycle repeats', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { publicKycRejectionReason } = await import('../utils/provider-kyc-review');
	const { prisma, user, req } = await seed('PENDING', { notes: null });
	await providerProfileService.reviewSensitiveChange(req.id, false, 'الصورة مقصوصة', { actorLabel: 'a' } as any);
	let p = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
	assert.equal(p!.kycStatus, 'REJECTED');
	assert.equal(publicKycRejectionReason(p!.kycStatus, p!.notes), 'الصورة مقصوصة');
	// the provider sends a corrected document again: the confirmation step puts the review back to PENDING (existing behaviour) and a new request waits
	await prisma.providerProfile.update({ where: { userId: user.id }, data: { kycStatus: 'PENDING' as any, notes: null } });
	const again = await prisma.profileModificationRequest.create({ data: { id: id(), providerId: user.id, fieldName: 'DOCUMENTS', fieldLabel: 'المستندات الرسمية', currentValue: '{}', requestedValue: '{}', category: 'DOCUMENTS', requiresOtp: true, otpVerifiedAt: new Date(), status: 'PENDING_HUMAN_REVIEW' as any, metadata: { requiresHumanReview: true, changes: { idDocumentUrl: `private:image:png:waseetai/providers/${user.id}/documents/second` } } as any } as any });
	await providerProfileService.reviewSensitiveChange(again.id, true, undefined, { actorLabel: 'a' } as any);
	p = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
	assert.equal(p!.kycStatus, 'VERIFIED');
});

test('PG: a VERIFIED account is never downgraded or re-opened by a document decision', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { prisma, user, req } = await seed('VERIFIED', { isVerified: true });
	await providerProfileService.reviewSensitiveChange(req.id, false, 'لا', { actorLabel: 'a' } as any);
	const p = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
	assert.equal(p!.kycStatus, 'VERIFIED'); assert.equal(p!.isVerified, true); assert.ok(!(p!.notes ?? '').startsWith('سبب الرفض'));
});
