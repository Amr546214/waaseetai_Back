import { prisma } from '../utils/prisma.client';
import { CreateProposalDto } from '../dtos/create-proposal.dto';
import { AccountType, Prisma, ProposalStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { aiProposalService } from './ai-proposal.service';
import { getIO } from '../socket';
import { WaseetAiError } from './ai/waseet-ai/waseet-ai.errors';
import { logger } from '../config/logger';
import { withKeyLock } from '../utils/key-lock';
import { projectFitService } from './ai-features/project-fit.service';
import { proposalBudgetSuitability, proposalDeadlineSuitability } from './proposal-suitability';
import { clientNotifications, clientNotificationFor, CLIENT_ROUTES } from './client-notifications.service';

export interface GetProviderOffersFiltersDto {
	status?: string;
	clientType?: string;
	search?: string;
	sortBy?: string;
	page?: number;
	limit?: number;
}

import { buildProviderContractView, type ProviderContractView } from '../utils/contract-terms';
import { requireCurrency, assertSameCurrency, LEGACY_CURRENCY, formatMoney } from '../utils/currency';

export type ProviderOfferStatusKey = 'pending' | 'pending_response' | 'pending_signature' | 'nego' | 'accepted' | 'rejected';

export interface ProviderOfferItemDto {
	offerId: string;
	id: string;
	/** The real project id (an offer id is NOT a project id): lets the provider's pages open the conversation of THIS project. */
	projectId: string;
	projectRef: string;
	ref: string;
	projectTitle: string;
	title: string;
	offeredPrice: number;
	price: string;
	currency: string;
	status: string;
	statusKey: ProviderOfferStatusKey;
	statusText: string;
	clientName: string;
	clientType: 'COMPANY' | 'INDIVIDUAL';
	createdAt: string;
	deliveryTime: string;
	duration: string;
	phases: string;
	actionRequired: boolean;
	actionText: string;
	/** The provider may withdraw this offer right now (SUBMITTED / PENDING / UNDER_NEGOTIATION); the action itself re-checks on the server. */
	canWithdraw: boolean;
	/** The real contract (price, duration, phases, saved milestones, escrow) — only when the provider can sign it right now, otherwise null. */
	contract: ProviderContractView | null;
}

export interface ProviderOfferCountsDto {
	all: number;
	pending: number;
	nego: number;
	accepted: number;
	rejected: number;
}

export interface GetProviderOffersResponseDto {
	total: number;
	page: number;
	aiBannerText: string;
	counts: ProviderOfferCountsDto;
	data: ProviderOfferItemDto[];
}

export type ProjectProposalWithDetails = Prisma.ProjectProposalGetPayload<{
	include: {
		project: {
			include: {
				contract: true;
				escrow: true;
				client: {
					select: {
						id: true;
						firstName: true;
						lastName: true;
						accountType: true;
						avatarUrl: true;
					};
				};
			};
		};
		milestones: true;
	};
}>;

export const PROPOSAL_ALREADY_SUBMITTED_MESSAGE = 'عرضك على هذا المشروع وصلنا من قبل، ولا يمكن إرسال أكثر من عرض واحد لنفس المشروع. افتح «عروضي» لمتابعته.';

export class ProposalService {
	/**
	 * Transactionally creates a ProjectProposal along with its associated ProposalMilestones.
	 * Performs duplicate checks and computes preliminary AI match evaluations.
	 */
	/**
	 * One provider + one project at a time (per-key lock, in-process: the backend is ONE Node process): two taps / two tabs / a retry after a lost answer
	 * queue up, and the second finds the first one's offer and answers 409 PROPOSAL_ALREADY_SUBMITTED instead of racing it through the slow AI step.
	 * The database unique (projectId, providerId) stays the last line of defence (also across instances).
	 */
	public async createProposal(projectId: string, providerId: string, data: CreateProposalDto) {
		return withKeyLock(`proposal:${projectId}:${providerId}`, () => this.createProposalLocked(projectId, providerId, data));
	}

	private async createProposalLocked(projectId: string, providerId: string, data: CreateProposalDto) {
		// 1. Verify target project or clientRequest exists and is eligible for proposals
		let project = await prisma.project.findUnique({
			where: { id: projectId }
		});

		let clientRequest = await prisma.clientRequest.findUnique({
			where: { id: projectId },
			include: { clientProfile: true }
		});

		if (!project && !clientRequest) {
			throw new AppError('المشروع المحدد غير موجود في النظام', 404, undefined, 'PROJECT_NOT_FOUND');
		}

		const targetClientId = project?.clientId || clientRequest?.clientProfile?.userId;
		const targetTitle = project?.title || clientRequest?.title || 'طلب مشروع';

		if (!targetClientId) {
			throw new AppError('تعذر العثور على طالب الخدمة لهذا المشروع', 400, undefined, 'PROJECT_OWNER_NOT_FOUND');
		}

		if (!project && clientRequest) {
			// Auto-create mirrored Project entry to satisfy ProjectProposal foreign key constraint
			try {
				project = await prisma.project.create({
					data: {
						id: clientRequest.id,
						currency: clientRequest.currency,
						title: clientRequest.title,
						description: clientRequest.description,
						specialty: 'عام',
						subSpecialties: clientRequest.subSpecialties,
						deliveryDays: clientRequest.expectedDurationDays || 14,
						budgetType: String(clientRequest.budgetType).toLowerCase(),
						budgetMin: clientRequest.minBudget,
						budgetMax: clientRequest.maxBudget,
						budgetFixed: clientRequest.minBudget,
						attachments: clientRequest.attachments,
						requirements: clientRequest.requiredSkills,
						status: 'OPEN',
						clientId: targetClientId
					}
				});
			} catch (err) {
				project = await prisma.project.findUnique({ where: { id: projectId } });
			}
		}

		// Phase 4 — offers are only accepted while the request is genuinely open
		// for bidding. IN_PROGRESS used to be accepted too, but in this lifecycle
		// IN_PROGRESS means "both parties signed, escrow funded" (provider
		// signContract / marketplace checkout) — letting new offers land on an
		// already-contracted project (reachable by direct API call even though
		// explore-requests only lists OPEN) re-opened comparison on a running
		// project. Both mirrored records must agree the request is OPEN.
		// ('PUBLISHED'/'UNDER_BIDDING' are not values of either status enum and
		// were dead branches.)
		if (project && project.status !== 'OPEN') {
			throw new AppError('هذا المشروع غير متاح حالياً لاستقبال عروض جديدة', 422, undefined, 'PROJECT_NOT_OPEN');
		}
		if (clientRequest && clientRequest.status !== 'OPEN') {
			throw new AppError('هذا المشروع غير متاح حالياً لاستقبال عروض جديدة', 422, undefined, 'PROJECT_NOT_OPEN');
		}
		if (targetClientId === providerId && process.env.NODE_ENV === 'production') {
			throw new AppError('لا يمكنك تقديم عرض على طلبك الخاص', 403, undefined, 'OWN_PROJECT_OFFER');
		}

		// 2. Check duplicate submission constraint across both ProjectProposal and Proposal tables
		const [existingProjectProposal, existingProposal] = await Promise.all([
			prisma.projectProposal.findUnique({
				where: {
					projectId_providerId: {
						projectId,
						providerId
					}
				}
			}),
			prisma.proposal.findFirst({
				where: {
					providerId,
					OR: [
						{ projectId },
						{ clientRequestId: projectId }
					]
				}
			})
		]);

		if (existingProjectProposal || existingProposal) {
			throw new AppError(PROPOSAL_ALREADY_SUBMITTED_MESSAGE, 409, undefined, 'PROPOSAL_ALREADY_SUBMITTED');
		}

		// 3. Defensive check: verify milestone percentages sum to exactly 100%
		const totalPct = data.milestones.reduce((sum, m) => sum + m.percentage, 0);
		if (Math.abs(totalPct - 100) > 0.01) {
			throw new AppError(`إجمالي نسب دفعات المراحل يجب أن يساوي 100% (المجموع الحالي: ${totalPct}%)`, 400, [{ field: 'milestones', path: 'milestones', message: `إجمالي نسب دفعات المراحل يجب أن يساوي 100% (المجموع الحالي: ${totalPct}%)` }], 'MILESTONES_PERCENT_SUM');
		}

		// 4. Run instant AI Quality & Match Evaluation before creation.
		// Proposal submission is a real business action and must not depend on
		// the AI service's availability — a provider/model failure here is logged
		// (sanitized) and the submission proceeds with honest null AI fields,
		// never a fabricated score/tag/feedback.
		let aiMatchScore: number | null = null;
		let aiQualityTag: string | null = null;
		let aiPriceTag: string | null = null;
		let aiFeedback: Prisma.InputJsonValue | Prisma.NullTypes.DbNull = Prisma.DbNull;
		const [qualityResult, fitResult] = await Promise.allSettled([
			aiProposalService.evaluate({
					projectId,
					title: data.title,
					message: data.message,
					totalPrice: data.totalPrice,
					deliveryDays: data.deliveryDays,
					milestones: data.milestones?.length
						? data.milestones.map(m => ({
							stepOrder: m.stepOrder,
							title: m.title,
							description: m.description,
							days: m.days,
							percentage: m.percentage,
							amount: m.amount
						}))
						: undefined
				}),
			projectFitService.analyze(providerId, projectId, {
				title: data.title, message: data.message, outputs: data.outputs, advantages: data.advantages,
				milestones: data.milestones.map(m => ({ title: m.title, description: m.description })),
			}),
		]);
		const feedback: Record<string, unknown> = {};
		if (qualityResult.status === 'fulfilled') {
			const aiEvaluation = qualityResult.value;
			// This legacy column holds the real proposal-text quality score only;
			// never manufacture project fit by mixing price-midpoint closeness into it.
			aiMatchScore = aiEvaluation.qualityScore;
			aiQualityTag = aiEvaluation.qualityTag;
			Object.assign(feedback, { source: 'WASEET_AI', qualityScore: aiEvaluation.qualityScore, summary: aiEvaluation.summary });
		} else {
			const error = qualityResult.reason;
			const code = error instanceof WaseetAiError ? error.code : 'APPLICATION_VALIDATION_ERROR';
			logger.warn(`[ProposalService] AI evaluation unavailable for proposal on project ${projectId}: ${code}`);
		}
		if (fitResult.status === 'fulfilled' && fitResult.value.generationSource === 'LLM' && fitResult.value.analysis) {
			feedback.providerFit = {
				source: 'LLM', ...fitResult.value.analysis,
				inputsUsed: fitResult.value.inputsUsed, unavailableFields: fitResult.value.unavailableFields,
				generatedAt: new Date().toISOString(),
			};
		} else if (fitResult.status === 'rejected') {
			logger.warn(`[ProposalService] grounded provider/project fit unavailable for project ${projectId}`);
		}
		if (Object.keys(feedback).length) {
			feedback.budgetSuitability = proposalBudgetSuitability(data.totalPrice, clientRequest?.minBudget ?? project?.budgetMin ?? project?.budgetFixed, clientRequest?.maxBudget ?? project?.budgetMax, clientRequest?.budgetType ?? project?.budgetType);
			feedback.deadlineSuitability = proposalDeadlineSuitability(data.deliveryDays, clientRequest?.expectedDurationDays ?? project?.deliveryDays);
			aiFeedback = feedback as Prisma.InputJsonValue;
		}

		// 5. Transactional execution saving ProjectProposal & ProposalMilestone entries
		let offerNotificationId: string | null = null;
		// an offer is in the currency of the request / project it answers; there is no cross-currency offer in phase 1
		const offerCurrency = requireCurrency(clientRequest?.currency ?? project?.currency ?? LEGACY_CURRENCY, 'عملة الطلب');
		if (project && clientRequest) assertSameCurrency(project.currency, clientRequest.currency, 'العرض');
		const newProposal = await prisma.$transaction(async (tx) => {
			const created = await tx.projectProposal.create({
				data: {
					projectId,
					providerId,
					currency: offerCurrency,
					title: data.title,
					message: data.message,
					advantages: data.advantages || [],
					outputs: data.outputs || '',
					portfolioIds: data.portfolioIds || [],
					totalPrice: data.totalPrice,
					deliveryDays: data.deliveryDays,
					status: ProposalStatus.SUBMITTED,
					aiMatchScore: aiMatchScore,
					aiQualityTag: aiQualityTag,
					aiPriceTag: aiPriceTag,
					aiFeedback: aiFeedback,
					agreedToTerms: data.agreedToTerms,
					agreedToEscrow: data.agreedToEscrow,
					milestones: {
						create: data.milestones.map(m => ({
							stepOrder: m.stepOrder,
							title: m.title,
							description: m.description,
							days: m.days,
							percentage: m.percentage,
							amount: m.amount,
							currency: offerCurrency
						}))
					}
				},
				include: {
					milestones: true,
					provider: {
						select: {
							id: true,
							firstName: true,
							lastName: true,
							avatarUrl: true,
							providerProfile: {
								select: {
									rating: true,
									companyName: true,
									headline: true
								}
							}
						}
					}
				}
			});

			// Also create mirrored Proposal entry for legacy compatibility if clientRequest exists
			if (clientRequest) {
				await tx.proposal.create({
					data: {
						clientRequestId: clientRequest.id,
						projectId: project?.id,
						providerId,
						currency: offerCurrency,
						price: data.totalPrice,
						deliveryDays: data.deliveryDays,
						coverLetter: data.message,
						workPlan: data.outputs || '',
						aiMatchScore: aiMatchScore,
						aiPriceTag: aiPriceTag,
						status: ProposalStatus.SUBMITTED
					}
				});

				await tx.clientRequest.update({
					where: { id: clientRequest.id },
					data: { proposalsCount: { increment: 1 } }
				});
			}

			// 6. Update Project proposal counter
			if (project) {
				await tx.project.update({
					where: { id: project.id },
					data: { proposalsCount: { increment: 1 } }
				});
			}

			// 7. Create in-app notification for Project Owner (Client)
			const providerName = created.provider?.providerProfile?.companyName ||
				`${created.provider?.firstName || ''} ${created.provider?.lastName || ''}`.trim() ||
				'مقدم خدمة';

			const offerNotification = await tx.notification.create({
				data: clientNotificationFor.offerReceived({ clientId: targetClientId, requestId: projectId, offerId: created.id, requestTitle: targetTitle, providerName })
			});
			offerNotificationId = offerNotification.id;

			return created;
		}).catch((error: unknown) => {
			// the unique (projectId, providerId) fired: another request (another instance) saved the offer first - the same answer as the early check
			if ((error as { code?: string } | null)?.code === 'P2002') throw new AppError(PROPOSAL_ALREADY_SUBMITTED_MESSAGE, 409, undefined, 'PROPOSAL_ALREADY_SUBMITTED');
			throw error;
		});

		// the stored notification goes through the client's saved channels (in-app push / e-mail) once the offer is committed
		await clientNotifications.deliverStored([offerNotificationId]);

		// 8. Emit real-time WebSocket event to Project Owner outside transaction scope
		try {
			const io = getIO();
			if (io) {
				const payload = {
					proposalId: newProposal.id,
					projectId: projectId,
					projectTitle: targetTitle,
					providerId: newProposal.providerId,
					providerName: newProposal.provider?.providerProfile?.companyName ||
						`${newProposal.provider?.firstName || ''} ${newProposal.provider?.lastName || ''}`.trim() ||
						'مقدم خدمة',
					totalPrice: newProposal.totalPrice,
					deliveryDays: newProposal.deliveryDays,
					aiMatchScore: newProposal.aiMatchScore,
					createdAt: newProposal.createdAt
				};

				io.to(`project_owner_${targetClientId}`).emit('new_proposal_submitted', payload);
				console.log(`[ProposalService] Real-time proposal notification emitted to owner: ${targetClientId}`);
			}
		} catch (err) {
			console.error('[ProposalService] Error emitting real-time socket notification:', err);
		}

		return newProposal;
	}

	/**
	 * Generates a dynamic, encouraging, and actionable status update string in Arabic (max 20 words)
	 * for the Waseet AI Assistant banner in Provider's Offers Tracking Dashboard.
	 */
	public generateAiBannerText(totalOffers: number, pendingCount: number, negotiatingCount: number, acceptedCount: number): string {
		if (totalOffers === 0) {
			return 'وسيط AI: لم تقم بإرسال أي عروض بعد؛ استكشف المشاريع المتاحة وابدأ بتقديم عروضك الاحترافية الآن!';
		}
		if (negotiatingCount > 0) {
			return `وسيط AI: لديك ${negotiatingCount} عرض قيد التفاوض الآن! راجع ردود واستفسارات العملاء فوراً لزيادة فرص إغلاق الصفقة.`;
		}
		if (acceptedCount > 0) {
			return `وسيط AI: تهانينا! تم قبول ${acceptedCount} من عروضك؛ بادر بالتواصل مع العملاء لإتمام التعاقد والبدء بالتنفيذ مباشرة.`;
		}
		return `وسيط AI: لديك ${pendingCount} عروض بانتظار مراجعة العملاء؛ الصبر مفتاح العقد، وتأكد من الجاهزية للرد الفوري على الاستفسارات.`;
	}

	/**
	 * Transforms database ProjectProposal entity into standardized response DTO.
	 */
	private processProposalItem(item: ProjectProposalWithDetails): ProviderOfferItemDto {
		const proj = item.project;
		const client = proj?.client;
		const isComp = client?.accountType?.includes('COMPANY') ?? false;
		const clientType: 'COMPANY' | 'INDIVIDUAL' = isComp ? 'COMPANY' : 'INDIVIDUAL';
		const clientName = client ? `${client.firstName || 'عميل'} ${client.lastName || 'وسيط'}`.trim() : 'عميل وسيط';

		const rawStatus = item.status;
		let statusEnum = 'PENDING_RESPONSE';
		let statusKey: ProviderOfferStatusKey = 'pending_response';
		let statusText = 'بانتظار الرد';
		let actionRequired = false;
		let actionText = 'فتح العرض';
		let contractView: ProviderContractView | null = null;

		if (rawStatus === ProposalStatus.UNDER_NEGOTIATION) {
			statusEnum = 'UNDER_NEGOTIATION';
			statusKey = 'nego';
			statusText = 'تفاوض جارٍ';
			actionRequired = true;
			actionText = 'متابعة التفاوض';
		} else if (rawStatus === ProposalStatus.PENDING_SIGNATURE) {
			const providerCanSign = proj?.contract?.status === 'PENDING_PROVIDER_SIGNATURE' && proj?.escrow?.status === 'HELD';
			statusEnum = providerCanSign ? 'PENDING_SIGNATURE' : 'PENDING_CLIENT_SIGNATURE';
			statusKey = providerCanSign ? 'pending_signature' : 'pending_response';
			statusText = providerCanSign ? 'قُبل — توقيعك مطلوب' : 'اختارك العميل — يستكمل التوقيع والضمان';
			actionRequired = providerCanSign;
			actionText = providerCanSign ? 'مراجعة وتوقيع العقد' : 'بانتظار العميل';
			if (providerCanSign && proj?.contract) contractView = buildProviderContractView(proj.contract, proj.escrow);
		} else if (rawStatus === ProposalStatus.ACCEPTED) {
			statusEnum = 'ACCEPTED';
			statusKey = 'accepted';
			statusText = 'تم التعاقد';
			actionRequired = false;
			actionText = 'فتح المشروع';
		} else if (rawStatus === ProposalStatus.REJECTED || rawStatus === ProposalStatus.CANCELLED) {
			// CANCELLED (withdrawn / cancelled) is shown as such, never as "rejected"; both still count under the "rejected" filter.
			const cancelled = rawStatus === ProposalStatus.CANCELLED;
			statusEnum = cancelled ? 'CANCELLED' : 'REJECTED';
			statusKey = 'rejected';
			statusText = cancelled ? 'ملغي' : 'مرفوض';
			actionRequired = false;
			actionText = 'عرض التفاصيل';
		}

		const priceVal = item.totalPrice || 0;
		const projectIdStr = proj?.id || item.projectId;
		const projectRef = `#ORD-${projectIdStr.substring(0, 8).toUpperCase()}`;
		const projectTitle = proj?.title || item.title || 'مشروع وسيط';

		return {
			offerId: item.id,
			id: item.id,
			projectId: projectIdStr,
			projectRef,
			ref: projectRef,
			projectTitle,
			title: projectTitle,
			offeredPrice: priceVal,
			price: formatMoney(priceVal, item.currency),
			currency: item.currency ?? LEGACY_CURRENCY, // the offer's own currency
			status: statusEnum,
			statusKey,
			statusText,
			clientName,
			clientType,
			createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : String(item.createdAt),
			deliveryTime: `${item.deliveryDays || 14} يوم`,
			duration: `${item.deliveryDays || 14} يوم`,
			phases: `${item.milestones?.length || 1} مراحل`,
			actionRequired,
			actionText,
			canWithdraw: rawStatus === ProposalStatus.PENDING || rawStatus === ProposalStatus.SUBMITTED || rawStatus === ProposalStatus.UNDER_NEGOTIATION,
			contract: contractView
		};
	}

	/**
	 * Fetches, sorts, filters, and paginates all offers submitted by a specific Provider using database-level queries.
	 */
	public async getProviderOffers(
		providerId: string,
		filters: GetProviderOffersFiltersDto
	): Promise<GetProviderOffersResponseDto> {
		const page = filters.page && filters.page > 0 ? Number(filters.page) : 1;
		const limit = filters.limit && filters.limit > 0 ? Number(filters.limit) : 50;

		// 1. Build Prisma filter conditions
		const whereClause: Prisma.ProjectProposalWhereInput = {
			providerId
		};

		// Status filter
		if (filters.status && filters.status.toLowerCase() !== 'all') {
			const st = filters.status.toLowerCase();
			if (st === 'pending' || st === 'pending_response' || st === 'submitted' || st === 'draft') {
				whereClause.status = {
					in: [
						ProposalStatus.PENDING,
						ProposalStatus.SUBMITTED,
						ProposalStatus.DRAFT,
						ProposalStatus.PENDING_SIGNATURE,
						ProposalStatus.IN_AI_REVIEW
					]
				};
			} else if (st === 'nego' || st === 'negotiability' || st === 'under_negotiation' || st === 'negotiating') {
				whereClause.status = ProposalStatus.UNDER_NEGOTIATION;
			} else if (st === 'accepted') {
				whereClause.status = ProposalStatus.ACCEPTED;
			} else if (st === 'rejected' || st === 'cancelled') {
				whereClause.status = {
					in: [ProposalStatus.REJECTED, ProposalStatus.CANCELLED]
				};
			}
		}

		// Client Type filter
		if (filters.clientType && filters.clientType.toLowerCase() !== 'all') {
			const isCompany = filters.clientType.toUpperCase() === 'COMPANY';
			whereClause.project = {
				client: {
					accountType: isCompany
						? { in: [AccountType.CLIENT_COMPANY, AccountType.PROVIDER_COMPANY] }
						: { in: [AccountType.CLIENT_INDIVIDUAL, AccountType.PROVIDER_INDIVIDUAL] }
				}
			};
		}

		// Search filter
		if (filters.search && filters.search.trim()) {
			const searchTerm = filters.search.trim();
			const cleanRefTerm = searchTerm.replace(/^#?ORD-?/i, '');

			const searchConditions: Prisma.ProjectProposalWhereInput[] = [
				{ title: { contains: searchTerm, mode: 'insensitive' } },
				{ project: { title: { contains: searchTerm, mode: 'insensitive' } } },
				{ project: { client: { firstName: { contains: searchTerm, mode: 'insensitive' } } } },
				{ project: { client: { lastName: { contains: searchTerm, mode: 'insensitive' } } } }
			];

			if (cleanRefTerm) {
				searchConditions.push({ project: { id: { contains: cleanRefTerm, mode: 'insensitive' } } });
			}

			whereClause.AND = [
				{
					OR: searchConditions
				}
			];
		}

		// 2. Build sorting criteria
		let orderBy: Prisma.ProjectProposalOrderByWithRelationInput = { createdAt: 'desc' };
		if (filters.sortBy === 'price_desc' || filters.sortBy === 'price' || filters.sortBy === 'PRICE') {
			orderBy = { totalPrice: 'desc' };
		} else if (filters.sortBy === 'oldest' || filters.sortBy === 'waiting' || filters.sortBy === 'OLDEST') {
			orderBy = { createdAt: 'asc' };
		} else {
			orderBy = { createdAt: 'desc' };
		}

		// 3. Concurrently execute summary counts, filtered count, and paginated data queries
		const [statusGroups, totalFiltered, proposals] = await Promise.all([
			prisma.projectProposal.groupBy({
				by: ['status'],
				where: { providerId },
				_count: { _all: true }
			}),
			prisma.projectProposal.count({
				where: whereClause
			}),
			prisma.projectProposal.findMany({
				where: whereClause,
				include: {
					project: {
						include: {
							contract: true,
							escrow: true,
							client: {
								select: {
									id: true,
									firstName: true,
									lastName: true,
									accountType: true,
									avatarUrl: true
								}
							}
						}
					},
					milestones: true
				},
				orderBy,
				skip: (page - 1) * limit,
				take: limit
			})
		]);

		// 4. Calculate summary statistics from database groupBy results
		let totalOffers = 0;
		let pendingCount = 0;
		let negotiatingCount = 0;
		let acceptedCount = 0;
		let rejectedCount = 0;

		for (const group of statusGroups) {
			const count = group._count._all;
			totalOffers += count;
			switch (group.status) {
				case ProposalStatus.UNDER_NEGOTIATION:
					negotiatingCount += count;
					break;
				case ProposalStatus.ACCEPTED:
					acceptedCount += count;
					break;
				case ProposalStatus.REJECTED:
				case ProposalStatus.CANCELLED:
					rejectedCount += count;
					break;
				case ProposalStatus.PENDING:
				case ProposalStatus.SUBMITTED:
				case ProposalStatus.DRAFT:
				case ProposalStatus.PENDING_SIGNATURE:
				case ProposalStatus.IN_AI_REVIEW:
				default:
					pendingCount += count;
					break;
			}
		}

		const aiBannerText = this.generateAiBannerText(totalOffers, pendingCount, negotiatingCount, acceptedCount);
		const paginatedData: ProviderOfferItemDto[] = proposals.map(p => this.processProposalItem(p));

		return {
			total: totalFiltered,
			page,
			aiBannerText,
			counts: {
				all: totalOffers,
				pending: pendingCount,
				nego: negotiatingCount,
				accepted: acceptedCount,
				rejected: rejectedCount
			},
			data: paginatedData
		};
	}

	/**
	 * One offer of this provider, in exactly the item shape of GET /provider/offers (same mapper).
	 * Someone else's offer is reported as 404, never 403, so ids cannot be probed.
	 */
	public async getProviderOfferById(providerId: string, offerId: string): Promise<ProviderOfferItemDto> {
		const proposal = await prisma.projectProposal.findFirst({
			where: { id: offerId, providerId },
			include: {
				project: {
					include: {
						contract: true,
						escrow: true,
						client: { select: { id: true, firstName: true, lastName: true, accountType: true, avatarUrl: true } }
					}
				},
				milestones: true
			}
		});
		if (!proposal) throw new AppError('العرض غير موجود', 404);
		return this.processProposalItem(proposal);
	}
}

export const proposalService = new ProposalService();
export default proposalService;
