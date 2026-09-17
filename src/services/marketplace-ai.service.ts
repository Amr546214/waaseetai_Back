import OpenAI from 'openai';
import { prisma } from '../config/db';
import { resolveProviderDisplayIdentity } from '../utils/provider-display';
import { resolveProviderProgression } from '../utils/role-display-resolver';
import { LEVEL_MATRIX } from '../utils/progression-calculators';

export interface AiRecommendationResult {
	recommendations: any[];
	bannerInsight: string;
	smartSearchTags: string[];
}

export class MarketplaceAiService {
	private openai: OpenAI | null = null;

	constructor() {
		if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy_key') {
			this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
		}
	}

	/**
	 * Generates AI-powered Recommendations & Market Insights using OpenAI API
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
				bannerInsight: 'محرك Waseet AI جاهز لاستقبال وتحليل النماذج البرمجية والتصميمية المنشورة.',
				smartSearchTags: ['تصميم هوية', 'تطبيقات Flutter', 'ذكاء اصطناعي', 'تسويق رقمي']
			};
		}

		// 2. Prepare lightweight summary array for OpenAI prompt
		const modelsSummary = dbModels.map(m => ({
			id: m.id,
			title: m.title,
			description: m.description ? m.description.substring(0, 150) : '',
			category: m.specialty?.name || 'خدمة معتمدة',
			totalAmount: Number(m.totalAmount) || 0,
			totalDays: m.totalDays || 1,
			aiScore: m.aiScore ?? m.aiAuditScore ?? 0
		}));

		// 3. Attempt OpenAI analysis
		if (this.openai) {
			try {
				const prompt = `
You are Waseet AI Marketplace Recommendation & Intelligence Engine.
Analyze the following published marketplace models for a client user.
Client Context:
- Search Query: "${query || 'General Search'}"
- Selected Category Filter: "${category}"
- Selected Sub-Specialty Filter: "${subSpecialty}"

Available Models List (JSON):
${JSON.stringify(modelsSummary)}

Your Task:
Select the top ${safeLimit} most relevant models and generate JSON with the following EXACT structure:
{
  "bannerInsight": "Single energetic Arabic sentence summarizing AI recommendations (e.g. اختيارات الذكاء الاصطناعي لك: تم تحليل X نموذجاً معتمداً بنسبة توافق تصل إلى Y%)",
  "smartSearchTags": ["Tag1 in Arabic", "Tag2 in Arabic", "Tag3 in Arabic"],
  "recommendations": [
    {
      "id": "model_id",
      "aiMatchPercentage": 96,
      "aiRecommendationReason": "Clear, professional Arabic rationale explaining why OpenAI selected this model (mentioning quality, feasibility, clarity or scope)"
    }
  ]
}
Return ONLY valid JSON without markdown formatting or code fences.
`;

				const completion = await this.openai.chat.completions.create({
					model: 'gpt-4o-mini',
					messages: [
						{ role: 'system', content: 'You are Waseet AI assistant. Always respond with pure valid JSON in Arabic.' },
						{ role: 'user', content: prompt }
					],
					temperature: 0.5,
					max_tokens: 700
				});

				const rawContent = completion.choices[0]?.message?.content?.trim() || '';
				const cleanedJson = rawContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
				const parsed = JSON.parse(cleanedJson);

				if (parsed && Array.isArray(parsed.recommendations)) {
					const recMap = new Map<string, { aiMatchPercentage: number; aiRecommendationReason: string }>();
					parsed.recommendations.forEach((item: any) => {
						if (item.id) {
								recMap.set(item.id, {
									aiMatchPercentage: Math.min(100, Math.max(0, Number(item.aiMatchPercentage) || 0)),
								aiRecommendationReason: item.aiRecommendationReason || 'نموذج عمل معتمد يحقق أعلى معايير الجودة والجدوى.'
							});
						}
					});

					const matchedModels = dbModels
						.filter(m => recMap.has(m.id))
						.map(m => {
							const aiData = recMap.get(m.id)!;
							return this.formatModelForClient(m, aiData.aiMatchPercentage, aiData.aiRecommendationReason);
						});

					// Fill remaining if needed
					if (matchedModels.length < safeLimit) {
						dbModels.forEach(m => {
							if (matchedModels.length < safeLimit && !matchedModels.some(existing => existing.id === m.id)) {
								matchedModels.push(this.formatModelForClient(m, m.aiScore ?? m.aiAuditScore ?? 0, 'متاح ضمن نتائج البحث الحالية.'));
							}
						});
					}

					return {
						recommendations: matchedModels,
						bannerInsight: parsed.bannerInsight || `اختيارات الذكاء الاصطناعي لك: تحليل النماذج المنشورة وتطابق الجودة بنسبة تصل إلى 96%`,
						smartSearchTags: parsed.smartSearchTags || ['هوية بصرية', 'Flutter', 'تسويق', 'مواقع ويب']
					};
				}
			} catch (err) {
				console.warn('[MarketplaceAiService] OpenAI completion failed or timed out. Using Heuristic Engine:', err);
			}
		}

		// 4. Robust Algorithmic Heuristic Fallback if OpenAI key is missing or fails
		const topRanked = dbModels.slice(0, safeLimit).map((m) => {
			const matchScore = m.aiScore ?? m.aiAuditScore ?? 0;
			const reason = query ? `نتيجة مطابقة لعبارة البحث "${query}".` : 'متاح ضمن أعلى النماذج مشاهدة.';
			return this.formatModelForClient(m, matchScore, reason);
		});

		return {
			recommendations: topRanked,
			bannerInsight: `تم استرجاع ${topRanked.length} نموذج من البيانات المنشورة المطابقة للبحث الحالي.`,
			smartSearchTags: ['تصميم هوية', 'تطبيقات جوال', 'حلول ذكاء اصطناعي', 'تسويق رقمي']
		};
	}

	/**
	 * Helper to format Prisma ServiceCatalog model into rich client-facing object
	 */
	private formatModelForClient(m: any, matchScore: number, recommendationReason: string) {
		// Phase 3E.1: display formatting only — the AI ranking prompt
		// (modelsSummary, above) never receives provider name/level at all,
		// so none of this participates in recommendation selection/scoring.
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
			levelBg: matchScore >= 94 ? 'rgba(123,47,190,.7)' : 'rgba(43,212,199,.6)',
			levelColor: matchScore >= 94 ? '#C084FC' : '#2BD4C7',
			coverImage: coverImage,
			provider: {
				id: m.provider?.id || 'prov-id',
				name: providerName,
				avatar: identity.avatarUrl,
				initials: providerName.substring(0, 2)
			},
			stages: m.stages || [],
			aiRecommendationReason: recommendationReason,
			aiMatchPercentage: matchScore
		};
	}
}

export const marketplaceAiService = new MarketplaceAiService();
