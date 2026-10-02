import { prisma } from '../config/db';
import { resolveProviderDisplayIdentity } from '../utils/provider-display';
import { resolveProviderProgression } from '../utils/role-display-resolver';
import { LEVEL_MATRIX } from '../utils/progression-calculators';

// Marketplace recommendations are produced deterministically from stored
// data only. No AI generation is performed (no WaseetAI contract yet).
export type MarketplaceAiGenerationSource = 'DETERMINISTIC';

export interface AiRecommendationResult {
	recommendations: any[];
	bannerInsight: string;
	smartSearchTags: string[];
	generationSource: MarketplaceAiGenerationSource;
}

export class MarketplaceAiService {

	/**
	 * Deterministic marketplace recommendations ranked from real stored data (no AI generation)
	 */
	async generateAiRecommendations(params: {
		query?: string;
		category?: string;
		subSpecialty?: string;
		limit?: number;
	}): Promise<AiRecommendationResult> {
		const { query = '', category = 'all', subSpecialty = '', limit = 4 } = params;
		const safeLimit = Math.min(10, Math.max(1, Number(limit) || 4));
		const where: any = { status: { in: ['PUBLISHED', 'APPROVED'] } };
		if (query.trim()) where.OR = [{ title: { contains: query.trim(), mode: 'insensitive' } }, { description: { contains: query.trim(), mode: 'insensitive' } }];
		if (category && category !== 'all') where.specialty = { category: { slug: category } };
		if (subSpecialty) where.specialty = { ...where.specialty, slug: subSpecialty };

		// 1. Fetch active published service catalogs from database
		const dbModels = await prisma.serviceCatalog.findMany({
			where,
			include: {
				provider: {
					// Phase 3E.1: ProviderProfile display columns + persisted
					// ProviderGamification.currentLevelIndex are the canonical
					// sources (see formatModelForClient below) — currentLevel is
					// kept only as resolveProviderProgression's own explicit
					// fallback for a provider with no ProviderGamification row.
					select: {
						id: true, firstName: true, lastName: true, avatarUrl: true, email: true, currentLevel: true,
						providerProfile: { select: { firstName: true, lastName: true, avatarUrl: true, isVerified: true } },
						gamification: { select: { points: true, currentLevelIndex: true } }
					}
				},
				specialty: { include: { category: true } },
				stages: true,
				portfolioItem: true,
				reviews: { select: { rating: true } }
			},
			orderBy: { viewsCount: 'desc' },
			take: 15
		});

		if (dbModels.length === 0) {
			return {
				recommendations: [],
				bannerInsight: 'لا توجد نماذج منشورة مطابقة للبحث الحالي.',
				smartSearchTags: ['تصميم هوية', 'تطبيقات Flutter', 'ذكاء اصطناعي', 'تسويق رقمي'],
				generationSource: 'DETERMINISTIC'
			};
		}

		// 2. Deterministic ranking (real DB ordering, never presented as AI-generated)
		const topRanked = dbModels.slice(0, safeLimit).map((m) => {
			const matchScore = m.aiScore ?? m.aiAuditScore ?? 0;
			const reason = query ? `نتيجة مطابقة لعبارة البحث "${query}".` : 'متاح ضمن أعلى النماذج مشاهدة.';
			// Batch 5: aiMatchPercentage is null here. The stored aiScore is the
			// model's own AI quality/audit score, not a match against this
			// search, so it stays in `aiScore` only and is never relabeled as
			// a match percentage.
			return this.formatModelForClient(m, matchScore, reason, null);
		});

		return {
			recommendations: topRanked,
			bannerInsight: `تم استرجاع ${topRanked.length} نموذج من البيانات المنشورة المطابقة للبحث الحالي.`,
			smartSearchTags: ['تصميم هوية', 'تطبيقات جوال', 'حلول ذكاء اصطناعي', 'تسويق رقمي'],
			generationSource: 'DETERMINISTIC'
		};
	}

	/**
	 * Helper to format Prisma ServiceCatalog model into rich client-facing object
	 */
	private formatModelForClient(m: any, matchScore: number, recommendationReason: string, matchPercentage: number | null = matchScore) {
		// Display formatting only; does not participate in ranking.
		const identity = resolveProviderDisplayIdentity({
			providerProfile: m.provider?.providerProfile || {},
			user: m.provider || {}
		});
		const providerName = identity.fullName || (m.provider?.email ? m.provider.email.split('@')[0] : 'مزود معتمد');
		const providerLevel = resolveProviderProgression(m.provider?.gamification, {
			firstName: '',
			lastName: '',
			avatarUrl: null,
			profileCompletionPercent: 0,
			currentLevel: m.provider?.currentLevel || LEVEL_MATRIX[0].title,
			currentPoints: 0,
			pointsToNextLevel: 0
		}).currentLevel;

		let coverImage: string | null = (m as any).coverImage || null;
		if (!coverImage && m.portfolioItem?.coverImage) {
			coverImage = m.portfolioItem.coverImage;
		}

		const categoryTitle = m.specialty?.category?.nameAr || m.specialty?.nameAr || m.specialty?.name || 'خدمات عامة';
		const reviewsCount = m.reviews?.length || 0;
		const rating = reviewsCount ? Number((m.reviews.reduce((sum: number, review: any) => sum + review.rating, 0) / reviewsCount).toFixed(1)) : 0;

		return {
			id: m.id,
			title: m.title,
			description: m.description,
			category: categoryTitle,
			categorySlug: m.specialty?.category?.slug || 'general',
			specialtySlug: m.specialty?.slug || '',
			status: m.status,
			totalAmount: Number(m.totalAmount),
			totalDays: m.totalDays,
			aiScore: matchScore,
			aiClarityScore: m.aiClarityScore ?? 0,
			aiFeasibilityScore: m.aiFeasibilityScore ?? 0,
			viewsCount: m.viewsCount,
			rating,
			reviewsCount,
			isVerified: Boolean(m.provider?.providerProfile?.isVerified),
			isFeatured: matchScore >= 92,
			level: providerLevel || '',
			// The badge shows the provider's tier, so it stays in the provider/brand
			// colour family. Purple is reserved exclusively for AI surfaces (brand
			// rule #2/#8) — the AI match is already surfaced by its own badge.
			levelBg: matchScore >= 94 ? 'rgba(43,127,255,.7)' : 'rgba(43,212,199,.6)',
			levelColor: matchScore >= 94 ? '#5DA0FF' : '#2BD4C7',
			coverImage: coverImage,
			provider: {
				id: m.provider?.id || 'prov-id',
				name: providerName,
				avatar: identity.avatarUrl,
				initials: providerName.substring(0, 2)
			},
			stages: m.stages || [],
			aiRecommendationReason: recommendationReason,
			aiMatchPercentage: matchPercentage
		};
	}
}

export const marketplaceAiService = new MarketplaceAiService();
