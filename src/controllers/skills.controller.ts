import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { getCatalogAll, getCatalogForCategoryParam, listProviderSpecialtiesWithCatalog } from '../services/skills-catalog.service';

// GET /api/skills/catalog?category=<slug|id|nameAr>: the catalog skills of one category (unknown or missing category = 200 { category: null, skills: [] }).
export const getSkillsCatalog = async (req: Request, res: Response) => {
	try {
		const data = await getCatalogForCategoryParam(prisma, req.query.category);
		res.json({ success: true, data });
	} catch (error) {
		res.status(500).json({ success: false, message: 'Internal server error' });
	}
};

// GET /api/skills/catalog/all: every active Category joined with the catalog.
export const getSkillsCatalogAll = async (_req: Request, res: Response) => {
	try {
		res.json({ success: true, data: await getCatalogAll(prisma) });
	} catch (error) {
		res.status(500).json({ success: false, message: 'Internal server error' });
	}
};

// GET /api/skills/provider-mine (provider activeRole): the signed-in provider's saved skills / sub-specialties and approved specialties, for suggestions.
export const getProviderMine = async (req: Request, res: Response) => {
	try {
		const userId = req.user!.id;
		const profile = await prisma.providerProfile.findUnique({
			where: { userId },
			select: { mainSpecialty: true, subSpecialties: true, skills: { select: { name: true }, orderBy: { name: 'asc' } } }
		});
		const specialties = await listProviderSpecialtiesWithCatalog(prisma, userId);
		res.json({
			success: true,
			data: {
				skills: (profile?.skills ?? []).map(s => s.name),
				mainSpecialty: profile?.mainSpecialty ?? null,
				subSpecialties: profile?.subSpecialties ?? [],
				specialties: specialties.map(({ id: _id, skillOptions: _options, ...rest }) => rest)
			}
		});
	} catch (error) {
		res.status(500).json({ success: false, message: 'Internal server error' });
	}
};
