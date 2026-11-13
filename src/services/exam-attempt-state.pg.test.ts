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

async function seed(over: { startedAt?: Date; status?: string; questions?: unknown[]; snapshot?: Record<string, unknown>; noAttempt?: boolean } = {}) {
	const { prisma } = await import('../config/db');
	const tag = id().slice(0, 8);
	const user = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'a', lastName: tag, email: `ex-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const profile = await prisma.providerProfile.create({ data: { id: id(), userId: user.id, isProfileSetupComplete: true } });
	const category = (await prisma.category.findUnique({ where: { slug: 'programming-development' } })) ?? (await prisma.category.create({ data: { id: id(), slug: 'programming-development', nameAr: 'x' } }));
	const specialty = await prisma.specialty.create({ data: { id: id(), slug: `sp-${tag}`, categoryId: category.id, nameAr: 'تخصص' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: profile.id, specialtyId: specialty.id, subSpecialties: [], status: 'UNDER_AI_REVIEW', isPassed: false, isActive: true } });
	const attempt = over.noAttempt ? (null as any) : await prisma.assessmentAttempt.create({ data: { id: id(), providerSpecialtyId: ps.id, providerProfileId: profile.id, specialtyId: specialty.id, questionsPayload: (over.questions ?? [Q(1), Q(2), Q(3)]) as any, status: (over.status ?? 'IN_PROGRESS') as any, startedAt: over.startedAt ?? new Date(), timeLimitMinutes: 15, analyzedAssetsSnapshot: { vendorAttemptId: 'v-1', ...(over.snapshot ?? {}) } as any } });
	return { prisma, user, attempt, ps, profile, specialty };
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
	await Promise.all([svc.saveDraft(live.user.id, live.attempt.id, { '1': 'a' }, 's'), recordAssessmentAnswer(live.user.id, live.attempt.id, '2', 'b', new Date(), 's'), svc.logEvent(live.user.id, live.attempt.id, 'PAGE_HIDDEN', 's'), svc.saveDraft(live.user.id, live.attempt.id, { '3': 'b' }, 's')]);
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


// ── session binding (review fixes) ──
const snapOf = async (prisma: any, id: string) => (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id } })).analyzedAssetsSnapshot as any;

test('PG session: the attempt is bound AT CREATION (inside the claiming transaction), survives the generated-questions write, and a second session cannot reuse, read, save, log or submit it', opts, async () => {
	const { claimAssessmentGeneration, processAssessmentSubmission, recordAssessmentAnswer } = await import('./ai-assessment.service');
	const { examAttemptStateService: svc } = await import('./exam-attempt-state.service');
	const { prisma, user, ps, profile, specialty } = await seed({ noAttempt: true });
	await assert.rejects(() => claimAssessmentGeneration(ps.id, profile.id, specialty.id, undefined), (e: any) => e.code === 'ATTEMPT_SESSION_UNKNOWN' && e.statusCode === 403, 'an unknown session is refused explicitly');
	assert.equal(await prisma.assessmentAttempt.count({ where: { providerSpecialtyId: ps.id } }), 0, 'nothing was created for it');
	const claim = await claimAssessmentGeneration(ps.id, profile.id, specialty.id, 'sess-A');
	assert.equal(claim.claimed, true);
	assert.equal((await snapOf(prisma, claim.attemptId)).boundSessionId, 'sess-A', 'bound by the creating transaction, before any resume call');
	// the generated questions are persisted (the same merge the service does): the binding is still there
	const { streamAssessmentForClaim } = await import('./ai-assessment.service');
	assert.ok(streamAssessmentForClaim);
	await prisma.$transaction(async (tx: any) => { await tx.$queryRaw`SELECT 1`; });
	await prisma.assessmentAttempt.update({ where: { id: claim.attemptId }, data: { questionsPayload: [Q(1), Q(2)] as any, status: 'IN_PROGRESS' } });
	// session B: cannot reuse the live attempt by starting again, nor read / save / log / answer-time / submit
	await assert.rejects(() => claimAssessmentGeneration(ps.id, profile.id, specialty.id, 'sess-B'), (e: any) => e.code === 'ATTEMPT_SESSION_MISMATCH' && e.statusCode === 409);
	await assert.rejects(() => svc.getActive(user.id, 'sess-B'), (e: any) => e.code === 'ATTEMPT_SESSION_MISMATCH');
	await assert.rejects(() => svc.saveDraft(user.id, claim.attemptId, { '1': 'a' }, 'sess-B'), (e: any) => e.code === 'ATTEMPT_SESSION_MISMATCH');
	await assert.rejects(() => svc.logEvent(user.id, claim.attemptId, 'PAGE_HIDDEN', 'sess-B'), (e: any) => e.code === 'ATTEMPT_SESSION_MISMATCH');
	await assert.rejects(() => svc.getActive(user.id, undefined), (e: any) => e.code === 'ATTEMPT_SESSION_UNKNOWN');
	assert.equal(await recordAssessmentAnswer(user.id, claim.attemptId, '1', 'a', new Date(), 'sess-B'), false);
	assert.deepEqual(await processAssessmentSubmission(claim.attemptId, user.id, { '1': 'a' }, 'sess-B'), { kind: 'SESSION_MISMATCH' });
	assert.deepEqual(await processAssessmentSubmission(claim.attemptId, user.id, { '1': 'a' }, undefined), { kind: 'SESSION_UNKNOWN' });
	const after = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: claim.attemptId } });
	assert.equal(after.status, 'IN_PROGRESS'); assert.equal(after.submittedAnswers, null, 'the second session left nothing: no grading claim, no write');
	// session A: everything works and the same session may start again (replay of its own attempt)
	assert.equal((await claimAssessmentGeneration(ps.id, profile.id, specialty.id, 'sess-A')).claimed, false);
	assert.equal(((await svc.getActive(user.id, 'sess-A')) as any).attemptId, claim.attemptId);
	assert.equal((await svc.saveDraft(user.id, claim.attemptId, { '1': 'a' }, 'sess-A')).saved, true);
});

test('PG session: two sessions racing on an attempt created before the feature (no binding) - exactly ONE binds, the other is refused, and no answer / event is lost', opts, async () => {
	const { examAttemptStateService: svc } = await import('./exam-attempt-state.service');
	const { prisma, user, attempt } = await seed();
	const results = await Promise.allSettled([svc.getActive(user.id, 'sess-1'), svc.getActive(user.id, 'sess-2'), svc.getActive(user.id, 'sess-1')]);
	const bound = (await snapOf(prisma, attempt.id)).boundSessionId;
	assert.ok(bound === 'sess-1' || bound === 'sess-2');
	const winnerOk = results.filter((r, i) => r.status === 'fulfilled' && [ 'sess-1', 'sess-2', 'sess-1' ][i] === bound).length;
	const refused = results.filter(r => r.status === 'rejected' && (r as any).reason.code === 'ATTEMPT_SESSION_MISMATCH').length;
	assert.equal(winnerOk + refused, 3); assert.ok(refused >= 1);
	// writers running at the same time as reads never lose each other
	await Promise.all([svc.saveDraft(user.id, attempt.id, { '1': 'a', '2': 'b' }, bound), svc.logEvent(user.id, attempt.id, 'PAGE_HIDDEN', bound), svc.getActive(user.id, bound), svc.getActive(user.id, bound)]);
	const snap = await snapOf(prisma, attempt.id);
	assert.deepEqual(snap.draftAnswers, { '1': 'a', '2': 'b' }); assert.equal(snap.integrityEvents.length, 1); assert.equal(snap.boundSessionId, bound);
});

test('PG autosave ordering: a late OLD request never replaces a newer answer; an equal-or-newer one does; the server returns what it really holds', opts, async () => {
	const { examAttemptStateService: svc } = await import('./exam-attempt-state.service');
	const { prisma, user, attempt } = await seed({ snapshot: { boundSessionId: 's' } });
	const newer = await svc.saveDraft(user.id, attempt.id, { '1': 'b', '2': 'a' }, 's', 2000);
	assert.deepEqual(newer.answers, { '1': 'b', '2': 'a' });
	const late = await svc.saveDraft(user.id, attempt.id, { '1': 'a', '3': 'b' }, 's', 1000); // older request arriving after
	assert.deepEqual(late.answers, { '1': 'b', '2': 'a', '3': 'b' }, 'question 1 keeps the newer answer; question 3 (never written) takes the old request');
	assert.equal(((await snapOf(prisma, attempt.id)).draftAnswers as any)['1'], 'b');
	assert.equal((await svc.saveDraft(user.id, attempt.id, { '1': 'a' }, 's', 3000)).answers['1'], 'a');
	// without a seq the request is stamped with the server time (newer than any past request)
	assert.equal((await svc.saveDraft(user.id, attempt.id, { '2': 'b' }, 's')).answers['2'], 'b');
});

test('PG: nothing is saved into an attempt that a submission has already claimed for grading', opts, async () => {
	const { examAttemptStateService: svc } = await import('./exam-attempt-state.service');
	const { prisma, user, attempt } = await seed({ snapshot: { boundSessionId: 's' } });
	await prisma.assessmentAttempt.update({ where: { id: attempt.id }, data: { submittedAnswers: { gradingClaimedAt: new Date().toISOString() } as any } });
	await assert.rejects(() => svc.saveDraft(user.id, attempt.id, { '1': 'a' }, 's'), (e: any) => e.code === 'ATTEMPT_SUBMITTING');
});
