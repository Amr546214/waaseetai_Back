import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL (isolated local :55432) + SIMULATED SMTP (notificationService.sendEmailOtp is replaced; no mail leaves the machine).
 * The sensitive-change e-mail code: reuse, concurrency, failed mail, IP slot before SMTP, one-time consumption.
 * The lock is in-process (ONE Node process); a second backend instance would need a database advisory lock.
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
const docUrl = (n: string) => `https://res.cloudinary.com/testcloud/image/upload/${n}.pdf`;

async function env() {
	const { prisma } = await import('../config/db');
	const { providerProfileService } = await import('./provider-profile.service');
	const { notificationService } = await import('./notification.service');
	const { otpSendThrottle } = await import('../utils/otp-send-throttle');
	otpSendThrottle.reset();
	const sent: { email: string; code: string }[] = [];
	const sim = { delayMs: 0, fail: false };
	(notificationService as any).sendEmailOtp = async (email: string, code: string) => {
		if (sim.delayMs) await new Promise(r => setTimeout(r, sim.delayMs));
		if (sim.fail) throw new Error('smtp down');
		sent.push({ email, code });
		return {} as any;
	};
	const mk = async () => {
		const tag = id().slice(0, 8);
		const u = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'p', lastName: tag, email: `so-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
		await prisma.providerProfile.create({ data: { id: id(), userId: u.id, kycStatus: 'UNVERIFIED' as any } as any });
		return u;
	};
	return { prisma, svc: providerProfileService, sent, sim, mk, otpSendThrottle };
}
const codesOf = (prisma: any, userId: string) => prisma.otpVerification.findMany({ where: { userId, type: 'EMAIL' } });

test('PG: the identical change asked twice -> one request, one mail, same code still works', opts, async () => {
	const { prisma, svc, sent, mk } = await env();
	const u = await mk();
	const a = await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('a') }, { ipAddress: '10.0.0.1' } as any);
	const b: any = await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('a') }, { ipAddress: '10.0.0.1' } as any);
	assert.equal(b.reused, true); assert.equal(b.requestId, a.requestId); assert.equal(sent.length, 1);
	assert.equal(await prisma.profileModificationRequest.count({ where: { providerId: u.id } }), 1);
	const ok: any = await svc.verifySensitiveChange(u.id, a.requestId, sent[0].code);
	assert.equal(ok.status, 'PENDING_HUMAN_REVIEW');
});

test('PG: reuse never returns a request whose code is consumed or whose state is no longer PENDING_OTP', opts, async () => {
	const { prisma, svc, sent, mk, otpSendThrottle } = await env();
	const u = await mk();
	const a = await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('c') }, { ipAddress: '10.0.0.2' } as any);
	await svc.verifySensitiveChange(u.id, a.requestId, sent[0].code); // consumed -> PENDING_HUMAN_REVIEW
	otpSendThrottle.reset();
	await assert.rejects(svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('c') }, { ipAddress: '10.0.0.2' } as any), (e: any) => e.message === 'REQUEST_ALREADY_PENDING' || /pending|REQUEST_ALREADY/i.test(e.message));
	assert.equal(sent.length, 1, 'no new mail');
	// code deleted (e.g. 5 wrong tries) while the request is still PENDING_OTP: a NEW code is sent, the stale request is not returned
	const v = await mk();
	const r = await svc.initiateSensitiveChange(v.id, 'DOCUMENTS', { idDocumentUrl: docUrl('d') }, { ipAddress: '10.0.0.3' } as any);
	await prisma.otpVerification.deleteMany({ where: { userId: v.id } });
	otpSendThrottle.reset();
	const r2: any = await svc.initiateSensitiveChange(v.id, 'DOCUMENTS', { idDocumentUrl: docUrl('d') }, { ipAddress: '10.0.0.3' } as any);
	assert.notEqual(r2.reused, true); assert.notEqual(r2.requestId, r.requestId);
});

test('PG: a failed mail leaves no reusable request, keeps the PREVIOUS valid code, and costs no allowance', opts, async () => {
	const { prisma, svc, sent, sim, mk, otpSendThrottle } = await env();
	const u = await mk();
	const first = await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('e') }, { ipAddress: '10.0.0.4' } as any);
	const goodCode = sent[0].code;
	otpSendThrottle.reset();
	sim.fail = true;
	await assert.rejects(svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('e2') }, { ipAddress: '10.0.0.4' } as any), /OTP_EMAIL_DELIVERY_FAILED/);
	assert.equal(await prisma.profileModificationRequest.count({ where: { providerId: u.id } }), 1, 'only the first request exists');
	assert.equal((await codesOf(prisma, u.id)).length, 1, 'the previous code is still there');
	sim.fail = false;
	// no throttle cost: the user can retry at once (same IP slot given back, no recipient cooldown)
	const again: any = await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('e2') }, { ipAddress: '10.0.0.4' } as any);
	assert.notEqual(again.requestId, first.requestId);
	const old: any = await svc.verifySensitiveChange(u.id, first.requestId, goodCode).catch((e: any) => e);
	assert.ok(old instanceof Error, 'after a delivered replacement the older code is gone');
});

test('PG: concurrent identical initiates -> exactly one request and one mail', opts, async () => {
	const { prisma, svc, sent, sim, mk } = await env();
	const u = await mk(); sim.delayMs = 80;
	const res: any[] = await Promise.all([1, 2, 3, 4].map(() => svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('f') }, { ipAddress: '10.0.0.5' } as any)));
	assert.equal(new Set(res.map(r => r.requestId)).size, 1);
	assert.equal(sent.length, 1);
	assert.equal(await prisma.profileModificationRequest.count({ where: { providerId: u.id } }), 1);
	assert.equal((await codesOf(prisma, u.id)).length, 1);
});

test('PG: concurrent DIFFERENT initiates -> one is served, the others get OTP_THROTTLED; the surviving request keeps a valid code', opts, async () => {
	const { prisma, svc, sent, sim, mk } = await env();
	const u = await mk(); sim.delayMs = 50;
	const res: any[] = await Promise.all(['g1', 'g2', 'g3'].map(n => svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl(n) }, { ipAddress: '10.0.0.6' } as any).catch((e: any) => e)));
	const ok = res.filter(r => r?.requestId); const refused = res.filter(r => r?.code === 'OTP_THROTTLED');
	assert.equal(ok.length, 1); assert.equal(refused.length, 2); assert.equal(sent.length, 1);
	const v: any = await svc.verifySensitiveChange(u.id, ok[0].requestId, sent[0].code);
	assert.equal(v.status, 'PENDING_HUMAN_REVIEW');
});

test('PG: the IP slot is taken BEFORE the slow SMTP call: concurrent users on one IP cannot pass the per-IP limit', opts, async () => {
	const { svc, sent, sim, mk } = await env();
	sim.delayMs = 150;
	const users = await Promise.all(Array.from({ length: 34 }, () => mk()));
	const res: any[] = await Promise.all(users.map(u => svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('h') }, { ipAddress: '10.0.0.7' } as any).catch((e: any) => e)));
	assert.equal(res.filter(r => r?.requestId).length, 30, 'exactly the per-IP hourly cap is served');
	assert.equal(res.filter(r => r?.code === 'OTP_THROTTLED').length, 4);
	assert.equal(sent.length, 30);
});

test('PG: confirmations are serialised with initiate and consume the code once: two parallel confirmations -> one decision', opts, async () => {
	const { prisma, svc, sent, mk } = await env();
	const u = await mk();
	const a = await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('i') }, { ipAddress: '10.0.0.8' } as any);
	const res: any[] = await Promise.all([1, 2, 3].map(() => svc.verifySensitiveChange(u.id, a.requestId, sent[0].code).catch((e: any) => e)));
	assert.equal(res.filter(r => r?.status === 'PENDING_HUMAN_REVIEW').length, 1);
	assert.equal(res.filter(r => r instanceof Error).length, 2);
	assert.equal(await prisma.profileModificationRequest.count({ where: { providerId: u.id, status: 'PENDING_HUMAN_REVIEW' as any } }), 1);
});

test('PG: a new request of one category never deletes another category code or a non-sensitive code', opts, async () => {
	const { prisma, svc, mk } = await env();
	const u = await mk();
	await prisma.otpVerification.create({ data: { userId: u.id, code: '111111', type: 'EMAIL', expiresAt: new Date(Date.now() + 600000), context: { purpose: 'PASSWORD_RESET' } as any } });
	await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', { idDocumentUrl: docUrl('j') }, { ipAddress: '10.0.0.9' } as any);
	const rows = await codesOf(prisma, u.id);
	assert.equal(rows.length, 2);
	assert.ok(rows.some((r: any) => r.code === '111111'));
});

test('PG: reuse works for a multi-key change whatever order the stored jsonb returns the keys in', opts, async () => {
	const { svc, sent, mk } = await env();
	const u = await mk();
	const ch = { idDocumentUrl: docUrl('k'), certificatesUrl: '', vatCertificateUrl: '', commercialRegistration: '' };
	const a = await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', ch, { ipAddress: '10.0.0.10' } as any);
	const b: any = await svc.initiateSensitiveChange(u.id, 'DOCUMENTS', ch, { ipAddress: '10.0.0.10' } as any);
	assert.equal(b.reused, true); assert.equal(b.requestId, a.requestId); assert.equal(sent.length, 1);
});
