import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specialtyService } from './specialty.service';

// The specialties chosen at signup / setup become provider_specialties (create-only, no duplicates), and the setup test is recorded on them as a fact.
type Row = { id: string; providerProfileId: string; specialtyId: string; subSpecialties: string[]; status: string; isActive: boolean; hasTakenAssessment: boolean; latestScore: number | null; quizScore: number | null; isPassed: boolean; passedAt: Date | null };
const SPECIALTIES = [
	{ id: 'sp-graphic', nameAr: 'تصميم جرافيك', isActive: true, category: { slug: 'design-creative' } },
	{ id: 'sp-logo', nameAr: 'شعارات وهوية بصرية', isActive: true, category: { slug: 'design-creative' } },
	{ id: 'sp-python', nameAr: 'تطوير Python', isActive: true, category: { slug: 'programming-development' } },
];
function fakeDb(profile: { mainSpecialty: string; subSpecialties: string[] }, rows: Row[] = []) {
	let seq = 0;
	const key = (w: any) => w.providerProfileId_specialtyId;
	const db: any = {
		category: { findFirst: async () => null },
		providerProfile: { findUnique: async () => ({ id: 'pp-1', ...profile }) },
		specialty: { findMany: async ({ where }: any) => SPECIALTIES.filter(s => s.isActive && where.nameAr.in.includes(s.nameAr) && (!where.category || s.category.slug === where.category.slug)) },
		providerSpecialty: {
			findUnique: async ({ where }: any) => rows.find(r => r.providerProfileId === key(where).providerProfileId && r.specialtyId === key(where).specialtyId) ?? null,
			upsert: async ({ where, create }: any) => {
				const hit = rows.find(r => r.providerProfileId === key(where).providerProfileId && r.specialtyId === key(where).specialtyId);
				if (hit) return hit;
				const row: Row = { id: `ps-${++seq}`, hasTakenAssessment: false, latestScore: null, quizScore: null, isPassed: false, passedAt: null, isActive: true, ...create };
				rows.push(row); return row;
			},
			findMany: async ({ where }: any) => rows.filter(r => r.providerProfileId === where.providerProfileId && r.isActive && where.specialty.nameAr.in.includes(SPECIALTIES.find(s => s.id === r.specialtyId)!.nameAr)),
			update: async ({ where, data }: any) => { Object.assign(rows.find(r => r.id === where.id)!, data); return {}; },
		},
	};
	return { db, rows };
}

test('setup: the chosen specialties become provider_specialties (PENDING_PROOF), only those of the chosen category, and a re-run creates no duplicate', async () => {
	const { db, rows } = fakeDb({ mainSpecialty: 'design-creative', subSpecialties: ['تصميم جرافيك', 'شعارات وهوية بصرية', 'تطوير Python'] });
	const first = await specialtyService.syncProviderSpecialtiesFromProfile('pp-1', db);
	assert.equal(first.created, 2); // the Python specialty belongs to another category: never linked
	assert.deepEqual(rows.map(r => [r.specialtyId, r.status]).sort(), [['sp-graphic', 'PENDING_PROOF'], ['sp-logo', 'PENDING_PROOF']]);
	const second = await specialtyService.syncProviderSpecialtiesFromProfile('pp-1', db);
	assert.equal(second.created, 0);
	assert.equal(rows.length, 2); // no duplicate rows
});

test('setup sync is CREATE-ONLY: an existing row (approved / passed) is never reset or modified', async () => {
	const existing: Row = { id: 'ps-old', providerProfileId: 'pp-1', specialtyId: 'sp-graphic', subSpecialties: ['x'], status: 'APPROVED', isActive: true, hasTakenAssessment: true, latestScore: 88, quizScore: 88, isPassed: true, passedAt: new Date('2026-01-01') };
	const { db, rows } = fakeDb({ mainSpecialty: 'design-creative', subSpecialties: ['تصميم جرافيك'] }, [existing]);
	const r = await specialtyService.syncProviderSpecialtiesFromProfile('pp-1', db);
	assert.deepEqual([r.created, r.ids], [0, ['ps-old']]);
	assert.deepEqual([rows[0].status, rows[0].isPassed, rows[0].latestScore, rows[0].subSpecialties], ['APPROVED', true, 88, ['x']]);
});

test('no sub-specialties chosen: nothing is created', async () => {
	const { db, rows } = fakeDb({ mainSpecialty: 'design-creative', subSpecialties: [] });
	assert.deepEqual(await specialtyService.syncProviderSpecialtiesFromProfile('pp-1', db), { created: 0, ids: [] });
	assert.equal(rows.length, 0);
});

test('setup test PASSED: the chosen specialties record taken / score / passed (a fact), their status is NOT changed (no approval)', async () => {
	const { db, rows } = fakeDb({ mainSpecialty: 'design-creative', subSpecialties: ['تصميم جرافيك', 'شعارات وهوية بصرية'] });
	assert.equal(await specialtyService.applySetupTestToSpecialties('pp-1', 72, true, db), 2);
	for (const r of rows) assert.deepEqual([r.hasTakenAssessment, r.latestScore, r.quizScore, r.isPassed, r.status, r.passedAt instanceof Date], [true, 72, 72, true, 'PENDING_PROOF', true]);
});

test('setup test NOT passed: taken + score are recorded, isPassed stays false (the page can say "لم تجتز")', async () => {
	const { db, rows } = fakeDb({ mainSpecialty: 'design-creative', subSpecialties: ['تصميم جرافيك'] });
	await specialtyService.applySetupTestToSpecialties('pp-1', 10, false, db);
	assert.deepEqual([rows[0].hasTakenAssessment, rows[0].latestScore, rows[0].isPassed, rows[0].passedAt], [true, 10, false, null]);
});

test('setup test never touches a row that already passed, is approved or is locked out', async () => {
	const mk = (id: string, specialtyId: string, status: string, isPassed: boolean): Row => ({ id, providerProfileId: 'pp-1', specialtyId, subSpecialties: [], status, isActive: true, hasTakenAssessment: true, latestScore: 90, quizScore: 90, isPassed, passedAt: null });
	const { db, rows } = fakeDb({ mainSpecialty: 'design-creative', subSpecialties: ['تصميم جرافيك', 'شعارات وهوية بصرية'] }, [mk('ps-a', 'sp-graphic', 'APPROVED', true), mk('ps-b', 'sp-logo', 'LOCKED_OUT', false)]);
	assert.equal(await specialtyService.applySetupTestToSpecialties('pp-1', 5, false, db), 0);
	assert.deepEqual(rows.map(r => [r.latestScore, r.isPassed]), [[90, true], [90, false]]);
});

// ── the hooks: setup save, profile edit and the setup test all feed provider_specialties ──
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

test('wiring: the setup save, the specialty edit and the setup test all create / record the provider specialties', () => {
	const ctrl = src('controllers/provider-profile.controller.ts');
	// the setup save syncs the specialty rows INSIDE its single transaction now (a failure rolls the whole save back) instead of best-effort afterwards
	assert.match(ctrl, /specialtyService\.syncProviderSpecialtiesFromProfile\(result\.id, tx as any\)/);
	assert.match(src('services/provider-profile.service.ts'), /specialtyService\.trySyncProviderSpecialties\(updatedProfile\.id\)/);
	assert.match(src('sockets/setup-test.gateway.ts'), /completeSetupTest\(session\.profileId, score, passed\)/);
	const done = src('services/setup-test-completion.service.ts');
	assert.match(done, /specialtyService\.applySetupTestToSpecialties\(profileId, score, passed, db\)/);
	assert.ok(done.indexOf("setupTestStatus: 'COMPLETED'") < done.indexOf('applySetupTestToSpecialties'), 'the specialties are recorded after the score is stored');
});

test('selectSpecialty never resets a passed / approved / under-review / locked specialty to PENDING_PROOF', () => {
	assert.match(src('services/specialty.service.ts'), /keepsProgress[\s\S]{0,400}existing\.isPassed \|\| existing\.status === SpecialtyVerificationStatus\.APPROVED/);
});
