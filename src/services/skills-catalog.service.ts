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
