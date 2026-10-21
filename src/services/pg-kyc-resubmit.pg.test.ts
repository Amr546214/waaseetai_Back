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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('PG: a failure between the steps of the decision rolls EVERYTHING back (request still waiting, KYC unchanged, document not applied)', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { prisma, user, req } = await seed('PENDING', { notes: null });
	const svc: any = providerProfileService; const original = svc.applySensitivePayloadOn;
	svc.applySensitivePayloadOn = async (db: any, ...rest: any[]) => { await db.user.update({ where: { id: user.id }, data: { idDocumentUrl: 'half-applied' } }); throw new Error('boom between steps'); };
	try { await assert.rejects(providerProfileService.reviewSensitiveChange(req.id, true, undefined, { actorLabel: 'a' } as any), /boom between steps/); } finally { svc.applySensitivePayloadOn = original; }
	const r = await prisma.profileModificationRequest.findUnique({ where: { id: req.id } });
	const p = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
	assert.equal(r!.status, 'PENDING_HUMAN_REVIEW'); assert.equal(r!.reviewedByAdmin, false);
	assert.equal(p!.kycStatus, 'PENDING');
	assert.equal((await prisma.user.findUnique({ where: { id: user.id } }))!.idDocumentUrl, null, 'the half-applied write was rolled back');
	// and the decision can then be taken normally
	await providerProfileService.reviewSensitiveChange(req.id, true, undefined, { actorLabel: 'a' } as any);
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: user.id } }))!.kycStatus, 'VERIFIED');
});

test('PG: a failing notification (or audit log) AFTER the commit never undoes the decision', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { providerNotifications } = await import('./provider-notifications.service');
	const { prisma, user, req } = await seed('PENDING', { notes: null });
	const n: any = providerNotifications; const original = n.kycDecided;
	n.kycDecided = async () => { throw new Error('notification service down'); };
	try { await providerProfileService.reviewSensitiveChange(req.id, false, 'سبب صالح للاختبار', { actorLabel: 'a' } as any); } finally { n.kycDecided = original; }
	assert.equal((await prisma.profileModificationRequest.findUnique({ where: { id: req.id } }))!.status, 'REJECTED');
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: user.id } }))!.kycStatus, 'REJECTED');
});

test('PG: two concurrent decisions on the SAME request: exactly one wins and the states agree (never half approved / half refused)', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { prisma, user, req } = await seed('PENDING', { notes: null });
	const results = await Promise.allSettled([
		providerProfileService.reviewSensitiveChange(req.id, true, undefined, { actorLabel: 'a' } as any),
		providerProfileService.reviewSensitiveChange(req.id, false, 'رفض متزامن', { actorLabel: 'b' } as any),
	]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	assert.ok(results.some(r => r.status === 'rejected' && /REQUEST_NOT_PENDING_REVIEW/.test(String((r as any).reason?.message))));
	const r = await prisma.profileModificationRequest.findUnique({ where: { id: req.id } });
	const p = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
	const u = await prisma.user.findUnique({ where: { id: user.id } });
	if (r!.status === 'APPROVED') { assert.equal(p!.kycStatus, 'VERIFIED'); assert.ok(u!.idDocumentUrl); }
	else { assert.equal(r!.status, 'REJECTED'); assert.equal(p!.kycStatus, 'REJECTED'); assert.equal(u!.idDocumentUrl, null); }
});

test('PG: a KYC decision on the OLD document that races a provider\'s re-submission waits for it and is then refused (the row lock), instead of approving the old file', opts, async () => {
	const { onboardingService } = await import('./onboarding.service');
	const { lockProviderProfile } = await import('../utils/provider-profile-lock');
	const { prisma, user, req } = await seed('REJECTED', { notes: 'سبب الرفض: قديم' });
	await prisma.profileModificationRequest.update({ where: { id: req.id }, data: { status: 'PENDING_OTP' as any } });
	// the "confirmation" of the new document: holds the provider row lock, puts the request into review, commits 400 ms later
	let locked!: () => void; const lockedP = new Promise<void>(r => { locked = r; });
	const confirm = prisma.$transaction(async tx => {
		await lockProviderProfile(tx, user.id); locked();
		await sleep(400);
		await tx.providerProfile.updateMany({ where: { userId: user.id, kycStatus: 'REJECTED' as any }, data: { kycStatus: 'PENDING' as any } });
		await tx.profileModificationRequest.update({ where: { id: req.id }, data: { status: 'PENDING_HUMAN_REVIEW' as any } });
	});
	await lockedP;
	const started = Date.now();
	const decision = onboardingService.approveProviderKyc(user.id).then(() => 'approved', (e: any) => `refused: ${e.message}`);
	await confirm;
	const outcome = await decision;
	assert.ok(Date.now() - started >= 300, 'the KYC decision had to wait for the re-submission to commit');
	assert.match(outcome, /refused: .*مستند هوية جديد بانتظار المراجعة/);
	const p = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
	assert.equal(p!.kycStatus, 'PENDING'); assert.equal(p!.isVerified, false);
});

test('PG: the confirmation of a corrected document is ONE transaction: a duplicate waiting request makes it fail with the code still usable (nothing consumed)', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { prisma, user, req } = await seed('REJECTED', { notes: 'سبب الرفض: قديم' });
	// req is already waiting; a second request is opened and its code confirmed
	const second = await prisma.profileModificationRequest.create({ data: { id: id(), providerId: user.id, fieldName: 'DOCUMENTS', fieldLabel: 'المستندات الرسمية', currentValue: '{}', requestedValue: '{}', category: 'DOCUMENTS', requiresOtp: true, status: 'PENDING_OTP' as any, metadata: { requiresHumanReview: true, changes: { idDocumentUrl: `private:image:png:waseetai/providers/${user.id}/documents/second` } } as any } as any });
	const otp = await prisma.otpVerification.create({ data: { id: id(), userId: user.id, code: '123456', type: 'EMAIL', expiresAt: new Date(Date.now() + 600000), context: { purpose: 'SENSITIVE_CHANGE', requestId: second.id } as any } as any });
	await assert.rejects(providerProfileService.verifySensitiveChange(user.id, second.id, '123456'), /REQUEST_ALREADY_PENDING/);
	assert.ok(await prisma.otpVerification.findUnique({ where: { id: otp.id } }), 'the code was NOT consumed by the failed confirmation');
	assert.equal((await prisma.profileModificationRequest.findUnique({ where: { id: second.id } }))!.status, 'PENDING_OTP');
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: user.id } }))!.kycStatus, 'REJECTED', 'the refusal state is untouched when the confirmation fails');
	assert.ok(req.id);
});

test('PG: the whole confirmation (code consumed + KYC REJECTED->PENDING + refusal text cleared + request into review) happens together', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const { prisma, user, req } = await seed('REJECTED', { notes: 'سبب الرفض: قديم' });
	await prisma.profileModificationRequest.update({ where: { id: req.id }, data: { status: 'PENDING_OTP' as any, otpVerifiedAt: null } });
	const otp = await prisma.otpVerification.create({ data: { id: id(), userId: user.id, code: '654321', type: 'EMAIL', expiresAt: new Date(Date.now() + 600000), context: { purpose: 'SENSITIVE_CHANGE', requestId: req.id } as any } as any });
	await providerProfileService.verifySensitiveChange(user.id, req.id, '654321');
	assert.equal(await prisma.otpVerification.findUnique({ where: { id: otp.id } }), null);
	const p = await prisma.providerProfile.findUnique({ where: { userId: user.id } });
	assert.equal(p!.kycStatus, 'PENDING'); assert.equal(p!.notes, null);
	assert.equal((await prisma.profileModificationRequest.findUnique({ where: { id: req.id } }))!.status, 'PENDING_HUMAN_REVIEW');
});
