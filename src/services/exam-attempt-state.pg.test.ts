import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** REAL PostgreSQL (isolated local :55432). Synthetic data only. Resume, autosave, session binding, events, server clock. */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret';
process.env.OPENAI_API_KEY ??= 'x';
const id = () => randomUUID();
const Q = (n: number) => ({ id: n, textAr: `سؤال ${n}`, options: [{ id: 'a', text: 'أ', isCorrect: true }, { id: 'b', text: 'ب' }], correctAnswer: 'a', assessmentArea: 'x' });

async function seed(over: { startedAt?: Date; status?: string; questions?: unknown[] } = {}) {
	const { prisma } = await import('../config/db');
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'a', lastName: tag, email: `ex-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const profile = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, isProfileSetupComplete: true } });
	const category = (await prisma.category.findUnique({ where: { slug: 'programming-development' } })) ?? (await prisma.category.create({ data: { id: id(), slug: 'programming-development', nameAr: 'x' } }));
	const specialty = await prisma.specialty.create({ data: { id: id(), slug: `sp-${tag}`, categoryId: category.id, nameAr: 'تخصص' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: profile.id, specialtyId: specialty.id, subSpecialties: [], status: 'UNDER_AI_REVIEW', isPassed: false, isActive: true } });
	const attempt = await prisma.assessmentAttempt.create({ data: { id: id(), providerSpecialtyId: ps.id, providerProfileId: profile.id, specialtyId: specialty.id, questionsPayload: (over.questions ?? [Q(1), Q(2), Q(3)]) as any, status: (over.status ?? 'IN_PROGRESS') as any, startedAt: over.startedAt ?? new Date(), timeLimitMinutes: 15, analyzedAssetsSnapshot: { vendorAttemptId: 'v-1' } } });
	return { prisma, user, attempt };
}

test('PG exam state: resume returns key-less questions, saved answers and the SERVER remaining time', opts, async () => {
	const { examAttemptStateService: svc } = await import('./exam-attempt-state.service');
	const { user, attempt } = await seed({ startedAt: new Date(Date.now() - 5 * 60_000) });
	assert.equal((await svc.saveDraft(user.id, attempt.id, { '1': 'a', '2': 'b' }, 'sess-1')).saved, true);
	const a: any = await svc.getActive(user.id, 'sess-1');
	assert.equal(a.attemptId, attempt.id); assert.deepEqual(a.answers, { '1': 'a', '2': 'b' });
	assert.ok(a.remainingSeconds > 9 * 60 && a.remainingSeconds <= 10 * 60, `remaining ${a.remainingSeconds}`);
	const wire = JSON.stringify(a);
	assert.ok(!wire.includes('isCorrect') && !wire.includes('correctAnswer'), 'no answer key ever reaches the browser');
	assert.equal(a.questions.length, 3);
});
test('PG exam state: drafts merge (an unknown question id, an over-long value and a stranger are ignored/refused); another user cannot read or write the attempt', opts, async () => {
	const { examAttemptStateService: svc } = await import('./exam-attempt-state.service');
	const { prisma, user, attempt } = await seed(); const other = await seed();
	await svc.saveDraft(user.id, attempt.id, { '1': 'a' }, 's');
	const r = await svc.saveDraft(user.id, attempt.id, { '2': 'b', '99': 'a', '3': 'x'.repeat(80) }, 's');
	assert.equal(r.saved, true);
	const snap: any = (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).analyzedAssetsSnapshot;
	assert.deepEqual(snap.draftAnswers, { '1': 'a', '2': 'b' }); assert.equal(snap.vendorAttemptId, 'v-1', 'other snapshot data is kept');
	await assert.rejects(() => svc.saveDraft(other.user.id, attempt.id, { '1': 'b' }, 's'), (e: any) => e.statusCode === 404);
	await assert.rejects(() => svc.logEvent(other.user.id, attempt.id, 'PAGE_HIDDEN', 's'), (e: any) => e.statusCode === 404);
	assert.equal(await svc.getActive(other.user.id, 's').then((x: any) => x.attemptId !== attempt.id), true, 'a user only ever sees their own live attempt');
	assert.equal((await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).submittedAnswers, null, 'drafts never touch the grading claim');
});
test('PG exam state: the attempt is bound to the login session that opened it', opts, async () => {
	const { examAttemptStateService: svc } = await import('./exam-attempt-state.service');
	const { user, attempt } = await seed();
	await svc.getActive(user.id, 'sess-A');
	await assert.rejects(() => svc.saveDraft(user.id, attempt.id, { '1': 'a' }, 'sess-B'), (e: any) => e.statusCode === 409 && e.code === 'ATTEMPT_SESSION_MISMATCH');
	await assert.rejects(() => svc.getActive(user.id, 'sess-B'), (e: any) => e.code === 'ATTEMPT_SESSION_MISMATCH');
	assert.equal((await svc.saveDraft(user.id, attempt.id, { '1': 'a' }, 'sess-A')).saved, true);
	process.env.EXAM_BIND_SESSION = 'false';
	try { assert.equal((await svc.saveDraft(user.id, attempt.id, { '2': 'b' }, 'sess-B')).saved, true); } finally { delete process.env.EXAM_BIND_SESSION; }
});
test('PG exam state: events are information only (deduped, capped, known types, no score/status change); blur alone changes nothing', opts, async () => {
	const { examAttemptStateService: svc, MAX_INTEGRITY_EVENTS } = await import('./exam-attempt-state.service');
	const { prisma, user, attempt } = await seed();
	assert.deepEqual(await svc.logEvent(user.id, attempt.id, 'WINDOW_BLUR', 's'), { recorded: true });
	assert.deepEqual(await svc.logEvent(user.id, attempt.id, 'WINDOW_BLUR', 's'), { recorded: false }, 'the same event within a second is one event');
	await assert.rejects(() => svc.logEvent(user.id, attempt.id, 'CHEATED', 's'), (e: any) => e.statusCode === 400);
	const row = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
	assert.equal(row.status, 'IN_PROGRESS'); assert.equal(row.score, null); assert.equal(row.isPassed, false);
	assert.equal(((row.analyzedAssetsSnapshot as any).integrityEvents as any[]).length, 1);
	assert.ok(MAX_INTEGRITY_EVENTS >= 100);
});
test('PG exam state: an expired attempt is not saved into; a finished attempt is gone; concurrent writers do not lose each other', opts, async () => {
	const { examAttemptStateService: svc } = await import('./exam-attempt-state.service');
	const { recordAssessmentAnswer } = await import('./ai-assessment.service');
	const old = await seed({ startedAt: new Date(Date.now() - 20 * 60_000) });
	const r = await svc.saveDraft(old.user.id, old.attempt.id, { '1': 'a' }, 's'); assert.equal(r.saved, false); assert.equal((r as any).expired, true);
	const done = await seed({ status: 'COMPLETED' });
	await assert.rejects(() => svc.saveDraft(done.user.id, done.attempt.id, { '1': 'a' }, 's'), (e: any) => e.statusCode === 404);
	const live = await seed();
	await Promise.all([svc.saveDraft(live.user.id, live.attempt.id, { '1': 'a' }, 's'), recordAssessmentAnswer(live.user.id, live.attempt.id, '2', 'b'), svc.logEvent(live.user.id, live.attempt.id, 'PAGE_HIDDEN', 's'), svc.saveDraft(live.user.id, live.attempt.id, { '3': 'b' }, 's')]);
	const snap: any = (await live.prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: live.attempt.id } })).analyzedAssetsSnapshot;
	assert.deepEqual(snap.draftAnswers, { '1': 'a', '3': 'b' }); assert.equal(snap.answerLog.length, 1); assert.equal(snap.integrityEvents.length, 1);
});
test('submission uses saved drafts to fill gaps; a submitted answer wins', async () => {
	const { withSavedDrafts } = await import('./ai-assessment.service');
	const qs = [{ id: 1 }, { id: 2 }, { id: 3 }];
	assert.deepEqual(withSavedDrafts({ draftAnswers: { '1': 'a', '2': 'b', '9': 'c' } }, qs, { '2': 'c' }), { '1': 'a', '2': 'c' });
	assert.deepEqual(withSavedDrafts({}, qs, { '1': 'b' }), { '1': 'b' });
	assert.deepEqual(withSavedDrafts(null, qs, {}), {});
});
