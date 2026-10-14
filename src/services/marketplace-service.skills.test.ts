import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Skills of a marketplace service come from the catalog of the specialty's Category (one source), are validated server-side and persisted in ServiceCatalog.skills.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

const rows: any[] = [];
const seen: any = { where: undefined };
const heldSkills: string[] = ['Figma'];
let ownSpecialty = true;
const stage = { title: 'مرحلة', description: 'وصف', percentage: 100, deliveryDays: 5, computedAmount: 100 };
const base = (over: any = {}) => ({ title: 'خدمة تطوير', description: 'وصف طويل للخدمة هنا', specialtyId: 'sp1', accreditationSampleId: 'as1', stages: [stage], ...over });
const full = (r: any) => ({ ...r, provider: { id: 'u1', firstName: 'A', lastName: 'B', avatarUrl: null, email: 'a@b.c', currentLevel: null, providerProfile: { isVerified: true, kycStatus: 'VERIFIED' }, gamification: null }, specialty: { nameAr: 'تطوير الواجهات', slug: 'web', category: { nameAr: 'البرمجة', slug: 'programming-development' } }, stages: [], reviews: [], portfolioItem: null, accreditationSample: { attachments: [], providerSpecialty: { status: 'APPROVED' } }, status: 'PUBLISHED', totalAmount: 100, totalDays: 5, gallery: [], viewsCount: 0, salesCount: 0 });

let loaded: Promise<any> | undefined;
const load = () => (loaded ??= (async () => {
	const tx: any = {
		serviceCatalog: {
			create: async ({ data }: any) => { const r = { id: `s${rows.length + 1}`, subSpecialty: data.subSpecialty, ...data, skills: data.skills ?? [], stages: [] }; rows.push(r); return r; },
			update: async ({ where, data }: any) => { const r = rows.find(x => x.id === where.id); Object.assign(r, data); return { ...r, stages: [] }; }
		},
		serviceStage: { deleteMany: async () => ({}) }
	};
	const prisma: any = {
		providerSpecialty: {
			findFirst: async () => (ownSpecialty ? { id: 'ps1', specialty: { id: 'sp1', category: { slug: 'programming-development' } } } : null),
			findMany: async () => [{ id: 'ps1', specialtyId: 'sp1', subSpecialties: ['React'], specialty: { slug: 'web', nameAr: 'تطوير الواجهات', category: { slug: 'programming-development' } } }]
		},
		providerProfile: { findUnique: async () => ({ skills: [...heldSkills.map(name => ({ name })), { name: 'x' }].slice(0, heldSkills.length), portfolioItems: [] }) },
		accreditationSample: { findFirst: async () => ({ id: 'as1' }) },
		portfolioItem: { findFirst: async () => null },
		serviceCatalog: {
			findFirst: async ({ where }: any) => rows.find(r => r.id === where.id) ?? null,
			findMany: async ({ where }: any) => { seen.where = where; return rows.map(full); },
			count: async () => rows.length,
			findUnique: async ({ where }: any) => { const r = rows.find(x => x.id === where.id); return r ? full(r) : null; },
			update: async () => ({ viewsCount: 1 })
		},
		review: { aggregate: async () => ({ _count: { _all: 0 }, _avg: { rating: null } }) },
		$transaction: async (fn: any) => fn(tx)
	};
	mock.module('../config/db', { namedExports: { prisma } });
	mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
	mock.module('./marketplace-ai.service', { namedExports: { marketplaceAiService: {} } });
	mock.module('./ai-audit.service', { namedExports: { aiAuditService: { auditProjectModel: async () => {} } } });
	return await import('./marketplace-service.service.ts');
})());
const svc = async () => new ((await load()).MarketplaceService)();

test('create: catalog skills are trimmed, de-duplicated, saved, and come back in list tags + skills', async () => {
	const s = await svc();
	const created = await s.createService('u1', base({ skills: [' React ', 'TypeScript', 'React'] }));
	assert.deepEqual(created.skills, ['React', 'TypeScript']);
	const list = await s.getMarketplaceModels({});
	assert.deepEqual(list.models[0].skills, ['React', 'TypeScript']);
	assert.deepEqual(list.models[0].tags, ['تطوير الواجهات', 'React', 'TypeScript']);
});

test('detail output carries skills and tags (skills added after specialty and sub-specialty)', async () => {
	const s = await svc();
	rows.length = 0;
	const created = await s.createService('u1', base({ subSpecialty: 'واجهات', skills: ['Vue.js'] }));
	const detail = await s.getMarketplaceModelById(created.id);
	assert.deepEqual(detail.skills, ['Vue.js']);
	assert.deepEqual(detail.tags, ['تطوير الواجهات', 'واجهات', 'Vue.js']);
});

test('create: a skill outside the specialty catalog is a 400 naming the offender and nothing is saved', async () => {
	const s = await svc();
	rows.length = 0;
	await assert.rejects(() => s.createService('u1', base({ skills: ['React', 'مهارة مخترعة'] })), (e: any) => /مهارة مخترعة/.test(e.message) && !/React\)/.test(e.message));
	assert.equal(rows.length, 0);
	await assert.rejects(() => s.createService('u1', base({ skills: ['AutoCAD'] })), /AutoCAD/); // a real skill of ANOTHER category is refused too
	assert.equal(rows.length, 0);
});

test('create: a skill the provider already holds on the profile is accepted even if it is not in this category (old data is never broken)', async () => {
	const s = await svc();
	rows.length = 0;
	const created = await s.createService('u1', base({ skills: ['Figma'] }));
	assert.deepEqual(created.skills, ['Figma']);
});

test('create: more than 30 skills or a non-array is refused', async () => {
	const s = await svc();
	rows.length = 0;
	await assert.rejects(() => s.createService('u1', base({ skills: Array.from({ length: 31 }, (_, i) => `S${i}`) })), /30/);
	await assert.rejects(() => s.createService('u1', base({ skills: 'React' })), /غير صالحة/);
	assert.equal(rows.length, 0);
});

test('create: without skills the service is created as before (skills untouched/empty)', async () => {
	const s = await svc();
	rows.length = 0;
	const created = await s.createService('u1', base());
	assert.deepEqual(created.skills, []);
});

test('create/update: a specialty that is not the provider\'s own is refused (before any skill is judged)', async () => {
	const s = await svc();
	rows.length = 0;
	ownSpecialty = false;
	try {
		await assert.rejects(() => s.createService('u1', base({ skills: ['React'] })), /التخصص غير معتمد/);
		await assert.rejects(() => s.updateService('u1', 's1', base({ skills: ['React'] })), /التخصص غير معتمد|غير موجود/);
	} finally { ownSpecialty = true; }
	assert.equal(rows.length, 0);
});

test('update: valid skills replace the stored list; an invalid one is a 400 and the stored list is unchanged; omitted skills leave it untouched', async () => {
	const s = await svc();
	rows.length = 0;
	const created = await s.createService('u1', base({ skills: ['React'] }));
	await s.updateService('u1', created.id, base({ skills: ['Angular', 'Git'] }));
	assert.deepEqual(rows[0].skills, ['Angular', 'Git']);
	await assert.rejects(() => s.updateService('u1', created.id, base({ skills: ['Angular', 'تصميم الشعارات'] })), /تصميم الشعارات/);
	assert.deepEqual(rows[0].skills, ['Angular', 'Git']);
	await s.updateService('u1', created.id, base());
	assert.deepEqual(rows[0].skills, ['Angular', 'Git']);
});

test('listing filter: skill=<exact catalog name> becomes skills: { has } and existing params still work', async () => {
	const s = await svc();
	await s.getMarketplaceModels({ skill: ' React ', category: 'programming-development', maxDays: '10' });
	assert.deepEqual(seen.where.skills, { has: 'React' });
	assert.equal(seen.where.totalDays.lte, 10);
	assert.ok(seen.where.specialty.category);
	await s.getMarketplaceModels({});
	assert.equal(seen.where.skills, undefined);
});

test('wizard data: each approved specialty carries its catalog skillOptions and the saved skills of the provider', async () => {
	const s = await svc();
	const data = await s.getProviderPreData('u1');
	assert.deepEqual(data.savedSkills, ['Figma']);
	assert.equal(data.specialties[0].categorySlug, 'programming-development');
	assert.ok(data.specialties[0].skillOptions.includes('React'));
	assert.ok(!data.specialties[0].skillOptions.includes('AutoCAD'));
});
