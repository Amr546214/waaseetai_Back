import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// One catalog for the whole system: /api/skills/catalog, /catalog/all, /provider-mine, and the profile skills round trip.
process.env.JWT_SECRET = 'test-secret';

const categories = [
	{ id: 'c1', slug: 'programming-development', nameAr: 'البرمجة والتطوير', isActive: true, sortOrder: 1 },
	{ id: 'c2', slug: 'admin-custom', nameAr: 'فئة بلا كتالوج', isActive: true, sortOrder: 2 },
	{ id: 'c3', slug: 'hidden', nameAr: 'مخفية', isActive: false, sortOrder: 3 }
];
const store: any = { profile: { mainSpecialty: 'programming-development', subSpecialties: ['تطوير الواجهات الأمامية'], skills: [{ name: 'React' }, { name: 'HTML' }] }, providerSpecialties: [] as any[], skillRows: new Map<string, string>() };

const prisma: any = {
	category: {
		findMany: async ({ where }: any) => categories.filter(c => (where?.isActive === undefined || c.isActive === where.isActive)),
		findFirst: async ({ where }: any) => categories.find(c => c.isActive && where.OR.some((o: any) => Object.entries(o).every(([k, v]) => (c as any)[k] === v))) ?? null
	},
	providerProfile: { findUnique: async () => store.profile },
	providerSpecialty: { findMany: async () => store.providerSpecialties },
	skill: { upsert: async ({ where, create }: any) => { if (!store.skillRows.has(where.name)) store.skillRows.set(where.name, `id-${create.name}`); return { id: store.skillRows.get(where.name) }; } }
};
let loaded: Promise<any> | undefined;
const load = () => (loaded ??= (async () => {
	mock.module('../config/db', { namedExports: { prisma } });
	return { ctl: await import('./skills.controller.ts'), svc: await import('../services/skills-catalog.service.ts'), cfg: await import('../config/skills-catalog.config.ts') };
})());
const call = async (fn: any, req: any) => { let status = 200; let body: any; const res: any = { status(c: number) { status = c; return res; }, json(b: any) { body = b; return res; } }; await fn(req, res); return { status, body }; };

test('catalog: category by slug / id / nameAr returns the catalog skills of that category', async () => {
	const { ctl, cfg } = await load();
	for (const q of ['programming-development', 'c1', 'البرمجة والتطوير']) {
		const { status, body } = await call(ctl.getSkillsCatalog, { query: { category: q } });
		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.equal(body.data.category, 'programming-development');
		assert.deepEqual(body.data.skills, cfg.SKILLS_CATALOG['programming-development']);
	}
});

test('catalog: unknown or missing category = 200 with category null and an honest empty list', async () => {
	const { ctl } = await load();
	for (const query of [{ category: 'nope' }, {}, { category: '' }]) {
		const { status, body } = await call(ctl.getSkillsCatalog, { query });
		assert.equal(status, 200);
		assert.deepEqual(body.data, { category: null, skills: [] });
	}
});

test('catalog/all: active categories joined with the catalog; a category with no catalog entry returns skills []', async () => {
	const { ctl, cfg } = await load();
	const { body } = await call(ctl.getSkillsCatalogAll, {});
	assert.equal(body.success, true);
	assert.deepEqual(body.data.categories.map((c: any) => c.slug), ['programming-development', 'admin-custom']);
	assert.deepEqual(body.data.categories[0], { slug: 'programming-development', nameAr: 'البرمجة والتطوير', skills: cfg.SKILLS_CATALOG['programming-development'] });
	assert.deepEqual(body.data.categories[1].skills, []);
});

test('provider-mine: saved skills, main specialty, sub-specialties and the approved specialties with their category slug', async () => {
	const { ctl } = await load();
	store.providerSpecialties = [{ id: 'ps1', specialtyId: 'sp1', subSpecialties: ['React'], specialty: { slug: 'web-frontend', nameAr: 'تطوير الواجهات الأمامية', category: { slug: 'programming-development' } } }];
	const { status, body } = await call(ctl.getProviderMine, { user: { id: 'u1' } });
	assert.equal(status, 200);
	assert.deepEqual(body.data, {
		skills: ['React', 'HTML'], mainSpecialty: 'programming-development', subSpecialties: ['تطوير الواجهات الأمامية'],
		specialties: [{ specialtyId: 'sp1', slug: 'web-frontend', nameAr: 'تطوير الواجهات الأمامية', categorySlug: 'programming-development', subSpecialties: ['React'] }]
	});
});

test('routes: authenticated for everyone, provider-mine behind the provider activeRole guard, mounted at /api/skills, old provider route kept', () => {
	const routes = fs.readFileSync(path.join(__dirname, '../routes/skills.routes.ts'), 'utf8');
	assert.match(routes, /router\.use\(authenticate, requireActiveUser\)/);
	assert.match(routes, /router\.get\('\/provider-mine', authorizeActiveRole\(AccountType\.PROVIDER_INDIVIDUAL, AccountType\.PROVIDER_COMPANY\)/);
	assert.match(routes, /router\.get\('\/catalog\/all'/);
	assert.match(fs.readFileSync(path.join(__dirname, '../app.ts'), 'utf8'), /mountAppRoute\('\/api\/skills', skillsRoutes\)/);
	assert.match(fs.readFileSync(path.join(__dirname, '../routes/provider-profile.routes.ts'), 'utf8'), /router\.get\('\/skills\/catalog', requireProvider, providerProfileController\.getSkillsCatalog\)/);
});

test('provider-mine 403 for a client activeRole / 401 without a user (the real middleware)', async () => {
	const { authorizeActiveRole } = await import('../middlewares/auth.middleware.ts');
	const guard = authorizeActiveRole('PROVIDER_INDIVIDUAL' as any, 'PROVIDER_COMPANY' as any);
	const run = (user: any) => new Promise<any>(resolve => guard({ user } as any, {} as any, (e?: any) => resolve(e)));
	assert.equal((await run(undefined)).statusCode, 401);
	assert.equal((await run({ accountType: 'PROVIDER_INDIVIDUAL', activeRole: 'CLIENT', roles: ['CLIENT', 'PROVIDER'] })).statusCode, 403);
	assert.equal(await run({ accountType: 'CLIENT_INDIVIDUAL', activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER'] }), undefined);
});

test('profile skills round trip: what is saved is exactly what provider-mine returns, and a skill outside the catalog is a 400 (nothing saved)', async () => {
	const { ctl, svc } = await load();
	const picked = ['React', 'TypeScript', 'Node.js'];
	const ids = await svc.resolveSkillIdsFromCatalog(prisma, [' React ', 'TypeScript', 'Node.js', 'React'], 'programming-development', []);
	assert.equal(ids.length, 3);
	store.profile = { ...store.profile, skills: picked.map(name => ({ name })) };
	const { body } = await call(ctl.getProviderMine, { user: { id: 'u1' } });
	assert.deepEqual(body.data.skills, picked);

	const before = store.skillRows.size;
	await assert.rejects(() => svc.resolveSkillIdsFromCatalog(prisma, ['React', 'Photoshop المزيف'], 'programming-development', []), (e: any) => e.statusCode === 400 && /Photoshop المزيف/.test(e.message));
	assert.equal(store.skillRows.size, before);
});
