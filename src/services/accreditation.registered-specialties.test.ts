import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// GET /accreditation/passed-specialties: the model-upload / accreditation selectors only offer PASSED specialties, but the answer also lists every registered one with
// its state, so the pages say where each stands (test not taken / not passed / rejected / locked) instead of "no specialty".
process.env.JWT_SECRET = 'test-secret'; process.env.OPENAI_API_KEY = 'test-key';
const spec = (id: string, nameAr: string) => ({ id, nameAr, category: { id: 'c1', nameAr: 'تصميم وإبداع' } });
const row = (id: string, specialty: any, over: any) => ({ id, specialtyId: specialty.id, specialty, status: 'PENDING_PROOF', isPassed: false, hasTakenAssessment: false, latestScore: null, quizScore: null, passedAt: null, subSpecialties: [], isActive: true, createdAt: new Date(), updatedAt: new Date(), ...over });
let rows: any[] = [];
let samples: any[] = [];
let attempts: any[] = [];
let loaded: Promise<any> | undefined;
const svc = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: {
		providerProfile: { findUnique: async ({ where }: any) => (where.userId === 'none' ? null : { id: 'pp-1' }) },
		assessmentAttempt: { findMany: async () => attempts },
		accreditationSample: { findMany: async ({ where }: any) => samples.filter(x => where.providerSpecialtyId.in.includes(x.providerSpecialtyId)) },
		providerSpecialty: { findMany: async ({ where }: any) => rows.filter(r => r.isActive && (where.isPassed === undefined || r.isPassed === where.isPassed)) },
	} } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	return (await import('./accreditation.service')).accreditationService;
})());

test('a provider whose signup specialty passed the setup test sees it in the selector (no empty state) and in the registered list', async () => {
	rows = [row('ps-1', spec('s1', 'تصميم جرافيك'), { isPassed: true, hasTakenAssessment: true, latestScore: 72 })];
	const r = await (await svc()).getPassedSpecialties('u1');
	assert.equal(r.hasAccreditedSpecialties, true);
	assert.deepEqual(r.categories[0].specialties.map((s: any) => s.name), ['تصميم جرافيك']);
	assert.deepEqual(r.registered.map((s: any) => [s.name, s.state]), [['تصميم جرافيك', 'PASSED']]);
});

test('registered specialties that are not passed are NOT offered, and each says its own state', async () => {
	rows = [
		row('ps-a', spec('s1', 'تصميم جرافيك'), {}),
		row('ps-b', spec('s2', 'شعارات'), { hasTakenAssessment: true, latestScore: 10 }),
		row('ps-c', spec('s3', 'رسم توضيحي'), { status: 'REJECTED' }),
		row('ps-d', spec('s4', 'أيقونات'), { status: 'LOCKED_OUT' }),
	];
	const r = await (await svc()).getPassedSpecialties('u1');
	assert.equal(r.hasAccreditedSpecialties, false);
	assert.deepEqual(r.categories, []);
	assert.deepEqual(r.registered.map((s: any) => s.state), ['TEST_NOT_TAKEN', 'TEST_NOT_PASSED', 'REJECTED', 'LOCKED_OUT']);
});

test('a provider with no specialty at all gets an empty registered list (the only case for "no specialty")', async () => {
	rows = []; samples = [];
	const r = await (await svc()).getPassedSpecialties('u1');
	assert.deepEqual([r.hasAccreditedSpecialties, r.registered], [false, []]);
	const none = await (await svc()).getPassedSpecialties('none');
	assert.deepEqual(none.registered, []);
});

test('approval state: test passed + samples under review / rejected (with the admin reason) / none / approved are told apart, and the selector rows carry it', async () => {
	const at = (m: number) => new Date(Date.UTC(2026, 9, 11, 10, m));
	rows = [
		row('ps-1', spec('s1', 'أ'), { isPassed: true, hasTakenAssessment: true, latestScore: 70, status: 'UNDER_AI_REVIEW', _count: { workSamples: 2 } }),
		row('ps-2', spec('s2', 'ب'), { isPassed: true, hasTakenAssessment: true, latestScore: 70, status: 'PENDING_PROOF', _count: { workSamples: 0 } }),
		row('ps-3', spec('s3', 'ج'), { isPassed: true, hasTakenAssessment: true, latestScore: 70, status: 'REJECTED', _count: { workSamples: 1 } }),
		row('ps-4', spec('s4', 'د'), { isPassed: true, hasTakenAssessment: true, latestScore: 70, status: 'APPROVED', _count: { workSamples: 1 } }),
		row('ps-5', spec('s5', 'هـ'), { isPassed: true, hasTakenAssessment: true, latestScore: 70, status: 'PENDING_PROOF', _count: { workSamples: 0 } }),
	];
	samples = [
		{ providerSpecialtyId: 'ps-3', status: 'REJECTED', aiFeedbackAr: 'x\n[مراجعة الإدارة] سبب الرفض: الملفات غير واضحة', createdAt: at(1) },
		{ providerSpecialtyId: 'ps-4', status: 'AI_VERIFIED', aiFeedbackAr: null, createdAt: at(1) },
		{ providerSpecialtyId: 'ps-5', status: 'MANUAL_REVIEW', aiFeedbackAr: null, createdAt: at(1) },
	];
	const r = await (await svc()).getPassedSpecialties('u1');
	const by = Object.fromEntries(r.registered.map((x: any) => [x.name, x]));
	assert.equal(by['أ'].approvalState, 'DRAFT_SAMPLES');              // wizard samples only: saved, in no admin queue
	assert.equal(by['ب'].approvalState, 'PASSED_NO_SAMPLES');          // passed the test, nothing uploaded
	assert.equal(by['ج'].approvalState, 'SAMPLES_REJECTED');
	assert.equal(by['ج'].rejectionReason, 'الملفات غير واضحة');
	assert.equal(by['د'].approvalState, 'APPROVED');                   // only a real admin APPROVED status
	assert.equal(by['هـ'].approvalState, 'SAMPLES_UNDER_REVIEW');
	assert.equal(by['هـ'].accreditationSamples.pending, 1);
	const tags = Object.fromEntries(r.categories[0].specialties.map((x: any) => [x.name, x.approvalState]));
	assert.equal(tags['ج'], 'SAMPLES_REJECTED');
	assert.equal(tags['د'], 'APPROVED');
});

test('a passed test alone is never APPROVED, whatever the score', async () => {
	rows = [row('ps-9', spec('s9', 'ز'), { isPassed: true, hasTakenAssessment: true, latestScore: 100, status: 'PENDING_PROOF' })];
	samples = [];
	const r = await (await svc()).getPassedSpecialties('u1');
	assert.notEqual(r.registered[0].approvalState, 'APPROVED');
	assert.equal(r.registered[0].approvalState, 'PASSED_NO_SAMPLES');
});

test('retake window: a failed specialty says how long until it can be retaken (cooldown) or that the attempt limit is reached; passed / approved ones never carry one', async () => {
	const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);
	rows = [
		row('ps-a', spec('s1', 'أ'), { hasTakenAssessment: true, latestScore: 10, status: 'REJECTED' }),
		row('ps-b', spec('s2', 'ب'), { hasTakenAssessment: true, latestScore: 10, status: 'REJECTED' }),
		row('ps-c', spec('s3', 'ج'), { hasTakenAssessment: true, latestScore: 10, status: 'REJECTED' }),
		row('ps-d', spec('s4', 'د'), { isPassed: true, hasTakenAssessment: true, latestScore: 70 }),
		row('ps-e', spec('s5', 'هـ'), {}),
	];
	samples = [];
	attempts = [
		{ providerSpecialtyId: 'ps-a', completedAt: hoursAgo(2), createdAt: hoursAgo(2.2) },                       // retake in ~22h
		{ providerSpecialtyId: 'ps-b', completedAt: hoursAgo(30), createdAt: hoursAgo(30.2) },                    // cooldown over
		...[1, 2, 3, 4, 5].map(i => ({ providerSpecialtyId: 'ps-c', completedAt: hoursAgo(25 * i), createdAt: hoursAgo(25 * i) })), // 5 attempts in 30 days
		{ providerSpecialtyId: 'ps-d', completedAt: hoursAgo(1), createdAt: hoursAgo(1) },
	];
	const r = await (await svc()).getPassedSpecialties('u1');
	const by = Object.fromEntries(r.registered.map((x: any) => [x.name, x]));
	assert.ok(by['أ'].retryAfterSeconds > 21 * 3600 && by['أ'].retryAfterSeconds <= 22 * 3600);
	assert.equal(by['أ'].attemptLimitReached, false);
	assert.equal(by['ب'].retryAfterSeconds, null);
	assert.equal(by['ج'].attemptLimitReached, true);
	assert.equal(by['د'].retryAfterSeconds, null);          // passed: no wait
	assert.equal(by['هـ'].retryAfterSeconds, null);         // never attempted
	assert.equal(by['هـ'].attemptLimitReached, false);
});
