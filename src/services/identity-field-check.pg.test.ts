import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL (isolated local :55432, migration 20261106100000 applied). The AI side is IdentityCompareTestDouble (src/testing/identity-compare.test-double.ts):
 * these tests prove PLUMBING (trigger, snapshot, persistence, idempotency, out-of-order, fallback, redaction, views). They do NOT prove real card reading.
 * Synthetic data only.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
const id = () => randomUUID();
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const NID = '29001011234567';
const ref = (uid: string, tag: string) => `private:image:jpg:waseetai/providers/${uid}/identity/front-id-${tag}`;

async function env(over: { enabled?: boolean } = {}) {
	const { prisma } = await import('../config/db');
	const { IdentityFieldCheckService } = await import('./identity-field-check.service');
	const { IdentityCompareTestDouble, syntheticImage } = await import('../testing/identity-compare.test-double');
	const ai = new IdentityCompareTestDouble();
	const images = new Map<string, Buffer>();
	let flag = over.enabled ?? true;
	const svc = new IdentityFieldCheckService({ db: prisma, ai: ai as any, fetchImage: async r => { const b = images.get(r); if (!b) throw new Error('nf'); return { bytes: b, mimeType: 'image/jpeg' }; }, enabled: () => flag, now: () => new Date() });
	return { prisma, svc, ai, images, syntheticImage, setFlag: (v: boolean) => { flag = v; } };
}
async function seed(prisma: any, party: 'CLIENT' | 'PROVIDER', over: any = {}) {
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: party === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : 'PROVIDER_INDIVIDUAL', firstName: 'اسم', lastName: 'تجريبي' + tag, legalName: `اسم تجريبي${tag}`, email: `idc-${tag}@pg.test`, roles: [party], activeRole: party } });
	const front = over.frontIdUrl === undefined ? ref(user.id, 'a') : over.frontIdUrl;
	const data = { id: id(), userId: user.id, idNumber: over.idNumber === undefined ? NID : over.idNumber, dob: over.dob === undefined ? new Date('1990-01-01T00:00:00Z') : over.dob, frontIdUrl: front, kycStatus: 'PENDING' };
	if (party === 'CLIENT') await prisma.clientProfile.create({ data }); else await prisma.providerProfile.create({ data });
	return { user, front, name: `اسم تجريبي${tag}` };
}
const card = (name: string, extra: any = {}) => ({ name, dob: '1990-01-01', id: NID, ...extra });
const rows = (prisma: any, userId: string) => prisma.identityFieldCheck.findMany({ where: { userId }, orderBy: { seq: 'asc' } });

test('PG: flag OFF (default) writes nothing and calls nothing; the admin view says FLAG_OFF', opts, async () => {
	const { prisma, svc, ai, setFlag } = await env({ enabled: false });
	const { user } = await seed(prisma, 'PROVIDER');
	assert.deepEqual(await svc.trigger(user.id, 'PROVIDER'), { action: 'DISABLED' });
	assert.equal((await rows(prisma, user.id)).length, 0); assert.equal(ai.calls.length, 0);
	const v: any = await svc.getAdminView(user.id, 'PROVIDER');
	assert.equal(v.state, 'NOT_CHECKED'); assert.equal(v.stateReason, 'FLAG_OFF'); assert.equal(v.autoCheckEnabled, false); assert.equal(v.fields, null);
	setFlag(true);
});

test('PG: complete data + image -> DONE with per-field results, snapshot erased, no raw values stored; kyc state untouched (never auto approve/reject)', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'PROVIDER');
	images.set(front, syntheticImage(card(name, { id: '29001011234568' }))); // one digit different
	const out: any = await svc.trigger(user.id, 'PROVIDER');
	assert.equal(out.action, 'CREATED');
	const [r] = await rows(prisma, user.id);
	assert.equal(r.status, 'DONE'); assert.equal(r.registeredSnapshot, null); assert.equal(r.nationalIdMasked, '29**********67');
	assert.deepEqual((r.fieldResults as any).nationalId, { status: 'MISMATCH' }); assert.equal((r.fieldResults as any).fullName.status, 'MATCH');
	assert.equal(r.modelName, 'TEST-DOUBLE-NOT-A-MODEL'); assert.ok(r.imageSha256 && r.finishedAt && r.startedAt);
	assert.equal(ai.calls.length, 1); assert.equal(ai.calls[0].registered.nationalId, NID);
	const stored = JSON.stringify(r);
	assert.ok(!stored.includes(NID), 'full national id is nowhere in the stored row');
	assert.equal((await prisma.providerProfile.findUnique({ where: { userId: user.id } }))!.kycStatus, 'PENDING');
	const v: any = await svc.getAdminView(user.id, 'PROVIDER');
	assert.equal(v.state, 'DONE'); assert.equal(v.fields.nationalId.status, 'MISMATCH'); assert.deepEqual(v.notExamined, { faceMatch: 'NOT_EXAMINED', liveness: 'NOT_EXAMINED', documentAuthenticity: 'NOT_EXAMINED' });
	assert.equal(v.manualReviewRequired, true); assert.equal(v.imageVersion.version, 1); assert.equal(v.imageVersion.digest.length, 12);
});

test('PG: a blurred/unreadable field is COULD_NOT_VERIFY (never MATCH) in the plumbing', opts, async () => {
	const { prisma, svc, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'CLIENT');
	images.set(front, syntheticImage(card(name, { unreadable: ['birthDate'] })));
	await svc.trigger(user.id, 'CLIENT');
	const v: any = await svc.getAdminView(user.id, 'CLIENT');
	assert.equal(v.fields.birthDate.status, 'COULD_NOT_VERIFY'); assert.equal(v.fields.birthDate.reason, 'FIELD_NOT_VISIBLE'); assert.equal(v.fields.nationalId.status, 'MATCH');
});

test('PG: incomplete data does not start a check; completing it later does (snapshot = data at that time)', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'PROVIDER', { dob: null });
	assert.deepEqual(await svc.trigger(user.id, 'PROVIDER'), { action: 'INCOMPLETE' }); assert.equal((await rows(prisma, user.id)).length, 0);
	await prisma.providerProfile.update({ where: { userId: user.id }, data: { dob: new Date('1990-01-01T00:00:00Z') } });
	images.set(front, syntheticImage(card(name)));
	assert.equal(((await svc.trigger(user.id, 'PROVIDER')) as any).action, 'CREATED'); assert.equal(ai.calls.length, 1);
});

test('PG: non-Egyptian id format / non-private image -> SKIPPED with a reason, no AI call', opts, async () => {
	const { prisma, svc, ai } = await env();
	const a = await seed(prisma, 'PROVIDER', { idNumber: '1234567890' });
	const b = await seed(prisma, 'CLIENT', { frontIdUrl: 'https://res.cloudinary.com/x/image/upload/legacy.jpg' });
	assert.equal(((await svc.trigger(a.user.id, 'PROVIDER')) as any).action, 'SKIPPED');
	assert.equal(((await svc.trigger(b.user.id, 'CLIENT')) as any).action, 'SKIPPED');
	assert.equal((await rows(prisma, a.user.id))[0].stateReason, 'NOT_EGYPTIAN_ID_FORMAT');
	assert.equal((await rows(prisma, b.user.id))[0].stateReason, 'IMAGE_NOT_IN_PRIVATE_STORAGE'); assert.equal(ai.calls.length, 0);
	assert.equal(((await svc.getAdminView(a.user.id, 'PROVIDER')) as any).state, 'SKIPPED');
});

test('PG: idempotency — the same (user, image, data) never repeats the AI call, also under concurrent triggers', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'PROVIDER');
	images.set(front, syntheticImage(card(name))); ai.delayMs = 40;
	const outs: any[] = await Promise.all(Array.from({ length: 8 }, () => svc.trigger(user.id, 'PROVIDER')));
	assert.equal(outs.filter(o => o.action === 'CREATED').length, 1, JSON.stringify(outs.map(o => o.action)));
	assert.equal((await rows(prisma, user.id)).length, 1); assert.equal(ai.calls.length, 1);
	assert.equal(((await svc.trigger(user.id, 'PROVIDER')) as any).action, 'DUPLICATE'); assert.equal(ai.calls.length, 1);
	// concurrent runners on one QUEUED row: only one wins the claim
	const q = await prisma.identityFieldCheck.create({ data: { userId: user.id, party: 'PROVIDER', seq: 99, imageVersion: 1, imageRefDigest: sha256(front), dataDigest: sha256(JSON.stringify({ n: name.trim().replace(/\s+/g, ' ').toLowerCase(), b: '1990-01-01', i: NID })), idempotencyKey: id() } }); // QUEUED row with the REAL digests of the current image + data (run() re-reads the profile and skips a row whose digests do not match)
	const before = ai.calls.length;
	await Promise.all([svc.run(q.id), svc.run(q.id), svc.run(q.id)]);
	assert.equal(ai.calls.length - before, 1);
});

test('PG: a changed registered value (same image) creates a NEW check; the old data snapshot is not used (snapshot at submission time)', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'CLIENT');
	images.set(front, syntheticImage(card(name)));
	await svc.trigger(user.id, 'CLIENT');
	await prisma.clientProfile.update({ where: { userId: user.id }, data: { dob: new Date('1991-02-02T00:00:00Z') } });
	assert.equal(((await svc.trigger(user.id, 'CLIENT')) as any).action, 'CREATED');
	const rs = await rows(prisma, user.id);
	assert.equal(rs.length, 2); assert.equal(rs[1].imageVersion, 1); assert.equal(ai.calls[1].registered.birthDate, '1991-02-02');
	assert.equal(((await svc.getAdminView(user.id, 'CLIENT')) as any).fields.birthDate.status, 'MISMATCH');
});

test('PG: out-of-order — an older image finishing late never overwrites or hides the newer image result', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'PROVIDER');
	images.set(front, syntheticImage(card(name, { id: '29001011234568' }))); // old image: MISMATCH on id
	ai.delayMs = 150;
	const slow = svc.trigger(user.id, 'PROVIDER'); // image A starts, slow AI
	await new Promise(r => setTimeout(r, 40));
	const newRef = ref(user.id, 'b');
	await prisma.providerProfile.update({ where: { userId: user.id }, data: { frontIdUrl: newRef } });
	images.set(newRef, syntheticImage(card(name))); // new image: all MATCH
	ai.delayMs = 0;
	await svc.trigger(user.id, 'PROVIDER');
	await slow;
	const rs = await rows(prisma, user.id);
	assert.equal(rs.length, 2); assert.equal(rs[1].imageVersion, 2); assert.equal(rs[1].status, 'DONE');
	const v: any = await svc.getAdminView(user.id, 'PROVIDER');
	assert.equal(v.imageVersion.version, 2); assert.equal(v.fields.nationalId.status, 'MATCH'); assert.equal(v.stale, false);
	assert.notEqual(rs[0].id, rs[1].id); assert.equal((rs[0].fieldResults as any).nationalId.status, 'MISMATCH', 'old result stays on the OLD row only');
});

test('PG: re-run of an old QUEUED row after a newer check exists is SKIPPED/SUPERSEDED with no AI call; replacing the image without a trigger shows STALE_IMAGE', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'CLIENT');
	images.set(front, syntheticImage(card(name)));
	await svc.trigger(user.id, 'CLIENT');
	const old = await prisma.identityFieldCheck.create({ data: { userId: user.id, party: 'CLIENT', seq: 0, imageVersion: 0, imageRefDigest: 'o', dataDigest: 'd', idempotencyKey: id(), registeredSnapshot: { fullName: name, birthDate: '1990-01-01', nationalId: NID, imageRef: front } } });
	const n = ai.calls.length; await svc.run(old.id);
	const after = await prisma.identityFieldCheck.findUnique({ where: { id: old.id } });
	assert.equal(after!.status, 'SKIPPED'); assert.equal(after!.stateReason, 'SUPERSEDED'); assert.equal(ai.calls.length, n); assert.equal(after!.registeredSnapshot, null);
	await prisma.clientProfile.update({ where: { userId: user.id }, data: { frontIdUrl: ref(user.id, 'zz') } });
	const v: any = await svc.getAdminView(user.id, 'CLIENT');
	assert.equal(v.state, 'NOT_CHECKED'); assert.equal(v.stateReason, 'STALE_IMAGE'); assert.equal(v.stale, true); assert.equal(v.fields, null);
	assert.deepEqual(await svc.getOwnerView(user.id, 'CLIENT'), { state: 'NONE' });
});

test('PG: A -> B -> A again: the old result is reused as the current one, no new AI call', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'PROVIDER');
	images.set(front, syntheticImage(card(name)));
	await svc.trigger(user.id, 'PROVIDER');
	const b = ref(user.id, 'b'); images.set(b, syntheticImage(card(name)));
	await prisma.providerProfile.update({ where: { userId: user.id }, data: { frontIdUrl: b } }); await svc.trigger(user.id, 'PROVIDER');
	await prisma.providerProfile.update({ where: { userId: user.id }, data: { frontIdUrl: front } });
	const n = ai.calls.length;
	assert.equal(((await svc.trigger(user.id, 'PROVIDER')) as any).action, 'REUSED'); assert.equal(ai.calls.length, n);
	const v: any = await svc.getAdminView(user.id, 'PROVIDER'); assert.equal(v.state, 'DONE'); assert.equal(v.stale, false); assert.equal(v.imageVersion.version, 3);
});

test('PG: AI down / timeout / garbage / not configured / image unreadable -> UNAVAILABLE (never blocks, no verdict, KYC state untouched); retry is bounded', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	for (const [mode, reason] of [['down', 'AI_UNAVAILABLE'], ['timeout', 'AI_TIMEOUT'], ['garbage', 'AI_BAD_RESPONSE']] as const) {
		const { user, front, name } = await seed(prisma, 'PROVIDER'); images.set(front, syntheticImage(card(name))); ai.mode = mode;
		await svc.trigger(user.id, 'PROVIDER');
		const v: any = await svc.getAdminView(user.id, 'PROVIDER');
		assert.equal(v.state, 'UNAVAILABLE'); assert.equal(v.stateReason, reason); assert.equal(v.fields, null); assert.equal(v.manualReviewRequired, true);
		assert.equal((await prisma.providerProfile.findUnique({ where: { userId: user.id } }))!.kycStatus, 'PENDING');
		assert.equal((await rows(prisma, user.id))[0].registeredSnapshot, null);
		if (mode === 'down') { // same key retried: bounded by MAX_ATTEMPTS, then DUPLICATE
			ai.mode = 'ok'; assert.equal(((await svc.trigger(user.id, 'PROVIDER')) as any).action, 'RETRY'); assert.equal(((await svc.getAdminView(user.id, 'PROVIDER')) as any).state, 'DONE');
		}
	}
	ai.mode = 'down';
	const x = await seed(prisma, 'PROVIDER'); images.set(x.front, syntheticImage(card(x.name)));
	for (let i = 0; i < 6; i++) await svc.trigger(x.user.id, 'PROVIDER');
	assert.equal((await rows(prisma, x.user.id))[0].attempts, 3);
	ai.mode = 'ok'; ai.configured = false; const y = await seed(prisma, 'CLIENT'); images.set(y.front, syntheticImage(card(y.name)));
	await svc.trigger(y.user.id, 'CLIENT'); assert.equal(((await svc.getAdminView(y.user.id, 'CLIENT')) as any).stateReason, 'AI_NOT_CONFIGURED');
	ai.configured = true; const z = await seed(prisma, 'CLIENT'); // image not retrievable
	await svc.trigger(z.user.id, 'CLIENT'); assert.equal(((await svc.getAdminView(z.user.id, 'CLIENT')) as any).stateReason, 'IMAGE_FETCH_FAILED');
});

test('PG: owner view is neutral (IN_REVIEW/NONE only) whatever the internal state; admin view of a user without a profile is null (404)', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front, name } = await seed(prisma, 'PROVIDER');
	assert.deepEqual(await svc.getOwnerView(user.id, 'PROVIDER'), { state: 'NONE' });
	images.set(front, syntheticImage(card(name))); await svc.trigger(user.id, 'PROVIDER');
	assert.deepEqual(await svc.getOwnerView(user.id, 'PROVIDER'), { state: 'IN_REVIEW' });
	ai.mode = 'down'; const o = await seed(prisma, 'PROVIDER'); images.set(o.front, syntheticImage(card(o.name))); await svc.trigger(o.user.id, 'PROVIDER');
	assert.deepEqual(await svc.getOwnerView(o.user.id, 'PROVIDER'), { state: 'IN_REVIEW' }, 'UNAVAILABLE is not distinguishable by the owner');
	assert.equal(await svc.getAdminView(user.id, 'CLIENT'), null);
});

test('PG: logs never contain the full national id, the image or the registered values (redaction proof)', opts, async () => {
	const { logger } = await import('../config/logger');
	const lines: string[] = [];
	const orig = ['debug', 'info', 'warn', 'error'].map(l => [l, (logger as any)[l]] as const);
	for (const [l] of orig) (logger as any)[l] = (m: any) => { lines.push(String(m)); return logger; };
	try {
		const { prisma, svc, ai, images, syntheticImage } = await env();
		const a = await seed(prisma, 'PROVIDER'); images.set(a.front, syntheticImage(card(a.name))); await svc.trigger(a.user.id, 'PROVIDER');
		ai.mode = 'down'; const b = await seed(prisma, 'CLIENT'); images.set(b.front, syntheticImage(card(b.name))); await svc.trigger(b.user.id, 'CLIENT');
		ai.mode = 'garbage'; const c = await seed(prisma, 'PROVIDER'); images.set(c.front, syntheticImage(card(c.name))); await svc.trigger(c.user.id, 'PROVIDER');
		const imgB64 = syntheticImage(card(a.name)).toString('base64');
		assert.ok(lines.length > 0, 'the service does log (status lines only)');
		for (const line of lines) { assert.ok(!line.includes(NID), line); assert.ok(!line.includes(imgB64)); assert.ok(!line.includes('1990-01-01')); }
	} finally { for (const [l, f] of orig) (logger as any)[l] = f; }
});

test('PG legal name: ONLY the legal name goes to the comparison; the display name is never sent, and a missing legal name means INCOMPLETE (no fallback to the display name)', opts, async () => {
	const { prisma, svc, ai, images, syntheticImage } = await env();
	const { user, front } = await seed(prisma, 'PROVIDER');
	await prisma.user.update({ where: { id: user.id }, data: { firstName: 'عمرو', lastName: 'م', legalName: 'عمرو محمود عكاشة' } });
	images.set(front, syntheticImage(card('عمرو محمود عكاشة')));
	assert.equal(((await svc.trigger(user.id, 'PROVIDER')) as any).action, 'CREATED');
	assert.equal(ai.calls.length, 1); assert.equal(ai.calls[0].registered.fullName, 'عمرو محمود عكاشة', 'the legal name, not "عمرو م"');
	const [r] = await rows(prisma, user.id); assert.equal((r.fieldResults as any).fullName.status, 'MATCH');
	const admin: any = await svc.getAdminView(user.id, 'PROVIDER');
	assert.equal(admin.legalName, 'عمرو محمود عكاشة'); assert.equal(admin.legalNameMissing, false);
	const legacy = await seed(prisma, 'CLIENT');
	await prisma.user.update({ where: { id: legacy.user.id }, data: { legalName: null } });
	assert.deepEqual(await svc.trigger(legacy.user.id, 'CLIENT'), { action: 'INCOMPLETE' });
	assert.equal(ai.calls.length, 1, 'nothing was sent for the account without a legal name');
	assert.equal(((await svc.getAdminView(legacy.user.id, 'CLIENT')) as any).legalNameMissing, true);
});

test('PG legal name service: first save is direct; a verified/pending identity makes a change a REQUEST; approval replaces the name and sends the identity back to PENDING; display name untouched', opts, async () => {
	const { prisma } = await env();
	const { legalNameService } = await import('./legal-name.service');
	const { provider } = { provider: await seed(prisma, 'PROVIDER') };
	const uid = provider.user.id;
	await prisma.user.update({ where: { id: uid }, data: { legalName: null, firstName: 'عمرو', lastName: 'م' } });
	await prisma.providerProfile.update({ where: { userId: uid }, data: { kycStatus: 'UNVERIFIED' } });
	assert.equal((await legalNameService.getView(uid)).status, 'MISSING');
	await assert.rejects(() => legalNameService.set(uid, 'عمرو'), (e: any) => e.statusCode === 400 && e.code === 'LEGAL_NAME_NEEDS_TWO_PARTS');
	const first = await legalNameService.set(uid, '  عمرو   محمود ');
	assert.equal(first.outcome, 'SAVED'); assert.equal(first.view.legalName, 'عمرو محمود'); assert.equal(first.view.changeNeedsReview, false);
	assert.equal((await legalNameService.set(uid, 'عمرو محمود')).outcome, 'UNCHANGED');
	assert.equal((await legalNameService.set(uid, 'عمرو محمود عكاشة')).outcome, 'SAVED', 'before verification the owner may still correct it');
	// identity now under verification: a change is a request only
	await prisma.providerProfile.update({ where: { userId: uid }, data: { kycStatus: 'VERIFIED', isVerified: true } });
	const req = await legalNameService.set(uid, 'عمرو أحمد عكاشة');
	assert.equal(req.outcome, 'REQUEST_CREATED'); assert.equal(req.view.legalName, 'عمرو محمود عكاشة', 'unchanged until an admin approves'); assert.equal(req.view.changeNeedsReview, true);
	assert.ok(req.view.pendingRequest);
	await assert.rejects(() => legalNameService.set(uid, 'عمرو سعيد عكاشة'), (e: any) => e.statusCode === 409);
	const row = await prisma.profileModificationRequest.findUniqueOrThrow({ where: { id: req.view.pendingRequest!.id } });
	assert.equal(row.category, 'LEGAL_NAME_CHANGE'); assert.equal(row.status, 'PENDING_HUMAN_REVIEW');
	await legalNameService.applyApproved(uid, (row.metadata as any).changes);
	const after = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
	assert.equal(after.legalName, 'عمرو أحمد عكاشة'); assert.equal(after.firstName, 'عمرو'); assert.equal(after.lastName, 'م', 'the display name never changes with the legal name');
	const prof = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: uid } });
	assert.equal(prof.kycStatus, 'PENDING'); assert.equal(prof.isVerified, false);
});

// ── legal name in the approved evidence (review fixes) ──
test('PG identity approval: a NEW approval needs the legal name; the approval is bound to it; a legacy verified account with NO name stays verified and cannot gain an unreviewed one', opts, async () => {
	const { prisma } = await env();
	const { legalNameService } = await import('./legal-name.service');
	const { identityGateService, identityDigest } = await import('./identity-gate.service');
	const { onboardingService } = await import('./onboarding.service');
	// provider without a legal name: approval refused (explicitly), nothing changes
	const a = await seed(prisma, 'PROVIDER');
	await prisma.user.update({ where: { id: a.user.id }, data: { legalName: null } });
	await prisma.providerProfile.update({ where: { userId: a.user.id }, data: { kycStatus: 'PENDING' } });
	await assert.rejects(() => onboardingService.approveProviderKyc(a.user.id), (e: any) => e.statusCode === 409 && e.code === 'LEGAL_NAME_REQUIRED');
	assert.equal((await prisma.providerProfile.findUniqueOrThrow({ where: { userId: a.user.id } })).kycStatus, 'PENDING');
	// the owner completes it (PENDING + no name: direct), the reviewer now sees it, approval binds the digest to it
	assert.equal((await legalNameService.set(a.user.id, 'سارة أحمد علي')).outcome, 'SAVED');
	const listed = (await onboardingService.listProviderKyc('PENDING' as any, 1, 50, a.user.id)).items.find((i: any) => i.userId === a.user.id) as any;
	assert.equal(listed.legalName, 'سارة أحمد علي'); assert.equal(listed.legalNameMissing, false);
	await assert.rejects(() => onboardingService.approveProviderKyc(a.user.id, undefined, 'stale-digest-from-another-evidence'), (e: any) => e.code === 'IDENTITY_CHANGED_SINCE_REVIEW');
	await onboardingService.approveProviderKyc(a.user.id, undefined, listed.identityDigest);
	const row = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: a.user.id } });
	assert.equal(row.kycStatus, 'VERIFIED'); assert.equal(row.identityApprovedDigest, identityDigest({ ...row, legalName: 'سارة أحمد علي' }));
	assert.equal((await identityGateService.getState(a.user.id, 'PROVIDER')).status, 'APPROVED');
	// a legacy VERIFIED account (approved before the legal name existed: digest WITHOUT a name, name NULL) stays approved, and cannot ADD a name directly
	const b = await seed(prisma, 'PROVIDER');
	await prisma.user.update({ where: { id: b.user.id }, data: { legalName: null } });
	const bRow = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: b.user.id } });
	await prisma.providerProfile.update({ where: { userId: b.user.id }, data: { kycStatus: 'VERIFIED', isVerified: true, identityApprovedDigest: identityDigest(bRow) } });
	assert.equal((await identityGateService.getState(b.user.id, 'PROVIDER')).status, 'APPROVED', 'no name, same digest as before the feature: still approved, no review forced');
	const v0 = await legalNameService.getView(b.user.id); assert.equal(v0.status, 'MISSING'); assert.equal(v0.changeNeedsReview, true);
	const req = await legalNameService.set(b.user.id, 'منى خالد حسن');
	assert.equal(req.outcome, 'REQUEST_CREATED'); assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: b.user.id } })).legalName, null, 'no unreviewed name was added');
	assert.equal((await identityGateService.getState(b.user.id, 'PROVIDER')).status, 'APPROVED');
	// the admin approves the request: name added AND the identity goes back to review (digest cleared)
	const reqRow = await prisma.profileModificationRequest.findUniqueOrThrow({ where: { id: req.view.pendingRequest!.id } });
	await legalNameService.applyApproved(b.user.id, (reqRow.metadata as any).changes);
	const after = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: b.user.id } });
	assert.equal(after.kycStatus, 'PENDING'); assert.equal(after.identityApprovedDigest, null); assert.equal(after.isVerified, false);
	assert.equal((await identityGateService.getState(b.user.id, 'PROVIDER')).status, 'UNDER_REVIEW');
});

test('PG identity approval vs legal-name change racing: the two serialise; a verified identity is ALWAYS bound to the name on the account', opts, async () => {
	const { prisma } = await env();
	const { legalNameService } = await import('./legal-name.service');
	const { identityDigest } = await import('./identity-gate.service');
	const { onboardingService } = await import('./onboarding.service');
	for (let round = 0; round < 4; round++) {
		const a = await seed(prisma, 'PROVIDER');
		await prisma.user.update({ where: { id: a.user.id }, data: { legalName: 'اسم قديم كامل' } });
		await prisma.providerProfile.update({ where: { userId: a.user.id }, data: { kycStatus: 'PENDING' } });
		const [ap, ch] = await Promise.allSettled([onboardingService.approveProviderKyc(a.user.id), legalNameService.set(a.user.id, 'اسم جديد كامل')]);
		const user = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } });
		const prof = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: a.user.id } });
		if (prof.kycStatus === 'VERIFIED') assert.equal(prof.identityApprovedDigest, identityDigest({ ...prof, legalName: user.legalName }), `round ${round}: the approval is for the name now on the account (${ap.status}/${ch.status})`);
		// either order is fine, but never "verified for a name that is not the account's"; a name change that raced a PENDING review may be direct or a request
		assert.ok(['VERIFIED', 'PENDING'].includes(prof.kycStatus));
	}
});

test('PG username: one field (a single word is fine), kept in step with the display columns of the user and every role profile, independent of the legal name; legal name stays private', opts, async () => {
	const { prisma } = await env();
	const { usernameService } = await import('./username.service');
	const { legalNameService } = await import('./legal-name.service');
	const { displayNameOf } = await import('../utils/username');
	const a = await seed(prisma, 'PROVIDER');
	await prisma.clientProfile.create({ data: { id: id(), userId: a.user.id, firstName: 'قديم', lastName: 'اسم' } }).catch(() => undefined);
	await prisma.user.update({ where: { id: a.user.id }, data: { legalName: 'عمرو محمود عكاشة', firstName: 'قديم', lastName: 'اسم' } });
	assert.equal((await usernameService.get(a.user.id)).username, null);
	await assert.rejects(() => usernameService.set(a.user.id, 'a@b.com'), (e: any) => e.statusCode === 400 && e.code === 'USERNAME_INVALID_CHARS');
	const r = await usernameService.set(a.user.id, ' عمرو ');
	assert.equal(r.changed, true); assert.equal(r.displayName, 'عمرو');
	const u = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } });
	assert.deepEqual([u.username, u.firstName, u.lastName, u.legalName], ['عمرو', 'عمرو', '', 'عمرو محمود عكاشة'], 'display follows the username; the legal name is untouched');
	assert.equal(displayNameOf(u), 'عمرو');
	for (const row of [await prisma.providerProfile.findUnique({ where: { userId: a.user.id } }), await prisma.clientProfile.findUnique({ where: { userId: a.user.id } })]) if (row) { assert.equal(row.firstName, 'عمرو'); assert.equal(row.lastName, ''); }
	assert.equal(JSON.stringify([u.username, u.firstName, u.lastName]).includes('محمود'), false, 'no display column ever carries the legal name');
	assert.equal((await usernameService.set(a.user.id, 'عمرو')).changed, false);
	// a legal-name change request never changes the username, and a username change never changes the legal name
	await legalNameService.set(a.user.id, 'عمرو أحمد عكاشة').catch(() => undefined);
	assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).username, 'عمرو');
});
