import { prisma } from '../config/db';
import { logger } from '../config/logger';

export class AccreditationService {
	/**
	 * Evaluates and returns all platform specialties with the provider's eligibility status
	 */
	async getEligibleSpecialties(providerId: string) {
		try {
			const providerProfile = await prisma.providerProfile.findUnique({
				where: { userId: providerId },
			});

			if (!providerProfile) {
				throw new Error('Provider profile not found');
			}

			const providerSpecialties = await prisma.providerSpecialty.findMany({
				where: { providerProfileId: providerProfile.id },
				include: { specialty: true },
			});

			const data = providerSpecialties
				.filter(ps => ps.isActive)
				.map((ps) => {
					const spec = ps.specialty;
					return {
						id: ps.id,
						specialtyId: spec.id,
						name: spec.nameAr || spec.nameEn || spec.name,
						icon: spec.icon || 'code',
						latestScore: ps.latestScore ?? ps.quizScore ?? 0,
						isPassed: ps.isPassed
					};
				});

			return {
				success: true,
				count: data.length,
				data,
			};
		} catch (error: any) {
			logger.error(`[AccreditationService] Error fetching eligible specialties: ${error.message}`, error);
			return {
				success: false,
				error: 'Failed to fetch specialties',
				data: []
			};
		}
	}

	/**
	 * Returns the provider's active specialties after passing the platform test.
	 * Grouped by category for Accreditation Submission Wizard
	 */
	async getPassedSpecialties(userId: string) {
		try {
			const providerProfile = await prisma.providerProfile.findUnique({
				where: { userId },
			});

			if (!providerProfile) {
				return {
					success: true,
					hasAccreditedSpecialties: false,
					categories: []
				};
			}

			const passedSpecs = await prisma.providerSpecialty.findMany({
				where: {
					providerProfileId: providerProfile.id,
					isActive: true,
					isPassed: true
				},
				include: {
					specialty: {
						include: {
							category: true
						}
					}
				}
			});

			const categoriesMap = new Map();

			passedSpecs.forEach((ps) => {
				const spec = ps.specialty;
				const cat = spec?.category;

				if (!spec || !cat) return;

				if (!categoriesMap.has(cat.id)) {
					categoriesMap.set(cat.id, {
						categoryId: cat.id,
						categoryName: cat.nameAr || cat.nameEn || cat.name || 'عام',
						specialties: []
					});
				}

				const catEntry = categoriesMap.get(cat.id);
				const specName = spec.nameAr || spec.nameEn || spec.name;

				catEntry.specialties.push({
					id: ps.id,
					specialtyId: spec.id,
					name: specName,
					icon: spec.icon || '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
					score: ps.latestScore ?? ps.quizScore ?? 0,
					passedAt: ps.passedAt || ps.updatedAt,
					accreditationStatus: ps.status,
					subSpecialties: Array.isArray(ps.subSpecialties) ? ps.subSpecialties : []
				});
			});

			const categories = Array.from(categoriesMap.values());

			return {
				success: true,
				hasAccreditedSpecialties: categories.length > 0,
				categories
			};

		} catch (error: any) {
			logger.error(`[AccreditationService] Error fetching passed specialties: ${error.message}`, error);
			return {
				success: false,
				hasAccreditedSpecialties: false,
				categories: []
			};
		}
	}
}

export const accreditationService = new AccreditationService();
