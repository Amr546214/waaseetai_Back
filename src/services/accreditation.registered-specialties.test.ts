import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// GET /accreditation/passed-specialties: the model-upload / accreditation selectors only offer PASSED specialties, but the answer also lists every registered one with
// its state, so the pages say where each stands (test not taken / not passed / rejected / locked) instead of "no specialty".
process.env.JWT_SECRET = 'test-secret'; process.env.OPENAI_API_KEY = 'test-key';
const spec = (id: string, nameAr: string) => ({ id, nameAr, category: { id: 'c1', nameAr: 'تصميم وإبداع' } });
const row = (id: string, specialty: any, over: any) => ({ id, specialtyId: specialty.id, specialty, status: 'PENDING_PROOF', isPassed: false, hasTakenAssessment: false, latestScore: null, quizScore: null, passedAt: null, subSpecialties: [], isActive: true, createdAt: new Date(), updatedAt: new Date(), ...over });
let rows: any[] = [];
let loaded: Promise<any> | undefined;
const svc = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma: {
		providerProfile: { findUnique: async ({ where }: any) => (where.userId === 'none' ? null : { id: 'pp-1' }) },
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
	rows = [];
	const r = await (await svc()).getPassedSpecialties('u1');
	assert.deepEqual([r.hasAccreditedSpecialties, r.registered], [false, []]);
	const none = await (await svc()).getPassedSpecialties('none');
	assert.deepEqual(none.registered, []);
});
