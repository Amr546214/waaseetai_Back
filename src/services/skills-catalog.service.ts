import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { SKILLS_CATALOG, SKILL_NAME_MAX, normalizeSkillName, skillsForCategory } from '../config/skills-catalog.config';

export const SKILLS_NOT_IN_CATALOG_MESSAGE = 'اختر مهارات من قائمة المهارات المقترحة لمجالك؛ لم يتم حفظ البيانات.';

/** A main specialty is stored as the Category slug (the wizard) or, for older rows, the id or the Arabic name: all three resolve to the slug. */
type Db = Pick<PrismaClient, 'category' | 'skill'>;

export async function resolveCategorySlug(db: Db, mainSpecialty: string | null | undefined): Promise<string | null> {
	const value = String(mainSpecialty ?? '').trim();
	if (!value) return null;
	if (Object.prototype.hasOwnProperty.call(SKILLS_CATALOG, value)) return value;
	const category = await db.category.findFirst({
		where: { isActive: true, OR: [{ id: value }, { slug: value }, { nameAr: value }] },
		select: { slug: true }
	});
	return category?.slug ?? null;
}

/**
 * The catalog is the only source of provider skills. Every submitted name must be a skill of the provider's main specialty (or a skill the provider
 * already holds, so an older profile is never broken by a re-save). The Skill rows are created only for catalog names that were really picked
 * (no seed, no migration, no free text). The db client is passed in by the caller (the caller's own prisma, which tests can substitute). Anything else is a 400 that names the offenders and nothing is saved.
 */
export async function resolveSkillIdsFromCatalog(db: Db, names: string[], mainSpecialty: string | null | undefined, alreadyHeld: string[] = []): Promise<{ id: string }[]> {
	const wanted = [...new Set(names.map(normalizeSkillName).filter(Boolean))];
	if (wanted.some(n => n.length > SKILL_NAME_MAX)) throw new AppError(SKILLS_NOT_IN_CATALOG_MESSAGE, 400);
	const slug = await resolveCategorySlug(db, mainSpecialty);
	const allowed = new Set<string>([...skillsForCategory(slug), ...alreadyHeld.map(normalizeSkillName)]);
	const outside = wanted.filter(n => !allowed.has(n));
	if (outside.length) throw new AppError(`${SKILLS_NOT_IN_CATALOG_MESSAGE} (${outside.slice(0, 5).join('، ')})`, 400);
	const rows = await Promise.all(wanted.map(name => db.skill.upsert({ where: { name }, update: {}, create: { name, category: slug }, select: { id: true } })));
	return rows.map(({ id }) => ({ id }));
}

export interface SpecialtyPlan { mainSpecialty: string; subSpecialties: string[] | undefined; skillsAfterFieldChange: { id: string }[] | undefined }

/**
 * Edit-page rule for the main specialty, sub-specialties and the skills that depend on them:
 *  - the main specialty is stored as the marketplace Category slug: a name or an id is normalised to it; a value that is not a marketplace
 *    specialty is refused (INVALID_SPECIALTY), except the value already stored (an older profile can still save its other fields);
 *  - sub-specialties must be active specialties of that category (INVALID_SUB_SPECIALTY);
 *  - changing the field keeps only the skills that belong to the new field and clears the sub-specialties that were not re-picked.
 */
export async function planSpecialtyUpdate(
	db: Pick<PrismaClient, 'category' | 'specialty' | 'skill'>,
	input: { storedMain: string; requestedMain: string; subSpecialties?: string[]; heldSkills: { id: string; name: string }[] }
): Promise<SpecialtyPlan> {
	const storedMain = input.storedMain.trim();
	const requestedMain = input.requestedMain.trim();
	let mainSpecialty = requestedMain;
	if (requestedMain) {
		const slug = await resolveCategorySlug(db, requestedMain);
		if (slug) mainSpecialty = slug;
		else if (requestedMain !== storedMain) throw new Error('INVALID_SPECIALTY');
	}
	const categorySlug = await resolveCategorySlug(db, mainSpecialty);
	let subSpecialties: string[] | undefined;
	if (input.subSpecialties) {
		const names = [...new Set(input.subSpecialties.filter(Boolean))].slice(0, 30);
		if (names.length) {
			const rows = categorySlug ? await db.specialty.findMany({ where: { isActive: true, category: { slug: categorySlug }, nameAr: { in: names } }, select: { nameAr: true } }) : [];
			if (rows.length !== names.length) throw new Error('INVALID_SUB_SPECIALTY');
		}
		subSpecialties = names;
	}
	const storedSlug = await resolveCategorySlug(db, storedMain);
	const fieldChanged = !!categorySlug && storedSlug !== categorySlug;
	let skillsAfterFieldChange: { id: string }[] | undefined;
	if (fieldChanged) {
		const allowed = new Set(skillsForCategory(categorySlug));
		skillsAfterFieldChange = input.heldSkills.filter(sk => allowed.has(sk.name)).map(sk => ({ id: sk.id }));
		if (subSpecialties === undefined) subSpecialties = [];
	}
	return { mainSpecialty, subSpecialties, skillsAfterFieldChange };
}

export const SKILLS_MAX_PER_ITEM = 30;

type CatalogDb = Pick<PrismaClient, 'category'>;

/** GET /api/skills/catalog: the skills of ONE category (slug | id | nameAr). Unknown or missing category = { category: null, skills: [] } (200, honest empty). */
export async function getCatalogForCategoryParam(db: Db, value: unknown): Promise<{ category: string | null; skills: string[] }> {
	const slug = await resolveCategorySlug(db, typeof value === 'string' ? value : '');
	return { category: slug, skills: skillsForCategory(slug) };
}

/** GET /api/skills/catalog/all: every ACTIVE Category (the DB taxonomy) joined with the catalog; a category without a catalog entry returns skills: []. */
export async function getCatalogAll(db: CatalogDb): Promise<{ categories: { slug: string; nameAr: string; skills: string[] }[] }> {
	const rows = await db.category.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { slug: true, nameAr: true } });
	return { categories: rows.map(c => ({ slug: c.slug, nameAr: c.nameAr, skills: skillsForCategory(c.slug) })) };
}

/** Trim + de-duplicate + cap a submitted skills list. Not an array / non-strings are a 400. */
export function normalizeSkillList(input: unknown): string[] {
	if (!Array.isArray(input) || input.some(v => typeof v !== 'string')) throw new AppError('قائمة المهارات غير صالحة', 400);
	const names = [...new Set((input as string[]).map(normalizeSkillName).filter(Boolean))];
	if (names.length > SKILLS_MAX_PER_ITEM) throw new AppError(`الحد الأقصى للمهارات ${SKILLS_MAX_PER_ITEM}`, 400);
	return names;
}

/**
 * Server-side rule shared by the marketplace service and the client request: every skill must belong to the catalog of the Category of the chosen
 * specialty (or be in `alreadyHeld`, so older data is never broken). Returns the clean list; otherwise 400 naming the offenders (nothing is saved).
 */
export function assertSkillsInCategory(names: unknown, categorySlug: string | null | undefined, alreadyHeld: string[] = []): string[] {
	const wanted = normalizeSkillList(names);
	const allowed = new Set<string>([...skillsForCategory(categorySlug), ...alreadyHeld.map(normalizeSkillName)]);
	const outside = wanted.filter(n => !allowed.has(n));
	if (outside.length) throw new AppError(`${SKILLS_NOT_IN_CATALOG_MESSAGE} (${outside.slice(0, 5).join('، ')})`, 400);
	return wanted;
}

export interface ProviderSpecialtyWithCatalog { id: string; specialtyId: string; slug: string; nameAr: string; categorySlug: string | null; subSpecialties: string[]; skillOptions: string[] }

/** The provider's approved + active specialties (the ones a service can be published under), each with the catalog skills of its Category. */
export async function listProviderSpecialtiesWithCatalog(db: Pick<PrismaClient, 'providerSpecialty'>, userId: string): Promise<ProviderSpecialtyWithCatalog[]> {
	const rows = await db.providerSpecialty.findMany({
		where: { providerProfile: { userId }, isActive: true, isPassed: true, status: 'APPROVED' },
		select: { id: true, specialtyId: true, subSpecialties: true, specialty: { select: { slug: true, nameAr: true, category: { select: { slug: true } } } } }
	});
	return rows.map(r => ({
		id: r.id,
		specialtyId: r.specialtyId,
		slug: r.specialty.slug,
		nameAr: r.specialty.nameAr,
		categorySlug: r.specialty.category?.slug ?? null,
		subSpecialties: r.subSpecialties,
		skillOptions: skillsForCategory(r.specialty.category?.slug)
	}));
}
