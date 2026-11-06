import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

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
	const user = await prisma.user.create({ data: { id: id(), accountType: party === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : 'PROVIDER_INDIVIDUAL', firstName: 'اسم', lastName: 'تجريبي' + tag, email: `idc-${tag}@pg.test`, roles: [party], activeRole: party } });
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
	// concurrent runners on one QUEUED row: only one wins the claim. (PR #210 reads the private profile just in time and refuses a row whose digests no longer match it, so the row carries the REAL digests of the registered data and no stored snapshot.)
	const q = await prisma.identityFieldCheck.create({ data: { userId: user.id, party: 'PROVIDER', seq: 99, imageVersion: 1, imageRefDigest: createHash('sha256').update(front).digest('hex'), dataDigest: createHash('sha256').update(JSON.stringify({ n: name.trim().replace(/\s+/g, ' ').toLowerCase(), b: '1990-01-01', i: NID })).digest('hex'), idempotencyKey: id() } });
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
