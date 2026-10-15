import { PUBLIC_SERVICE_REVIEWS_RELATION, publicServiceReviewsWhere } from './review-visibility';
import { AccountType, Prisma } from '@prisma/client';
import { businessModelAuditResult } from './ai-features/business-model-audit-result';
import { sanitizeText } from '../utils/sanitize-text';
import { MARKET_VISIBLE_WHERE, MARKET_ELIGIBILITY_SELECT_PROVIDER, marketBlockReasons, marketBlockMessage } from '../utils/market-visibility';
import { prisma } from '../config/db';
import { marketplaceAiService } from './marketplace-ai.service';
import { aiAuditService } from './ai-audit.service';
import { ensureCloudinaryUrl } from '../utils/cloudinary-storage';
import { resolveProviderDisplayIdentity } from '../utils/provider-display';
import { resolveProviderProgression } from '../utils/role-display-resolver';
import { LEVEL_MATRIX } from '../utils/progression-calculators';
import { findActiveServicePurchases } from '../utils/active-purchase.util';
import { assertSkillsInCategory, listProviderSpecialtiesWithCatalog } from './skills-catalog.service';
import { AppError } from '../utils/app-error';
import { selfNegotiationError } from '../utils/self-dealing';

// Batch 4 — the minimal shape getMarketplaceModels/getMarketplaceModelById
// need from req.user to read back the requesting Client's own
// active-purchase eligibility. Deliberately narrower than the full
// Express.Request['user'] type so tests can pass a plain literal.
export interface RequestingUser {
	id: string;
	accountType: AccountType;
}

const CLIENT_ACCOUNT_TYPES: AccountType[] = [AccountType.CLIENT_INDIVIDUAL, AccountType.CLIENT_COMPANY];

// Phase 3E.1: the exact Prisma select shape shared by getMarketplaceModels
// and getMarketplaceModelById for a service's provider — includes
// ProviderProfile's own display columns (Phase 3A/3D.1 source of truth) and
// ProviderGamification's persisted currentLevelIndex (Phase 3D.3A source of
// truth), alongside the legacy User columns kept only as an explicit
// fallback. This is a single JOIN nested in the same serviceCatalog query
// both callers already run — no extra query per row.
const marketplaceProviderSelect = {
	id: true,
	firstName: true,
	lastName: true,
	avatarUrl: true,
	email: true,
	currentLevel: true,
	providerProfile: { select: { firstName: true, lastName: true, avatarUrl: true, isVerified: true } },
	gamification: { select: { points: true, currentLevelIndex: true } }
} as const;

type MarketplaceProviderRow = {
	id: string;
	firstName: string | null;
	lastName: string | null;
	avatarUrl: string | null;
	email: string | null;
	currentLevel: string | null;
	providerProfile: { firstName: string | null; lastName: string | null; avatarUrl: string | null; isVerified: boolean } | null;
	gamification: { points: number; currentLevelIndex: number } | null;
};

// Free text of a service (title, description, sub-specialty, and every stage's title/description) is stored as plain text: markup is stripped
// before validation and storage, so "<b></b>" is judged as the empty text it really is. Non-string values are left for the validators below.
const cleanText = (value: unknown, max: number): unknown => (typeof value === 'string' ? sanitizeText(value).trim().slice(0, max) : value);
export function sanitizeServiceInput(data: any): any {
	if (!data || typeof data !== 'object') return data;
	return {
		...data,
		title: cleanText(data.title, 150),
		description: cleanText(data.description, 5000),
		subSpecialty: cleanText(data.subSpecialty, 100),
		stages: Array.isArray(data.stages)
			? data.stages.map((stage: any) => (stage && typeof stage === 'object'
				? { ...stage, title: cleanText(stage.title, 150), description: cleanText(stage.description, 2000), desc: cleanText(stage.desc, 2000) }
				: stage))
			: data.stages
	};
}

export class MarketplaceService {
	/**
	 * Phase 3E.1: resolves a marketplace/detail card's provider name/avatar/
	 * level from the canonical Provider-specific sources — ProviderProfile
	 * display columns (User fallback only if null/empty) and
	 * ProviderGamification.currentLevelIndex via the same resolveProviderProgression
	 * helper the rest of the app already uses (Phase 3C/3D.3A) — never a new
	 * formula. `User.currentLevel` is used ONLY as the explicit compatibility
	 * fallback resolveProviderProgression itself falls back to when a
	 * provider genuinely has no ProviderGamification row at all.
	 */
	private resolveProviderCardFields(provider: MarketplaceProviderRow) {
		const identity = resolveProviderDisplayIdentity({
			providerProfile: provider.providerProfile || {},
			user: provider
		});
		const providerName = identity.fullName || (provider.email ? provider.email.split('@')[0] : 'مزود معتمد');
		const level = resolveProviderProgression(provider.gamification, {
			firstName: '',
			lastName: '',
			avatarUrl: null,
			profileCompletionPercent: 0,
			currentLevel: provider.currentLevel || LEVEL_MATRIX[0].title,
			currentPoints: 0,
			pointsToNextLevel: 0
		}).currentLevel;

		return {
			name: providerName,
			avatar: identity.avatarUrl,
			initials: providerName.substring(0, 2),
			level
		};
	}

	/**
	 * Fetches the provider's active skills and portfolio items to populate the creation wizard.
	 */
	async getProviderPreData(userId: string) {
		const providerProfile = await prisma.providerProfile.findUnique({
			where: { userId },
			include: {
				skills: true,
				portfolioItems: true
			}
		});

		if (!providerProfile) {
			throw new Error('Provider profile not found');
		}

		// Each approved specialty carries the catalog skills of its Category (the only skills a service of that specialty may use).
		const specialties = await listProviderSpecialtiesWithCatalog(prisma, userId);

		return {
			skills: providerProfile.skills,
			savedSkills: providerProfile.skills.map(skill => skill.name),
			specialties,
			portfolioItems: providerProfile.portfolioItems
		};
	}

	/**
	 * `skills` omitted = untouched (undefined). Otherwise trimmed, de-duplicated, max 30, and EVERY name must be in the catalog of the specialty's Category
	 * (Batch B T1: a skill the provider merely holds on the profile no longer widens the list; only the names already on THIS service stay valid while its
	 * specialty is unchanged), else a 400 naming the offenders and the field.
	 */
	private async validateServiceSkills(input: unknown, categorySlug: string | null, onService: string[] = []): Promise<string[] | undefined> {
		if (input === undefined || input === null) return undefined;
		if (Array.isArray(input) && input.length === 0) return [];
		try {
			return assertSkillsInCategory(input, categorySlug, onService);
		} catch (error) {
			if (error instanceof AppError) throw new AppError(error.message, error.statusCode, [{ path: 'skills', field: 'skills', message: error.message, code: 'SKILL_NOT_IN_SPECIALTY' }]);
			throw error;
		}
	}

	/**
	 * Batch B T1 (§2/§5): the specialty of a service must be one of the provider's APPROVED + active specialties. Another specialty that is still under
	 * review (or rejected) never blocks an approved one, and never opens early. The error says which case it is.
	 */
	private async resolveApprovedSpecialty(userId: string, specialtyId: unknown) {
		const wanted = typeof specialtyId === 'string' ? specialtyId : '';
		const own = wanted ? await prisma.providerSpecialty.findFirst({
			where: { providerProfile: { userId }, OR: [{ id: wanted }, { specialtyId: wanted }] },
			include: { specialty: { include: { category: { select: { slug: true } } } } }
		}) : null;
		const fail = (message: string, code: string) => new AppError(message, 403, [{ path: 'specialtyId', field: 'specialtyId', message, code }]);
		if (!wanted) throw new AppError('اختر التخصص', 400, [{ path: 'specialtyId', field: 'specialtyId', message: 'اختر التخصص', code: 'required' }]);
		if (!own) throw fail('هذا التخصص غير مضاف إلى حسابك؛ أضفه واجتز اختباره واطلب اعتماده أولاً', 'SPECIALTY_NOT_OWNED');
		const name = own.specialty?.nameAr || own.specialty?.name || 'التخصص';
		if (own.status !== 'APPROVED' || !own.isPassed || !own.isActive) {
			const reason = own.status === 'UNDER_AI_REVIEW' ? `تخصص «${name}» قيد المراجعة؛ يمكنك النشر فيه بعد اعتماده`
				: own.status === 'REJECTED' ? `تخصص «${name}» مرفوض؛ عدّل طلب الاعتماد وأعد إرساله من «إجراءات الحساب»`
				: `تخصص «${name}» غير معتمد بعد؛ أكمل الاختبار وطلب الاعتماد أولاً`;
			throw fail(reason, 'SPECIALTY_NOT_APPROVED');
		}
		return { id: own.specialty.id, categorySlug: own.specialty.category?.slug ?? null };
	}

	/**
	 * The approval model linked to a service: the provider's OWN request, of the SAME specialty, and approved by the admin. `keep` is the sample already
	 * linked (an old service is never broken just because it is edited).
	 */
	private async resolveApprovalModel(userId: string, specialtyId: string, accreditationSampleId: unknown, keep?: string | null) {
		const fail = (message: string, code: string) => new AppError(message, 400, [{ path: 'accreditationSampleId', field: 'accreditationSampleId', message, code }]);
		if (typeof accreditationSampleId !== 'string' || !accreditationSampleId) throw fail('اختر نموذج الاعتماد المعتمد الخاص بهذا التخصص', 'required');
		const sample = await prisma.accreditationSample.findFirst({
			where: { id: accreditationSampleId, providerProfile: { userId }, providerSpecialty: { specialtyId } },
			select: { id: true, status: true }
		});
		if (!sample) throw fail('نموذج الاعتماد المختار لا يخص هذا التخصص أو حسابك', 'MODEL_MISMATCH');
		if (sample.status !== 'AI_VERIFIED' && sample.id !== keep) throw fail('نموذج الاعتماد المختار لم يُعتمد بعد من الإدارة', 'MODEL_NOT_APPROVED');
		return sample;
	}

	/**
	 * Creates a new ServiceCatalog and its related ServiceStages within a Prisma transaction.
	 */
	async createService(userId: string, rawData: any) {
		const data = sanitizeServiceInput(rawData);
		const { title, description, specialtyId, subSpecialty, portfolioItemId, accreditationSampleId, stages, gallery } = data;
		const storedGallery = Array.isArray(gallery) ? (await Promise.all(gallery.map((url: string, index: number) =>
			ensureCloudinaryUrl(url, `waseetai/providers/${userId}/services`, `gallery-${index + 1}`)
		))).filter(Boolean) : undefined;

		// Validation
		if (typeof title !== 'string' || title.trim().length < 3 || typeof description !== 'string' || description.trim().length < 10) {
			throw new Error('Title and description are required.');
		}

		if (!stages || !Array.isArray(stages) || stages.length === 0) {
			throw new Error('At least one service stage is required.');
		}

		const totalPercentage = stages.reduce((sum: number, stage: any) => sum + Number(stage.percentage), 0);
		if (Math.abs(totalPercentage - 100) > 0.01) {
			throw new Error('Stage percentages must sum exactly to 100%.');
		}
		if (stages.some((stage: any) => !stage?.title?.trim() || Number(stage.percentage) <= 0 || Number(stage.deliveryDays || stage.days) <= 0 || Number(stage.computedAmount) < 0)) {
			throw new Error('Each stage requires a title, a positive duration, and a valid percentage.');
		}

		// Validate optional portfolioItemId / accreditationSampleId
		let validPortfolioItemId: string | undefined = undefined;
		if (portfolioItemId && typeof portfolioItemId === 'string') {
			const pItem = await prisma.portfolioItem.findFirst({
				where: { id: portfolioItemId, providerProfile: { userId } }
			});
			if (pItem) {
				validPortfolioItemId = pItem.id;
			}
		}

		// Specialty: only an APPROVED one of this provider; skills: only from its catalog; model: this provider's approved request of the same specialty.
		const approved = await this.resolveApprovedSpecialty(userId, specialtyId);
		const validSkillId = approved.id;
		const validSkills = await this.validateServiceSkills(data.skills, approved.categorySlug);
		const accreditationSample = await this.resolveApprovalModel(userId, validSkillId, accreditationSampleId);

		// Compute derived total fields
		const totalAmount = stages.reduce((sum: number, stage: any) => sum + Number(stage.computedAmount || 0), 0);
		const totalDays = stages.reduce((sum: number, stage: any) => sum + Number(stage.deliveryDays || stage.days || 0), 0);
		if (totalAmount <= 0 || totalDays <= 0) {
			throw new Error('Total amount and delivery duration must be greater than zero.');
		}

		const fullDescription = description;

		// Create Service and Stages inside a transaction
		const createdService = await prisma.$transaction(async (tx: any) => {
			const service = await tx.serviceCatalog.create({
				data: {
					provider: {
						connect: { id: userId }
					},
						title,
						description: fullDescription,
						subSpecialty: typeof subSpecialty === 'string' ? subSpecialty.trim() || null : null,
						...(validSkills && { skills: validSkills }),
						...(validSkillId && { specialty: { connect: { id: validSkillId } } }),
						...(validPortfolioItemId && { portfolioItem: { connect: { id: validPortfolioItemId } } }),
						accreditationSample: { connect: { id: accreditationSample.id } },
					...(storedGallery && { gallery: storedGallery }),
					totalAmount,
					totalDays,
						status: 'PUBLISHED',
						approvedAt: new Date(),
					stages: {
						create: stages.map((stage: any, index: number) => ({
							stepOrder: index + 1,
							title: stage.title,
							description: stage.description || stage.desc,
							deliveryDays: Number(stage.deliveryDays || stage.days || 0),
							percentage: Number(stage.percentage || 0),
							computedAmount: Number(stage.computedAmount || 0)
						}))
					}
				},
				include: {
					stages: true
				}
			});
			return service;
		});

		// BE-2(c): advisory WaseetAI audit in the background — never blocks publish, never changes status; a failure leaves aiScore null.
		void aiAuditService.auditProjectModel(createdService.id);

		return createdService;
	}

	/**
	 * Fetch single service catalog details by ID for editing or detail view
	 */
	async getServiceById(userId: string, serviceId: string) {
		const service = await prisma.serviceCatalog.findFirst({
			where: { id: serviceId, providerId: userId },
			include: {
				specialty: true,
				portfolioItem: true,
				// the admin's internal note is never part of what the provider reads
				accreditationSample: { select: { id: true, title: true, description: true, status: true, attachments: true, providerSpecialtyId: true, createdAt: true } },
				stages: {
					orderBy: { stepOrder: 'asc' }
				}
			}
		});

		if (!service) {
			throw new Error('نموذج العمل المطلوب غير موجود');
		}

		return service;
	}

	/**
	 * Update an existing service catalog and its stages
	 */
	async updateService(userId: string, serviceId: string, rawData: any) {
		const data = sanitizeServiceInput(rawData);
		const { title, description, specialtyId, subSpecialty, portfolioItemId, accreditationSampleId, stages, gallery } = data;
		const storedGallery = Array.isArray(gallery) ? (await Promise.all(gallery.map((url: string, index: number) =>
			ensureCloudinaryUrl(url, `waseetai/providers/${userId}/services/${serviceId}`, `gallery-${index + 1}`)
		))).filter(Boolean) : undefined;

		// Verify ownership
		const existing = await prisma.serviceCatalog.findFirst({
			where: { id: serviceId, providerId: userId }
		});

		if (!existing) {
			throw new Error('نموذج العمل غير موجود');
		}

		if (typeof title !== 'string' || title.trim().length < 3 || typeof description !== 'string' || description.trim().length < 10) {
			throw new Error('Title and description are required.');
		}

		// Batch B T1: editing re-validates everything against the CURRENT state (an edit or a manual API call cannot publish into a specialty that is no
		// longer approved, nor keep skills / a model of another specialty).
		const approved = await this.resolveApprovedSpecialty(userId, specialtyId);
		const validSkillId = approved.id;
		const specialtyChanged = (existing as any).specialtyId !== validSkillId;
		let validSkills = await this.validateServiceSkills(data.skills, approved.categorySlug, specialtyChanged ? [] : ((existing as any).skills ?? []));
		if (validSkills === undefined && specialtyChanged) {
			// skills not sent but the specialty changed: the skills already on the service must belong to the NEW specialty's catalog
			validSkills = await this.validateServiceSkills((existing as any).skills ?? [], approved.categorySlug, []);
		}

		// Resolve optional portfolioItemId
		let validPortfolioItemId: string | undefined = undefined;
		if (portfolioItemId && typeof portfolioItemId === 'string') {
			const pItem = await prisma.portfolioItem.findFirst({
				where: { id: portfolioItemId, providerProfile: { userId } }
			});
			if (pItem) {
				validPortfolioItemId = pItem.id;
			}
		}

		// a changed specialty never keeps the old model: the model is re-validated against the new specialty (and must be sent again)
		const keepSample = specialtyChanged ? null : existing.accreditationSampleId;
		const accreditationSample = await this.resolveApprovalModel(userId, validSkillId, accreditationSampleId || keepSample, keepSample);

		const stageList = Array.isArray(stages) ? stages : [];
		if (stageList.length === 0) throw new Error('At least one service stage is required.');
		const totalPercentage = stageList.reduce((sum: number, stage: any) => sum + Number(stage.percentage), 0);
		if (Math.abs(totalPercentage - 100) > 0.01 || stageList.some((stage: any) => !stage?.title?.trim() || Number(stage.percentage) <= 0 || Number(stage.deliveryDays || stage.days) <= 0 || Number(stage.computedAmount) < 0)) {
			throw new Error('Service stages are invalid or percentages do not sum to 100%.');
		}
		const totalAmount = stageList.reduce((sum: number, stage: any) => sum + Number(stage.computedAmount || 0), 0);
		const totalDays = stageList.reduce((sum: number, stage: any) => sum + Number(stage.deliveryDays || stage.days || 0), 0);
		if (totalAmount <= 0 || totalDays <= 0) throw new Error('Total amount and delivery duration must be greater than zero.');

		const fullDescription = description;

		const updated = await prisma.$transaction(async (tx: any) => {
			// Delete existing stages
			await tx.serviceStage.deleteMany({
				where: { serviceId: serviceId }
			});

			// Update Service Catalog
			const service = await tx.serviceCatalog.update({
				where: { id: serviceId },
				data: {
						title,
						description: fullDescription,
						subSpecialty: typeof subSpecialty === 'string' ? subSpecialty.trim() || null : null,
					...(validSkills && { skills: validSkills }),
					// stale advisory verdict cleared: a failed re-audit must leave null, not the score of the previous content
					aiScore: null,
					aiReviewSummary: null,
					aiReviewDetails: Prisma.DbNull,
					aiAuditScore: null,
					aiAuditFeedback: Prisma.DbNull,
					aiAuditReport: Prisma.DbNull,
					totalAmount: totalAmount > 0 ? totalAmount : existing.totalAmount,
					totalDays: totalDays > 0 ? totalDays : existing.totalDays,
					...(validSkillId && { specialty: { connect: { id: validSkillId } } }),
						...(validPortfolioItemId && { portfolioItem: { connect: { id: validPortfolioItemId } } }),
						accreditationSample: { connect: { id: accreditationSample.id } },
						...(storedGallery && { gallery: storedGallery }),
						status: 'PUBLISHED',
						approvedAt: existing.approvedAt || new Date(),
					stages: {
						create: stageList.map((stage: any, index: number) => ({
							stepOrder: index + 1,
							title: stage.title,
							description: stage.description || stage.desc,
							deliveryDays: Number(stage.deliveryDays || stage.days || 0),
							percentage: Number(stage.percentage || 0),
							computedAmount: Number(stage.computedAmount || 0)
						}))
					}
				},
				include: {
					stages: true
				}
			});
			return service;
		});

		// The content changed, so any previous verdict no longer describes it: re-audit in the background (advisory only).
		void aiAuditService.auditProjectModel(updated.id);

		return updated;
	}

	/**
	 * Batch B T1: before a service goes (back) live its specialty must still be APPROVED for this provider and its approval model must still be a valid,
	 * approved model of that specialty. Used by every re-publish path (visibility toggle, publish-by-id); nothing is changed here.
	 */
	async assertServicePublishable(userId: string, service: { specialtyId: string | null; accreditationSampleId: string | null }) {
		if (!service.specialtyId) throw new AppError('هذه الخدمة غير مرتبطة بتخصص؛ عدّلها واختر تخصصاً معتمداً', 409, [{ path: 'specialtyId', field: 'specialtyId', message: 'اختر تخصصاً معتمداً', code: 'required' }]);
		await this.resolveApprovedSpecialty(userId, service.specialtyId);
		await this.resolveApprovalModel(userId, service.specialtyId, service.accreditationSampleId, null);
	}

	async setServiceVisibility(userId: string, serviceId: string, visible: boolean) {
		const existing = await prisma.serviceCatalog.findFirst({ where: { id: serviceId, providerId: userId } });
		if (!existing) throw new Error('نموذج العمل غير موجود');
		if (visible && existing.status !== 'ARCHIVED') throw new Error('لا يمكن إظهار نموذج غير مخفي');
		if (visible) await this.assertServicePublishable(userId, existing);
		if (!visible && !['PUBLISHED', 'APPROVED'].includes(existing.status)) throw new Error('لا يمكن إخفاء نموذج غير منشور');
		return prisma.serviceCatalog.update({
			where: { id: existing.id },
			data: { status: visible ? 'PUBLISHED' : 'ARCHIVED' }
		});
	}

	// Final AI cleanup batch: getCenterData() (backing the GET /center route)
	// fabricated a fake aiAnalysis feed, a hardcoded aiScore/aiClarityScore/
	// aiFeasibilityScore fallback (85/88/85) regardless of the real value, and
	// a hardcoded `rating: 4.8` on every service — with zero frontend caller
	// (the real "مركز النماذج" page, center.ts, reads real accreditation
	// sample data instead; the frontend's own getCenterData() wrapper had no
	// callers anywhere). Removed entirely along with its controller/route/
	// frontend wrapper.

	/**
	 * Fetches published models strictly for the Marketplace with filtering & pagination
	 */
	async getMarketplaceModels(query: any, requestingUser?: RequestingUser) {
		const { category, cat, specialization, sub, specialtyId, search, featuredOnly, sort, page = 1, limit = 20,
			minPrice, maxPrice, minRating, maxDays, level, skill } = query || {};
		const activeCat = category || cat;
		const activeSub = specialization || sub || specialtyId;

		const whereClause: any = {
			...MARKET_VISIBLE_WHERE
		};

		if (search && typeof search === 'string' && search.trim() !== '') {
			whereClause.OR = [
				{ title: { contains: search, mode: 'insensitive' } },
				{ description: { contains: search, mode: 'insensitive' } }
			];
		}

		if (activeCat && activeCat !== 'all' && typeof activeCat === 'string') {
			const isUuid = /^[0-9a-fA-F-]{36}$/.test(activeCat);
			whereClause.specialty = { ...whereClause.specialty, category: isUuid ? { id: activeCat } : { slug: activeCat } };
		}

		if (activeSub && activeSub !== 'all' && typeof activeSub === 'string') {
			const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(activeSub);
			if (isUuid) {
				whereClause.specialtyId = activeSub;
			} else {
				whereClause.specialty = {
					...whereClause.specialty,
					slug: activeSub
				};
			}
		}

		// Exact catalog skill name (the service's own `skills` column).
		if (typeof skill === 'string' && skill.trim()) whereClause.skills = { has: skill.trim().replace(/\s+/g, ' ') };

		const parsedMinPrice = Number(minPrice);
		const parsedMaxPrice = Number(maxPrice);
		if (Number.isFinite(parsedMinPrice) || Number.isFinite(parsedMaxPrice)) {
			whereClause.totalAmount = {};
			if (Number.isFinite(parsedMinPrice)) whereClause.totalAmount.gte = Math.max(0, parsedMinPrice);
			if (Number.isFinite(parsedMaxPrice)) whereClause.totalAmount.lte = Math.max(0, parsedMaxPrice);
		}

		const parsedMaxDays = Number(maxDays);
		if (Number.isFinite(parsedMaxDays) && parsedMaxDays > 0) {
			whereClause.totalDays = { lte: parsedMaxDays };
		}

		const parsedMinRating = Number(minRating);
		if (Number.isFinite(parsedMinRating) && parsedMinRating > 0) {
			whereClause.reviews = { some: { rating: { gte: parsedMinRating }, reviewerRole: 'CLIENT', isPublic: true } };
		}

		// Phase 3E.1 Part 4: `level` values are the SAME canonical LEVEL_MATRIX
		// titles resolveProviderCardFields() now returns in every listing/detail
		// response (see below) — never the legacy, never-written User.currentLevel.
		// Requested titles are mapped back to their LEVEL_MATRIX indices and
		// filtered against the persisted ProviderGamification.currentLevelIndex
		// (reliable since Phase 3D.3A/3D.4), entirely inside this single
		// whereClause — both findMany and count() below use the identical
		// whereClause, so pagination/total stay correct with no in-memory
		// post-filtering. A provider with genuinely no ProviderGamification row
		// displays as LEVEL_MATRIX[0] ("زائر") via resolveProviderProgression's
		// own fallback (see resolveProviderCardFields) — so if the lowest level
		// is among the requested titles, providers with no gamification row
		// are included too, to stay consistent with what the display shows.
		if (typeof level === 'string' && level.trim()) {
			const requestedTitles = level.split(',').map((item: string) => item.trim()).filter(Boolean);
			if (requestedTitles.length) {
				// An unrecognized title (matchedIndices stays empty) correctly
				// matches zero providers via `in: []`, same fail-closed behavior
				// the old `currentLevel: { in: levels }` had for any value no
				// provider actually held.
				const matchedIndices = LEVEL_MATRIX.filter(l => requestedTitles.includes(l.title)).map(l => l.index);
				const baseLevelIndex = LEVEL_MATRIX[0].index;
				whereClause.provider = matchedIndices.includes(baseLevelIndex)
					? { OR: [{ gamification: { currentLevelIndex: { in: matchedIndices } } }, { gamification: null }] }
					: { gamification: { currentLevelIndex: { in: matchedIndices } } };
			}
		}

		if (featuredOnly === 'true' || featuredOnly === true) {
			whereClause.isFeatured = true;
			whereClause.discountPercentage = { gt: 0 };
			whereClause.offerEndsAt = { gt: new Date() };
		}

		// Sorting
		let orderBy: any = { createdAt: 'desc' };
		if (sort === 'ai' || sort === 'score') {
			// Batch 5: aiScore is nullable (Int?). A bare `desc` puts NULLs FIRST
			// on PostgreSQL, so unscored models used to lead the "AI" sort.
			// Unscored models now sort last; ties break newest-first, then id.
			orderBy = [{ aiScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }];
		} else if (sort === 'rating') {
			orderBy = [{ reviews: { _count: 'desc' } }, { createdAt: 'desc' }];
		} else if (sort === 'price_asc') {
			orderBy = { totalAmount: 'asc' };
		} else if (sort === 'delivery') {
			orderBy = { totalDays: 'asc' };
		} else if (sort === 'top_rated') {
			orderBy = [{ reviews: { _count: 'desc' } }, { createdAt: 'desc' }];
		} else if (sort === 'views') {
			orderBy = { viewsCount: 'desc' };
		}

		const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
		const pageSize = Math.min(50, Math.max(1, parseInt(limit as string, 10) || 20));

		// "rating" / "top_rated" order by the number of PUBLISHED client reviews. Prisma cannot filter a relation _count in orderBy (it would count unpublished reviews and
		// leak their number through the order), so these two sorts rank the ids in memory from a published-only groupBy and then load just the requested page.
		let rankedPageIds: string[] | null = null;
		if (sort === 'rating' || sort === 'top_rated') {
			const candidates = await prisma.serviceCatalog.findMany({ where: whereClause, select: { id: true, createdAt: true } });
			const counts = await prisma.review.groupBy({ by: ['serviceId'], where: { serviceId: { in: candidates.map((c: any) => c.id) }, reviewerRole: 'CLIENT', isPublic: true }, _count: { _all: true } });
			const countOf = new Map<string, number>(counts.map((g: any) => [g.serviceId as string, g._count._all as number]));
			rankedPageIds = candidates
				.sort((a: any, b: any) => (countOf.get(b.id) ?? 0) - (countOf.get(a.id) ?? 0) || b.createdAt.getTime() - a.createdAt.getTime())
				.slice((pageNum - 1) * pageSize, pageNum * pageSize)
				.map((c: any) => c.id);
		}

		const [loadedModels, totalCount] = await Promise.all([
			prisma.serviceCatalog.findMany({
				where: rankedPageIds ? { AND: [whereClause, { id: { in: rankedPageIds } }] } : whereClause,
				include: {
					provider: {
						select: marketplaceProviderSelect
					},
					specialty: {
						include: { category: true }
					},
					stages: true,
					portfolioItem: true,
					accreditationSample: { select: { attachments: true } },
					reviews: { ...PUBLIC_SERVICE_REVIEWS_RELATION, select: { rating: true } }
				},
				...(rankedPageIds ? {} : { orderBy, skip: (pageNum - 1) * pageSize, take: pageSize })
			}),
			prisma.serviceCatalog.count({ where: whereClause })
		]);
		const dbModels = rankedPageIds ? rankedPageIds.map(id => loadedModels.find((m: any) => m.id === id)).filter((m): m is NonNullable<typeof m> => Boolean(m)) : loadedModels;

		// Batch 4 — ONE batched lookup for every service id on this page, never
		// one request per card (findActiveServicePurchases already accepts an
		// array). Only computed for an authenticated Client — a guest, or any
		// other authenticated role, gets no `eligibility` field at all,
		// identical to the pre-Batch-4 response shape.
		let activeByServiceId = new Map<string, { id: string }>();
		if (requestingUser && CLIENT_ACCOUNT_TYPES.includes(requestingUser.accountType)) {
			const activePurchases = await findActiveServicePurchases(prisma, requestingUser.id, dbModels.map((s: any) => s.id));
			activeByServiceId = new Map(activePurchases.filter(p => p.serviceCatalogId).map(p => [p.serviceCatalogId as string, { id: p.id }]));
		}

		const formattedModels = dbModels.map((s: any) => {
			const providerCard = this.resolveProviderCardFields(s.provider);

			const categoryTitle = s.specialty?.category?.nameAr || 'غير محدد';
			const categorySlug = s.specialty?.category?.slug || 'unknown';

			const skills: string[] = Array.isArray(s.skills) ? s.skills : [];
			let parsedTags: string[] = [...new Set([s.specialty?.nameAr, s.subSpecialty, ...skills].filter((tag): tag is string => Boolean(tag)))];
			const rawTags = (s as any).tags;
			if (typeof rawTags === 'string' && rawTags.trim() !== '') {
				try {
					parsedTags = JSON.parse(rawTags);
				} catch (e) {
					parsedTags = rawTags.split(',').map((t: string) => t.trim());
				}
			} else if (Array.isArray(rawTags) && rawTags.length > 0) {
				parsedTags = rawTags;
			}

			let gallery: string[] = s.gallery ? [...s.gallery] : [];
			if (s.portfolioItem?.coverImage) {
				gallery.push(s.portfolioItem.coverImage);
			}

			if (gallery.length === 0 && Array.isArray(s.accreditationSample?.attachments)) {
				gallery = s.accreditationSample.attachments.filter((url: unknown) => typeof url === 'string' && /(?:^data:image\/|\.(?:png|jpe?g|webp|gif)(?:\?|$))/i.test(url));
			}
			gallery = [...new Set(gallery)];
			const reviewsCount = s.reviews.length;
			const rating = reviewsCount ? Number((s.reviews.reduce((sum: number, review: any) => sum + review.rating, 0) / reviewsCount).toFixed(1)) : 0;

			return {
				id: s.id,
				title: s.title,
				description: s.description,
				category: categoryTitle,
				categorySlug: categorySlug,
				specialtySlug: s.specialty?.slug || '',
				status: s.status,
				totalAmount: Number(s.totalAmount),
				totalDays: s.totalDays,
				aiScore: s.aiScore ?? s.aiAuditScore ?? null,
				aiClarityScore: s.aiClarityScore ?? null,
				aiFeasibilityScore: s.aiFeasibilityScore ?? null,
				aiRecommendationReason: s.aiReviewSummary || '',
				viewsCount: s.viewsCount,
				salesCount: s.salesCount,
				rating,
				reviewsCount,
				isVerified: Boolean(s.provider.providerProfile?.isVerified),
				isFeatured: s.isFeatured && Boolean(s.discountPercentage) && Boolean(s.offerEndsAt && s.offerEndsAt > new Date()),
				discountPercentage: s.discountPercentage,
				offerEndsAt: s.offerEndsAt,
				level: providerCard.level || '',
				levelBg: 'rgba(43,212,199,.6)',
				levelColor: '#2BD4C7',
				provider: {
					id: s.provider.id,
					name: providerCard.name,
					avatar: providerCard.avatar,
					initials: providerCard.initials
				},
				stages: s.stages || [],
				tags: parsedTags,
				skills,
				gallery,
				...(requestingUser && CLIENT_ACCOUNT_TYPES.includes(requestingUser.accountType)
					? { eligibility: { hasActivePurchase: activeByServiceId.has(s.id), activeProjectId: activeByServiceId.get(s.id)?.id ?? null } }
					: {})
			};
		});

		return {
			models: formattedModels,
			total: totalCount,
			page: pageNum,
			totalPages: Math.ceil(totalCount / pageSize)
		};
	}

	/**
	 * Get a single published model by ID
	 */
	async getMarketplaceModelById(id: string, requestingUser?: RequestingUser) {
		const s = await prisma.serviceCatalog.findUnique({
			where: { id },
			include: {
				provider: {
					select: { ...marketplaceProviderSelect, providerProfile: { select: { ...marketplaceProviderSelect.providerProfile.select, ...MARKET_ELIGIBILITY_SELECT_PROVIDER } } }
				},
				specialty: { include: { category: true } },
				stages: true,
				portfolioItem: true,
				accreditationSample: { select: { attachments: true, providerSpecialty: { select: { status: true } } } },
				reviews: {
					// published client reviews only: an unpublished review (and any provider -> client review) never appears on a service page
					where: PUBLIC_SERVICE_REVIEWS_RELATION.where,
					orderBy: { createdAt: 'desc' },
					take: 20,
					include: { client: { select: { firstName: true, lastName: true, avatarUrl: true } } }
				}
			}
		});

		if (!s || !['PUBLISHED', 'APPROVED'].includes(s.status) || marketBlockReasons(s as any).length > 0) {
			throw new Error('الخدمة غير متوفرة أو غير منشورة');
		}

		const providerCard = this.resolveProviderCardFields(s.provider);

		const skills: string[] = Array.isArray(s.skills) ? s.skills : [];
		let parsedTags: string[] = [...new Set([s.specialty?.nameAr, s.subSpecialty, ...skills].filter((tag): tag is string => Boolean(tag)))];
		const rawTags = (s as any).tags;
		if (typeof rawTags === 'string' && rawTags.trim() !== '') {
			try { parsedTags = JSON.parse(rawTags); } catch (e) { parsedTags = rawTags.split(',').map(t => t.trim()); }
		} else if (Array.isArray(rawTags) && rawTags.length > 0) {
			parsedTags = rawTags;
		}

		let gallery: string[] = s.gallery ? [...s.gallery] : [];
		if (s.portfolioItem?.coverImage) {
			gallery.push(s.portfolioItem.coverImage);
		}

		if (gallery.length === 0 && Array.isArray(s.accreditationSample?.attachments)) {
			gallery = s.accreditationSample.attachments.filter((url: unknown) => typeof url === 'string' && /(?:^data:image\/|\.(?:png|jpe?g|webp|gif)(?:\?|$))/i.test(url));
		}
		gallery = [...new Set(gallery)];
		const [reviewStats, updatedViews] = await Promise.all([
			prisma.review.aggregate({ where: publicServiceReviewsWhere(s.id), _count: { _all: true }, _avg: { rating: true } }),
			prisma.serviceCatalog.update({ where: { id: s.id }, data: { viewsCount: { increment: 1 } }, select: { viewsCount: true } })
		]);
		const reviewsCount = reviewStats._count._all;
		const rating = reviewStats._avg.rating ? Number(reviewStats._avg.rating.toFixed(1)) : 0;

		// Batch 4 — single lookup (one service id), acceptable for a detail
		// endpoint per findActiveServicePurchases' own batched contract. Only
		// computed for an authenticated Client, same rule as the listing.
		let eligibility: { hasActivePurchase: boolean; activeProjectId: string | null } | undefined;
		if (requestingUser && CLIENT_ACCOUNT_TYPES.includes(requestingUser.accountType)) {
			const [active] = await findActiveServicePurchases(prisma, requestingUser.id, [s.id]);
			eligibility = { hasActivePurchase: Boolean(active), activeProjectId: active?.id ?? null };
		}

		return {
			id: s.id,
			title: s.title,
			description: s.description,
			category: s.specialty?.category?.nameAr || s.specialty?.nameAr || 'غير محدد',
			categorySlug: s.specialty?.category?.slug || s.specialty?.slug || 'unknown',
			specialtySlug: s.specialty?.slug || '',
			status: s.status,
			totalAmount: Number(s.totalAmount),
			totalDays: s.totalDays,
			aiScore: s.aiScore ?? s.aiAuditScore ?? null,
			aiClarityScore: s.aiClarityScore ?? null,
			aiFeasibilityScore: s.aiFeasibilityScore ?? null,
			aiRecommendationReason: s.aiReviewSummary || '',
			viewsCount: updatedViews.viewsCount,
			salesCount: s.salesCount,
			rating,
			reviewsCount,
			isVerified: Boolean(s.provider.providerProfile?.isVerified),
			isFeatured: s.isFeatured && Boolean(s.discountPercentage) && Boolean(s.offerEndsAt && s.offerEndsAt > new Date()),
			discountPercentage: s.discountPercentage,
			offerEndsAt: s.offerEndsAt,
			level: providerCard.level || '',
			levelBg: 'rgba(43,212,199,.6)',
			levelColor: '#2BD4C7',
			provider: {
				id: s.provider.id,
				name: providerCard.name,
				avatar: providerCard.avatar,
				initials: providerCard.initials
			},
			stages: s.stages || [],
			tags: parsedTags,
			skills,
			gallery,
			// real owner id vs the signed-in user (never profile / activeRole): the page shows «هذه خدمتك» instead of any buy / negotiate action
			isOwnService: Boolean(requestingUser) && s.providerId === requestingUser!.id,
			...(eligibility ? { eligibility } : {}),
			reviews: s.reviews.map(review => ({
				id: review.id,
				rating: review.rating,
				comment: review.comment,
				createdAt: review.createdAt,
				client: review.client ? {
					name: `${review.client.firstName || ''} ${review.client.lastName || ''}`.trim(),
					avatar: review.client.avatarUrl
				} : null
			}))
		};
	}

	/**
	 * AI Match Recommendations for clients / searchers, powered by Gemini with
	 * an honestly-labeled deterministic DB-ranking fallback (see
	 * generationSource — never presented as AI-generated unless Gemini
	 * actually produced it).
	 */
	async getAiRecommendations(body: any) {
		const { query, category, subSpecialty, limit } = body || {};
		const aiResult = await marketplaceAiService.generateAiRecommendations({ query, category, subSpecialty, limit });
		return {
			success: true,
			data: {
				recommendations: aiResult.recommendations,
				matchSummary: aiResult.bannerInsight,
				smartSearchTags: aiResult.smartSearchTags,
				generationSource: aiResult.generationSource
			}
		};
	}

	/**
	 * Fetches all dynamic categories & specialties with real model counts
	 */
	async getMarketplaceCategories() {
		const dbCategories = await prisma.category.findMany({
			where: { isActive: true },
			include: {
				specialties: {
					where: { isActive: true },
					include: {
						_count: {
							select: {
								serviceCatalogs: {
									where: {
										...MARKET_VISIBLE_WHERE
									}
								}
							}
						}
					},
					orderBy: { sortOrder: 'asc' }
				}
			},
			orderBy: { sortOrder: 'asc' }
		});

		let totalModelsCount = 0;

		const categoriesList = dbCategories.map(cat => {
			let catCount = 0;
			const subSpecialties = cat.specialties.map(s => {
				const specCount = s._count.serviceCatalogs;
				catCount += specCount;
				return {
					id: s.id,
					name: s.nameAr,
					slug: s.slug || this.slugifyCategory(s.nameAr),
					count: specCount
				};
			});

			totalModelsCount += catCount;

			return {
				id: cat.id,
				slug: cat.slug || this.slugifyCategory(cat.nameAr),
				name: cat.nameAr,
				nameEn: cat.nameEn,
				count: catCount,
				icon: cat.icon || '#ws-tag',
				subSpecialties
			};
		});

		return {
			success: true,
			data: {
				totalModelsCount: totalModelsCount,
				categories: [
					// { id: 'all', name: 'كل الفئات', count: totalModelsCount, icon: '#ws-tag', subSpecialties: [] },
					...categoriesList
				]
			}
		};
	}

	async getFavorites(userId: string) {
		const favorites = await prisma.marketplaceFavorite.findMany({
			where: { userId, service: { ...MARKET_VISIBLE_WHERE } },
			select: { serviceId: true },
			orderBy: { createdAt: 'desc' }
		});
		return favorites.map(item => item.serviceId);
	}

	async setFavorite(userId: string, serviceId: string, favorite: boolean) {
		const service = await prisma.serviceCatalog.findFirst({ where: { id: serviceId, ...MARKET_VISIBLE_WHERE }, select: { id: true } });
		if (!service) throw new Error('الخدمة غير متوفرة');
		if (favorite) {
			await prisma.marketplaceFavorite.upsert({
				where: { userId_serviceId: { userId, serviceId } },
				update: {},
				create: { userId, serviceId }
			});
		} else {
			await prisma.marketplaceFavorite.deleteMany({ where: { userId, serviceId } });
		}
		return { serviceId, favorite };
	}

	/**
	 * Phase 4 — read-back for duplicate-purchase prevention on the offer page.
	 * Same definition of "active purchase" the checkout gates enforce
	 * (utils/active-purchase.util.ts#findActiveServicePurchases): a contract-backed
	 * project for this service that has not reached a terminal contract state.
	 */
	async getMyPurchaseStatus(userId: string, serviceId: string) {
		const [active] = await findActiveServicePurchases(prisma, userId, [serviceId]);
		return {
			serviceId,
			active: Boolean(active),
			projectId: active?.id || null,
			projectStatus: active?.status || null,
			contractStatus: active?.contract?.status || null
		};
	}

	/**
	 * «طلب تفاوض» on a market service page (the ONE contact action): finds-or-creates the pre-contract negotiation project for (client, provider, service) and
	 * its single room, idempotently. A per-(client, service) transaction advisory lock serialises repeated clicks / concurrent requests, so they all land on the
	 * same project and the same conversation (Conversation is also unique per project + provider). The owner of the service can never open one (real user id).
	 * When the order is later paid, confirmPayment() turns this same project into the real one, so the room and its messages carry over.
	 */
	async requestMarketplaceService(userId: string, serviceId: string, data: any) {
		const service = await prisma.serviceCatalog.findFirst({
			where: { id: serviceId, ...MARKET_VISIBLE_WHERE },
			include: { specialty: true, stages: { orderBy: { stepOrder: 'asc' } } }
		});
		if (!service) throw new AppError('الخدمة غير متوفرة', 404);
		if (service.providerId === userId) throw selfNegotiationError();
		const message = typeof data?.message === 'string' ? data.message.trim().slice(0, 3000) : '';
		const mode = data?.mode === 'negotiation' ? 'negotiation' : 'order';
		return prisma.$transaction(async (tx: any) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`market-negotiation:${userId}:${service.id}`}))`;
			let project = await tx.project.findFirst({
				where: { clientId: userId, providerId: service.providerId, serviceCatalogId: service.id, status: { in: ['OPEN', 'PENDING_REVIEW', 'IN_PROGRESS'] } },
				orderBy: { createdAt: 'desc' }
			});
			let created = false;
			if (!project) {
				project = await tx.project.create({
					data: {
						clientId: userId,
						providerId: service.providerId,
						serviceCatalogId: service.id,
						title: service.title,
						description: message || service.description,
						specialty: service.specialty?.nameAr || service.specialty?.name || 'خدمة عامة',
						subSpecialties: service.subSpecialty ? [service.subSpecialty] : [],
						requirements: service.stages.map((stage: any) => stage.title),
						deliveryDays: service.totalDays,
						budgetType: 'fixed',
						budgetFixed: Number(service.totalAmount),
						allowNegotiation: mode === 'negotiation',
						status: 'OPEN'
					}
				});
				created = true;
			}
			const conversation = await tx.conversation.upsert({
				where: { projectId_providerId: { projectId: project.id, providerId: service.providerId } },
				update: {},
				create: { projectId: project.id, clientId: userId, providerId: service.providerId }
			});
			if (created || message) {
				await tx.message.create({
					data: {
						conversationId: conversation.id,
						senderId: userId,
						type: 'TEXT',
						content: message || `أرغب في طلب خدمة: ${service.title}`
					}
				});
			}
			if (created) await tx.serviceCatalog.update({ where: { id: service.id }, data: { salesCount: { increment: 1 } } });
			return { projectId: project.id, conversationId: conversation.id, providerId: service.providerId, created };
		});
	}

	/**
	 * Dynamic Slug & Category Extractor Utility
	 */
	private slugifyCategory(categoryName: string): string {
		if (!categoryName) return 'general';
		return categoryName
			.trim()
			.toLowerCase()
			.replace(/[\s\-_]+/g, '-')
			.replace(/[^\w\u0600-\u06FF\-]/g, ''); // supports Arabic & English chars
	}

	/**
	 * Fetches ONLY the provider's active and approved models for the "My Market Models" page
	 */
	async getMyMarketModels(userId: string, query: any) {
		const { sort, category = 'all', search } = query || {};

		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, providerProfile: { select: { id: true } } }
		});

		const providerId = user?.id;
		if (!providerId) {
			return {
				success: true,
				data: { models: [], groups: [], filterTabs: [], stats: { totalModels: 0, totalViews: 0 } }
			};
		}

		// 2. بناء شروط البحث
		const whereClause: any = {
				providerId,
				status: { in: ['PUBLISHED', 'APPROVED', 'ARCHIVED'] }
		};

		if (search && typeof search === 'string' && search.trim() !== '') {
			const cleanSearch = search.trim();
			whereClause.AND = [
				{
					OR: [
						{ title: { contains: cleanSearch, mode: 'insensitive' } },
						{ description: { contains: cleanSearch, mode: 'insensitive' } }
					]
				}
			];
		}

		if (category && category !== 'all') {
			whereClause.specialty = {
				OR: [
					{ slug: category },
					{ id: category },
					{ category: { slug: category } }
				]
			};
		}

		// 3. الترتيب
		let orderBy: any = { createdAt: 'desc' };
		if (sort === 'top-rated' || sort === 'score') {
			orderBy = { aiScore: 'desc' };
		} else if (sort === 'views') {
			orderBy = { viewsCount: 'desc' };
		}

		// 4. جلب الخدمات مع العلاقات كاملة بضربة واحدة
		const rawModels = await prisma.serviceCatalog.findMany({
			where: whereClause,
			include: {
				specialty: {
					include: { category: true }
				},
					portfolioItem: true,
					accreditationSample: { include: { providerSpecialty: { select: { status: true } } } },
				provider: {
					include: {
						providerProfile: {
							include: {
								accreditationSamples: {
									include: {
										providerSpecialty: true
									}
								}
							}
						}
					}
				}
			},
			orderBy
		});
		const reviewModels = await prisma.serviceCatalog.findMany({
			where: {
				providerId,
				status: { in: ['PENDING_APPROVAL', 'UNDER_REVIEW', 'REJECTED'] }
			},
			orderBy: { updatedAt: 'desc' }
		});

		// 5. تنسيق البيانات النظيفة (بدون SVG أو HTML)
		let totalViews = 0;
		const groupsMap = new Map<string, { id: string; name: string; count: number; views: number; models: any[] }>();

		const models = rawModels.map(model => {
			const catName = model.specialty?.category?.nameAr || model.specialty?.nameAr || 'خدمات عامة';
			const catSlug = model.specialty?.category?.slug || model.specialty?.slug || 'general';
			const views = model.viewsCount || 0;
			totalViews += views;
			const marketReasons = ['PUBLISHED', 'APPROVED'].includes(model.status) ? marketBlockReasons(model as any) : [];

			// استخراج صورة الغلاف بشكل تسلسلي نظيف
			let coverImage = model.portfolioItem?.coverImage || model.accreditationSample?.attachments?.[0] || null;
			if (!coverImage && model.specialtyId && (model as any).provider?.providerProfile?.accreditationSamples) {
				const matchingSample = (model as any).provider.providerProfile.accreditationSamples.find(
					(s: any) => s.providerSpecialty?.specialtyId === model.specialtyId
				);
				if (matchingSample && matchingSample.attachments && matchingSample.attachments.length > 0) {
					coverImage = matchingSample.attachments[0];
				}
			}

			const formatted = {
				id: model.id,
				title: model.title,
				description: model.description,
				category: catName,
				categorySlug: catSlug,
				specialtyName: model.specialty?.nameAr || '',
				totalAmount: Number(model.totalAmount) || 0,
				viewsCount: views,
				salesCount: model.salesCount || 0,
				offersCount: model.salesCount || 0,
				// a real audit score or null (never 0 as "missing")
				aiScore: model.aiAuditScore ?? model.aiScore ?? null,
				aiAudit: businessModelAuditResult(model),
				rating: 0,
				reviewsCount: 0,
				skills: Array.isArray((model as any).skills) ? (model as any).skills : [],
				tags: [...new Set([model.specialty?.nameAr, model.subSpecialty, ...(((model as any).skills as string[] | undefined) ?? [])].filter((value): value is string => Boolean(value)))],
				coverImage: coverImage,
				// A published service that does not meet the market conditions (KYC verified + specialty approved) is shown to its owner as
				// "under review" with the reason; nothing is stored — it returns by itself once both conditions hold again.
				status: marketReasons.length > 0 ? 'UNDER_REVIEW' : model.status,
				marketVisible: ['PUBLISHED', 'APPROVED'].includes(model.status) ? marketReasons.length === 0 : false,
				marketNotice: marketReasons.length > 0 ? marketBlockMessage(marketReasons) : null,
				createdAt: model.createdAt,
				createdAtFormatted: model.createdAt.toLocaleDateString('ar-SA')
			};

			// تجميع الفئات
			if (!groupsMap.has(catSlug)) {
					groupsMap.set(catSlug, {
					id: catSlug,
					name: catName,
					count: 0,
					views: 0,
					models: []
				});
			}
			const group = groupsMap.get(catSlug)!;
			group.count += 1;
			group.views += views;
			group.models.push(formatted);

			return formatted;
		});

		const groups = Array.from(groupsMap.values());
		const formattedGroups = groups.map(group => ({
			title: group.name,
			slug: group.id,
			count: group.count,
			views: group.views,
			models: group.models
		}));
		const modificationRequests = reviewModels.map(model => {
			const report = model.aiAuditReport && typeof model.aiAuditReport === 'object' ? model.aiAuditReport as any : {};
			const isRejected = model.status === 'REJECTED';
			const strengths = Array.isArray(report.strengths) ? report.strengths : [];
			const gaps = Array.isArray(report.criticalGaps) ? report.criticalGaps : [];
			return {
				id: model.id,
				title: model.title,
				subtitle: isRejected ? 'ملاحظات التدقيق تتطلب تعديل النموذج' : 'النموذج بانتظار اكتمال المراجعة',
				date: model.updatedAt.toLocaleDateString('ar-SA'),
				matchRate: model.aiAuditScore ?? model.aiScore ?? null,
				statusLabel: isRejected ? 'يحتاج تعديل' : 'قيد المراجعة',
				isExpanded: false,
				checks: [
					...strengths.map((text: string) => ({ text, status: 'سليم', type: 'success' as const })),
					...gaps.map((text: string) => ({ text, status: 'يحتاج تعديل', type: 'error' as const }))
				],
				recommendation: model.auditRejectionReason || model.aiReviewSummary || 'بانتظار اكتمال المراجعة.',
				isError: isRejected,
				canApprove: false
			};
		});

		return {
			success: true,
			data: {
				models,
					groups: formattedGroups,
					modificationRequests,
				filterTabs: [
					{ id: 'all', name: 'الكل', count: models.length },
						...formattedGroups.map(g => ({ id: g.slug, name: g.title, count: g.count }))
				],
					stats: {
						totalModels: models.length,
						totalViews: totalViews,
						pendingModifications: modificationRequests.length
				}
			}
		};
	}
}
