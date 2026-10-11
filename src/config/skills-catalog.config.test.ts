import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILLS_CATALOG, SKILL_NAME_MAX, skillsForCategory, allCatalogSkills } from './skills-catalog.config';
import { resolveCategorySlug, resolveSkillIdsFromCatalog } from '../services/skills-catalog.service';

const seed = readFileSync(join(__dirname, '..', '..', 'prisma', 'seed-marketplace-taxonomy.ts'), 'utf8');
const taxonomySlugs = [...seed.matchAll(/^  \{\n    slug: '([a-z0-9-]+)'/gm)].map(m => m[1]);

test('the catalog covers exactly the marketplace main specialties (the 19 category slugs of the taxonomy seed)', () => {
  assert.equal(taxonomySlugs.length, 19);
  assert.deepEqual(Object.keys(SKILLS_CATALOG).sort(), [...taxonomySlugs].sort());
});

test('every category has a real list: no duplicates, no empty names, within the length cap', () => {
  for (const [slug, list] of Object.entries(SKILLS_CATALOG)) {
    assert.ok(list.length >= 10, `${slug} has ${list.length} skills`);
    assert.equal(new Set(list).size, list.length, `${slug} has duplicates`);
    for (const n of list) { assert.equal(n, n.trim()); assert.ok(n.length > 0 && n.length <= SKILL_NAME_MAX, `${slug}: "${n}"`); }
  }
});

test('skills are filtered by field: programming never offers design/marketing skills and vice versa', () => {
  const programming = skillsForCategory('programming-development');
  const design = skillsForCategory('design-creative');
  const marketing = skillsForCategory('digital-marketing');
  assert.ok(programming.includes('React') && !programming.includes('Adobe Photoshop') && !programming.includes('Google Ads'));
  assert.ok(design.includes('Figma') && !design.includes('React') && !design.includes('Python'));
  assert.ok(marketing.includes('Google Ads') && !marketing.includes('React'));
  assert.deepEqual(skillsForCategory('nope'), []);
  assert.deepEqual(skillsForCategory(null), []);
  assert.ok(allCatalogSkills().length > 250);
});

// a fake db: only what the helper touches
function fakeDb(categories: { id: string; slug: string; nameAr: string }[] = []) {
  const created: string[] = [];
  const db: any = {
    category: { findFirst: async ({ where }: any) => categories.find(c => where.OR.some((o: any) => Object.entries(o).every(([k, v]) => (c as any)[k] === v))) ?? null },
    skill: { upsert: async ({ where, create }: any) => { created.push(`${where.name}|${create.category}`); return { id: `id-${where.name}` }; } },
  };
  return { db, created };
}

test('resolveCategorySlug: a slug, an id or the Arabic name all resolve to the same category slug; unknown is null', async () => {
  const { db } = fakeDb([{ id: 'cat-1', slug: 'design-creative', nameAr: 'تصميم وإبداع' }]);
  assert.equal(await resolveCategorySlug(db, 'design-creative'), 'design-creative');
  assert.equal(await resolveCategorySlug(db, 'cat-1'), 'design-creative');
  assert.equal(await resolveCategorySlug(db, 'تصميم وإبداع'), 'design-creative');
  assert.equal(await resolveCategorySlug(db, 'whatever'), null);
  assert.equal(await resolveCategorySlug(db, ''), null);
});

test('resolveSkillIdsFromCatalog: catalog skills of the main specialty are accepted and their rows created lazily with the category', async () => {
  const { db, created } = fakeDb();
  const ids = await resolveSkillIdsFromCatalog(db, ['React', ' Node.js ', 'React'], 'programming-development');
  assert.deepEqual(ids, [{ id: 'id-React' }, { id: 'id-Node.js' }]);
  assert.deepEqual(created, ['React|programming-development', 'Node.js|programming-development']);
});

test('resolveSkillIdsFromCatalog: a skill outside the chosen field (or free text) is a 400 naming it, and nothing is created', async () => {
  const { db, created } = fakeDb();
  await assert.rejects(() => resolveSkillIdsFromCatalog(db, ['React', 'Adobe Photoshop'], 'programming-development'), (e: any) => e.statusCode === 400 && e.message.includes('Adobe Photoshop'));
  await assert.rejects(() => resolveSkillIdsFromCatalog(db, ['مهارة من عندي'], 'programming-development'), (e: any) => e.statusCode === 400);
  await assert.rejects(() => resolveSkillIdsFromCatalog(db, ['React'], null), (e: any) => e.statusCode === 400); // no main specialty yet: nothing is offered
  assert.deepEqual(created, []);
});

test('resolveSkillIdsFromCatalog: skills the provider already holds stay valid (an older profile can still be saved); changing the field drops no one silently', async () => {
  const { db } = fakeDb();
  const ids = await resolveSkillIdsFromCatalog(db, ['React', 'Legacy Skill'], 'design-creative', ['React', 'Legacy Skill']);
  assert.deepEqual(ids.map(i => i.id), ['id-React', 'id-Legacy Skill']);
});

import { planSpecialtyUpdate } from '../services/skills-catalog.service';

function planDb(specialtiesByCat: Record<string, string[]>) {
  return {
    category: { findFirst: async ({ where }: any) => { const names: Record<string, string> = { 'برمجة وتطوير': 'programming-development', 'تصميم وإبداع': 'design-creative' }; const hit = where.OR.flatMap((o: any) => [o.slug, names[o.nameAr]]).find((h: any) => h && specialtiesByCat[h]); return hit ? { slug: hit } : null; } },
    specialty: { findMany: async ({ where }: any) => (specialtiesByCat[where.category.slug] ?? []).filter(n => where.nameAr.in.includes(n)).map(nameAr => ({ nameAr })) },
    skill: {},
  } as any;
}
const DB = planDb({ 'programming-development': ['تطوير الواجهات الأمامية', 'تطوير Python'], 'design-creative': ['تصميم جرافيك'] });

test('planSpecialtyUpdate: a main specialty typed as a name is stored as the category slug; sub-specialties are validated inside that category', async () => {
  const p = await planSpecialtyUpdate(DB, { storedMain: 'programming-development', requestedMain: 'برمجة وتطوير', subSpecialties: ['تطوير Python'], heldSkills: [] });
  assert.deepEqual([p.mainSpecialty, p.subSpecialties, p.skillsAfterFieldChange], ['programming-development', ['تطوير Python'], undefined]);
});

test('planSpecialtyUpdate: free text that is not a marketplace specialty is refused; the already stored legacy value is tolerated', async () => {
  await assert.rejects(() => planSpecialtyUpdate(DB, { storedMain: 'programming-development', requestedMain: 'مثال: تصميم الهوية البصرية', heldSkills: [] }), /INVALID_SPECIALTY/);
  const legacy = await planSpecialtyUpdate(DB, { storedMain: 'دعم فني', requestedMain: 'دعم فني', heldSkills: [] });
  assert.equal(legacy.mainSpecialty, 'دعم فني');
});

test('planSpecialtyUpdate: a sub-specialty of ANOTHER field is refused', async () => {
  await assert.rejects(() => planSpecialtyUpdate(DB, { storedMain: 'programming-development', requestedMain: 'programming-development', subSpecialties: ['تصميم جرافيك'], heldSkills: [] }), /INVALID_SUB_SPECIALTY/);
});

test('planSpecialtyUpdate: changing the field keeps only the skills of the new field and clears the old sub-specialties (no silent mismatch)', async () => {
  const held = [{ id: 'a', name: 'React' }, { id: 'b', name: 'Figma' }, { id: 'c', name: 'Python' }];
  const p = await planSpecialtyUpdate(DB, { storedMain: 'programming-development', requestedMain: 'design-creative', heldSkills: held });
  assert.equal(p.mainSpecialty, 'design-creative');
  assert.deepEqual(p.skillsAfterFieldChange, [{ id: 'b' }]);
  assert.deepEqual(p.subSpecialties, []);
  const same = await planSpecialtyUpdate(DB, { storedMain: 'programming-development', requestedMain: 'programming-development', heldSkills: held });
  assert.equal(same.skillsAfterFieldChange, undefined); // same field: nothing is touched
});
