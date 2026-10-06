import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { BudgetType, ContractStatus, ProposalStatus, ProviderTypePreference, RequestStatus, UserRole } from '@prisma/client';
import { initializeRoleState } from './account-management.service';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError } from './ai/waseet-ai/waseet-ai.errors';
import { analyzeNewRequest, readAiAnalysis } from './client-request-analysis';
import type { RequestDraftResponse } from './ai/waseet-ai/waseet-ai.types';
import { CreateClientRequestDto, ClientRequestAiSuggestDto } from '../dtos/create-client-request.dto';
import { ensureCloudinaryUrl } from '../utils/cloudinary-storage';
import { resolveProviderProgression } from '../utils/role-display-resolver';
import {
	mailTransporter,
	getOtpEmailTemplate,
	getDepositConfirmationTemplate,
	getProviderContractSignatureTemplate
} from '../utils/mail.transporter';

function generateSlug(text: string): string {
	if (!text) return `slug-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
	const clean = text
		.toString()
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/[^\w\-\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g, '')
		.replace(/\-\-+/g, '-')
		.replace(/^-+/, '')
		.replace(/-+$/, '');
	return clean || `slug-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

// Platform fee constants (percentage of bid amount)
const ESCROW_FEE_VAT = 0.07;       // 7% VAT
const ESCROW_FEE_PLATFORM = 0.05;  // 5% platform commission
const ESCROW_FEE_INSURANCE = 0.01; // 1% dispute insurance

// Shape consumed by the Angular create-request page. Every field except the
// two texts is nullable: a value WaseetAI did not return (or returned in an
// unusable type) is null, never invented or defaulted.
export interface ClientRequestAiSuggestion {
	suggestedTitle: string | null;
	suggestedDescription: string | null;
	suggestedSubSpecialties: string[] | null;
	recommendedMinBudget: number | null;
	recommendedMaxBudget: number | null;
	suggestedDurationDays: number | null;
	complexityRating: string | null;
	personalizedNote: string | null;
	aiMatchScoreEstimate: number | null;
}

// The client wizard works in USD (platform wallet/budgets are USD-canonical).
const CLIENT_REQUEST_AI_CURRENCY = 'USD';

const nonEmptyString = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const positiveNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Maps the verified WaseetAI request-draft response onto the app contract.
 * Field-by-field and honest: unusable values become null (no defaults, no
 * 94-style placeholder score). Returns null when the response carries neither
 * a title nor a description (nothing useful to show).
 */
export function mapRequestDraftToSuggestion(raw: Partial<RequestDraftResponse> | null | undefined): ClientRequestAiSuggestion | null {
	if (!raw || typeof raw !== 'object') return null;

	const subs = Array.isArray(raw.suggestedSubSpecialties)
		? raw.suggestedSubSpecialties.map(nonEmptyString).filter((x): x is string => x !== null)
		: [];

	let min = positiveNumber(raw.recommendedMinBudget);
	let max = positiveNumber(raw.recommendedMaxBudget);
	if (min !== null && max !== null && max < min) { min = null; max = null; }

	const score = typeof raw.aiMatchScoreEstimate === 'number' && Number.isFinite(raw.aiMatchScoreEstimate)
		&& raw.aiMatchScoreEstimate >= 0 && raw.aiMatchScoreEstimate <= 100
		? raw.aiMatchScoreEstimate
		: null;

	const suggestion: ClientRequestAiSuggestion = {
		suggestedTitle: nonEmptyString(raw.suggestedTitle),
		suggestedDescription: nonEmptyString(raw.suggestedDescription),
		suggestedSubSpecialties: subs.length > 0 ? subs : null,
		recommendedMinBudget: min,
		recommendedMaxBudget: max,
		suggestedDurationDays: positiveNumber(raw.suggestedDurationDays),
		complexityRating: nonEmptyString(raw.complexityRating),
		personalizedNote: nonEmptyString(raw.personalizedNote),
		aiMatchScoreEstimate: score
	};

	if (suggestion.suggestedTitle === null && suggestion.suggestedDescription === null) return null;
	return suggestion;
}

export class ClientRequestsService {
	/**
	 * GET /api/client/requests/meta
	 * Returns available categories, specialties, and sub-specialty tags with provider counts.
	 */
	public async getMeta() {
		const categories = await prisma.category.findMany({
			where: { isActive: true },
			orderBy: { sortOrder: 'asc' },
			include: {
				specialties: {
					where: { isActive: true },
					orderBy: { sortOrder: 'asc' },
					include: {
						_count: {
							select: { providerSpecialties: { where: { isActive: true } } }
						}
					}
				}
			}
		});

		const formattedCategories = categories.map(cat => {
			const allSubSpecialties = new Set<string>();
			let totalProviders = 0;

			const specialties = cat.specialties.map(spec => {
				const count = spec._count?.providerSpecialties || 0;
				totalProviders += count;
				return {
					id: spec.id,
					name: spec.nameAr || spec.name || '',
					nameEn: spec.nameEn,
					icon: spec.icon,
					providerCount: count
				};
			});

			return {
				id: cat.id,
				name: cat.nameAr || cat.name || '',
				nameEn: cat.nameEn,
				icon: cat.icon,
				description: cat.description,
				totalProviders,
				specialties
			};
		});

		const totalProvidersSum = formattedCategories.reduce((acc, c) => acc + c.totalProviders, 0);

		return {
			categories: formattedCategories,
			totalCategories: formattedCategories.length,
			totalProviders: totalProvidersSum
		};
	}

	/**
	 * POST /api/client/my-requests/ai-suggest
	 * WaseetAI request-draft (POST /v1/ai/request-draft). Only the verified
	 * request fields {title, description, specialtyName, currency} are sent:
	 * the selected sub-specialties and the client's past-request history have
	 * no field in that contract and are NOT sent.
	 */
	public async generateAiSuggest(_clientId: string, payload: ClientRequestAiSuggestDto): Promise<ClientRequestAiSuggestion> {
		const title = payload.title?.trim() || undefined;
		const description = payload.description?.trim() || undefined;
		const specialtyName = payload.specialtyName?.trim() || undefined;

		const unavailable = () => new AppError('تعذر توليد اقتراح ذكي لطلبك حالياً، يرجى المحاولة لاحقاً.', 503);

		let draft: RequestDraftResponse;
		try {
			draft = await waseetAiClient.requestDraft({ title, description, specialtyName, currency: CLIENT_REQUEST_AI_CURRENCY });
		} catch (error) {
			// Honest failure: code/status only are logged, upstream text is never
			// forwarded, and no fabricated suggestion is returned.
			const e = normalizeWaseetAiError(error);
			console.error(`[ClientRequests] WaseetAI request-draft failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
			throw unavailable();
		}

		const suggestion = mapRequestDraftToSuggestion(draft);
		if (!suggestion) throw unavailable();
		return suggestion;
	}

	/**
	 * POST /api/client/requests
	 * Creates a new ClientRequest record in PostgreSQL
	 */
	public async createRequest(userId: string, dto: CreateClientRequestDto) {
		// 1. Resolve Client Profile
		let clientProfile = await prisma.clientProfile.findUnique({
			where: { userId }
		});

		if (!clientProfile) {
			// Phase 3D.4: routed through the same canonical role-state initializer
			// every other role-creation path uses — seeds display fields and
			// computes a real initial completionPercentage instead of a bare
			// `{ userId }` row. `isProfileComplete: true` is a SEPARATE, pre-
			// existing concept from completionPercentage (this endpoint's own
			// business rule: submitting a request implies the client's profile is
			// "complete enough" to transact) and is preserved exactly via
			// extraFields, unchanged from before this phase.
			const user = await prisma.user.findUnique({
				where: { id: userId },
				select: {
					firstName: true, lastName: true, avatarUrl: true, email: true, phoneNumber: true,
					idNumber: true, idExpiryDate: true, ibanNumber: true, bankName: true,
					accountHolderName: true, idDocumentUrl: true
				}
			});
			if (!user) throw new AppError('حساب المستخدم غير موجود', 404);

			await prisma.$transaction(async (tx) => {
				await initializeRoleState(tx, userId, UserRole.CLIENT, user, { isProfileComplete: true });
			});

			clientProfile = await prisma.clientProfile.findUnique({ where: { userId } });
			if (!clientProfile) throw new AppError('تعذر تهيئة الملف الشخصي للعميل', 500);
		}

		// 2. Resolve Specialty ID
		let specialtyId = dto.specialtyId;
		let specialty = specialtyId ? await prisma.specialty.findUnique({ where: { id: specialtyId } }) : null;
		// The client wizard selects a category as the main card. Resolve that
		// category to one of its active specialties instead of silently falling
		// back to an unrelated specialty.
		if (!specialty && specialtyId) {
			specialty = await prisma.specialty.findFirst({
				where: { categoryId: specialtyId, isActive: true },
				orderBy: { sortOrder: 'asc' }
			});
		}

		if (!specialty && dto.specialty) {
			// Find by nameAr, name, or id
			specialty = await prisma.specialty.findFirst({
				where: {
					OR: [
						{ nameAr: { equals: dto.specialty, mode: 'insensitive' } },
						{ name: { equals: dto.specialty, mode: 'insensitive' } },
						{ nameAr: { contains: dto.specialty, mode: 'insensitive' } },
						{ id: dto.specialty }
					]
				}
			});
		}

		if (!specialty) {
			specialty = await prisma.specialty.findFirst({ where: { isActive: true } });
		}

		if (!specialty) {
			let category = await prisma.category.findFirst();
			if (!category) {
				category = await prisma.category.create({
					data: { name: 'عام', nameAr: 'عام', slug: generateSlug('general'), icon: 'folder' }
				});
			}
			specialty = await prisma.specialty.create({
				data: {
					categoryId: category.id,
					name: dto.specialty || 'عام',
					nameAr: dto.specialty || 'عام',
					slug: generateSlug(dto.specialty || 'general'),
					isActive: true
				}
			});
		}

		const resolvedSpecialty = specialty;

		// 3. Normalize Enums
		let budgetTypeEnum: BudgetType = BudgetType.FIXED;
		const bType = (dto.budgetType || 'FIXED').toUpperCase();
		if (bType === 'RANGE') budgetTypeEnum = BudgetType.RANGE;
		if (bType === 'HOURLY') budgetTypeEnum = BudgetType.HOURLY;

		let providerTypeEnum: ProviderTypePreference = ProviderTypePreference.ANY;
		const pType = (dto.preferredProviderType || 'ANY').toUpperCase();
		if (pType === 'INDIVIDUAL') providerTypeEnum = ProviderTypePreference.INDIVIDUAL;
		if (pType === 'COMPANY') providerTypeEnum = ProviderTypePreference.COMPANY;
		if (pType === 'ACCREDITED_ONLY') providerTypeEnum = ProviderTypePreference.ACCREDITED_ONLY;

		const minB = dto.minBudget ? Number(dto.minBudget) : null;
		const maxB = dto.maxBudget ? Number(dto.maxBudget) : null;
		const durationDays = dto.expectedDurationDays ? Number(dto.expectedDurationDays) : 14;

		const subSpecs = Array.isArray(dto.subSpecialties) ? dto.subSpecialties : [];
		const skills = Array.isArray(dto.requiredSkills) && dto.requiredSkills.length > 0 ? dto.requiredSkills : subSpecs;
		const files = (await Promise.all((Array.isArray(dto.attachments) ? dto.attachments : []).map((url, index) =>
			ensureCloudinaryUrl(url, `waseetai/client-requests/${userId}`, `attachment-${index + 1}`)
		))).filter((url): url is string => Boolean(url));

		// 3b. Real WaseetAI project analysis (null fields on any failure — never blocks creation)
		const analysis = await analyzeNewRequest({
			title: dto.title,
			description: dto.description,
			budget: maxB || minB,
			deadlineDays: durationDays
		});

		// 4. Create ClientRequest in PostgreSQL
		const clientRequest = await prisma.clientRequest.create({
			data: {
				clientProfileId: clientProfile.id,
				specialtyId: resolvedSpecialty.id,
				title: dto.title,
				description: dto.description,
				subSpecialties: subSpecs,
				requiredSkills: skills,
				budgetType: budgetTypeEnum,
				minBudget: minB,
				maxBudget: maxB,
				expectedDurationDays: durationDays,
				preferredProviderType: providerTypeEnum,
				requiresNda: Boolean(dto.requiresNda),
				attachments: files,
				outputs: dto.outputs || null,
				customConditions: dto.customConditions || null,
				ipRights: dto.ipRights || 'client',
				providerPreferences: dto.providerPreferences || {},
				allowNegotiation: dto.allowNegotiation !== false,
				splitMilestones: dto.splitMilestones === true,
				milestones: dto.splitMilestones ? (dto.milestones || []) : [],
				status: RequestStatus.OPEN,
				aiAnalyzedSummary: analysis.aiAnalyzedSummary,
				aiComplexityRating: analysis.aiComplexityRating
			},
			include: {
				specialty: true,
				clientProfile: {
					include: {
						user: { select: { firstName: true, lastName: true, avatarUrl: true } }
					}
				}
			}
		});

		// Also mirror into Project table for backward compatibility with older proposal workflows if needed
		try {
			await prisma.project.create({
				data: {
					id: clientRequest.id, // match ID
					title: dto.title,
					description: dto.description,
					specialty: resolvedSpecialty.nameAr || resolvedSpecialty.name || 'عام',
					subSpecialties: subSpecs,
					deliveryDays: durationDays,
					budgetType: dto.budgetType ? dto.budgetType.toLowerCase() : 'range',
					budgetMin: minB,
					budgetMax: maxB,
					budgetFixed: minB,
					attachments: files,
					requirements: skills,
					status: 'OPEN',
					clientId: userId
				}
			});
		} catch (err) {
			// Ignored if Project record with ID already exists
		}

		// 5. Trigger background notifications to matching verified providers
		this.notifyMatchingProviders(clientRequest).catch(err => {
			console.error('[ClientRequestsService] Background notification error:', err);
		});

		return clientRequest;
	}

	/**
	 * Background task: Notify matching providers for new client request
	 */
	private async notifyMatchingProviders(clientRequest: any) {
		try {
			const matchingProviders = await prisma.providerSpecialty.findMany({
				where: {
					specialtyId: clientRequest.specialtyId,
					isActive: true
				},
				take: 20,
				include: {
					providerProfile: { select: { userId: true } }
				}
			});

			const providerUserIds = Array.from(
				new Set(matchingProviders.map(p => p.providerProfile?.userId).filter(Boolean))
			) as string[];

			if (providerUserIds.length > 0) {
				const notificationsData = providerUserIds.map(providerId => ({
					userId: providerId,
					title: `🎯 فرصة مشروع جديدة: ${clientRequest.title}`,
					message: `تم نشر طلب جديد يتوافق مع تخصصك (${clientRequest.specialty.nameAr || clientRequest.specialty.name}). قدم عرضك الآن!`,
					type: 'PROJECT_MATCH',
					category: 'PROJECTS' as const,
					// The apply wizard lives at explore-requests/:id/apply, not a
					// /projects/:id route (which does not exist for a ClientRequest).
					actionUrl: `/provider-overview/explore-requests/${clientRequest.id}/apply`,
					actionText: 'عرض التفاصيل وتقديم عرض',
					metadata: { clientRequestId: clientRequest.id }
				}));

				await prisma.notification.createMany({
					data: notificationsData
				});
			}
		} catch (err) {
			console.error('Failed to send provider notifications:', err);
		}
	}

	/**
	 * GET /api/client/my-requests or /api/client/requests/my-requests
	 */
	public async getMyRequests(userId: string) {
		const clientProfile = await prisma.clientProfile.findUnique({
			where: { userId }
		});

		const [clientRequests, projects] = await Promise.all([
			clientProfile ? prisma.clientRequest.findMany({
				where: { clientProfileId: clientProfile.id },
				include: {
					specialty: true,
					proposals: true
				},
				orderBy: { createdAt: 'desc' }
			}) : Promise.resolve([]),
			prisma.project.findMany({
				where: { clientId: userId },
				include: {
					proposals: true
				},
				orderBy: { createdAt: 'desc' }
			})
		]);

		const formattedRequests: any[] = clientRequests.map((req: any) => ({
			id: req.id,
			title: req.title,
			description: req.description,
			specialty: req.specialty?.nameAr || req.specialty?.name || 'عام',
			subSpecialties: req.subSpecialties,
			status: req.status,
			budgetMin: req.minBudget,
			budgetMax: req.maxBudget,
			budgetType: req.budgetType,
			proposalsCount: req.proposals?.length || 0,
			createdAt: req.createdAt
		}));

		// Merge projects if not already represented in clientRequests
		projects.forEach((p: any) => {
			if (!formattedRequests.some((r: any) => r.id === p.id || r.title === p.title)) {
				formattedRequests.push({
					id: p.id,
					title: p.title,
					description: p.description,
					specialty: p.specialty || 'عام',
					subSpecialties: p.requiredSkills || [],
					status: p.status,
					budgetMin: p.budgetMin || p.budgetFixed,
					budgetMax: p.budgetMax || p.budgetFixed,
					budgetType: p.budgetType || 'FIXED',
					proposalsCount: p.proposalsCount || p.proposals?.length || 0,
					createdAt: p.createdAt
				});
			}
		});

		let allCount = formattedRequests.length;
		let activeCount = 0;
		let pendingCount = 0;
		let closedCount = 0;
		let draftCount = 0;

		formattedRequests.forEach((req: any) => {
			const st = String(req.status || '').toUpperCase();
			if (['OPEN', 'PUBLISHED', 'UNDER_BIDDING', 'IN_PROGRESS'].includes(st)) {
				activeCount++;
			} else if (['PENDING_REVIEW', 'AWAITING_DELIVERY'].includes(st)) {
				pendingCount++;
			} else if (['COMPLETED', 'CLOSED'].includes(st)) {
				closedCount++;
			} else if (st === 'DRAFT') {
				draftCount++;
			} else {
				activeCount++;
			}
		});

		return {
			filters: {
				allCount,
				activeCount,
				pendingCount,
				closedCount,
				draftCount
			},
			data: formattedRequests
		};
	}

	public async getActiveProjects(userId: string, employeeId?: string) {
		// Batch 6 — ?employeeId must belong to the CALLER's own roster, or it
		// is rejected outright (never silently ignored, never usable to probe
		// another company's employee ids).
		if (employeeId) {
			const ownEmployee = await prisma.companyTeamMember.findFirst({
				where: { id: employeeId, companyOwnerId: userId },
				select: { id: true }
			});
			if (!ownEmployee) throw new AppError('الموظف المحدد غير موجود ضمن فريق شركتك', 400);
		}

		const clientProfile = await prisma.clientProfile.findUnique({
			where: { userId }
		});

		// Fetch all active items from both tables in parallel
		const [clientRequests, projects] = await Promise.all([
			clientProfile ? prisma.clientRequest.findMany({
				where: {
					clientProfileId: clientProfile.id,
					status: { in: ['IN_PROGRESS', 'PENDING_SIGNATURE'] }
				},
				include: {
					proposals: {
						where: { status: 'ACCEPTED' },
						include: { provider: { include: { providerProfile: true } } }
					}
				},
				orderBy: { createdAt: 'desc' }
			}) : Promise.resolve([]),
			prisma.project.findMany({
				where: {
					clientId: userId,
					status: { in: ['IN_PROGRESS', 'AWAITING_DELIVERY', 'PENDING_SIGNATURE'] }
				},
				include: {
					projectProposals: {
						where: { status: 'ACCEPTED' },
						include: { provider: { include: { providerProfile: true } }, milestones: { orderBy: { stepOrder: 'asc' } } }
					},
					proposals: {
						where: { status: 'ACCEPTED' },
						include: { provider: { include: { providerProfile: true } } }
					},
					escrow: true,
					contract: {
						include: { stages: { orderBy: { stepOrder: 'asc' } } }
					}
				},
				orderBy: { createdAt: 'desc' }
			})
		]);

		// Collect all project IDs to batch-query escrow amounts
		const allProjectIds = [
			...clientRequests.map(r => r.id),
			...projects.map(p => p.id)
		];
		const escrowRecords = allProjectIds.length > 0
			? await prisma.escrow.findMany({ where: { projectId: { in: allProjectIds } } })
			: [];
		const escrowMap = new Map(escrowRecords.map(e => [e.projectId, e]));
		// Workspace data is contract-backed. Expose the contract id explicitly
		// so clients do not have to guess which id to use for the workspace.
		const contracts = allProjectIds.length > 0
			? await prisma.contract.findMany({
				where: { projectId: { in: allProjectIds }, OR: [{ clientId: userId }, { providerId: userId }] },
				select: { id: true, projectId: true }
			})
			: [];
		const workspaceMap = new Map(contracts.map(contract => [contract.projectId, contract.id]));
		// Batch 6 — one batched lookup (same pattern as escrowRecords/contracts
		// above) for the real responsible-employee field, covering BOTH
		// Project-primary AND ClientRequest-primary items uniformly via the
		// shared id (ClientRequest.id === the mirrored Project.id). Never a
		// per-row query.
		const employeeRecords = allProjectIds.length > 0
			? await prisma.project.findMany({
				where: { id: { in: allProjectIds }, assignedEmployeeId: { not: null } },
				select: { id: true, assignedEmployee: { select: { id: true, name: true, jobTitle: true } } }
			})
			: [];
		const employeeMap = new Map(employeeRecords.map(p => [p.id, p.assignedEmployee]));

		const activeItems: any[] = [];

		// Helper to extract provider info from any accepted proposal type
		const extractProvider = (providerUser: any) => {
			const profile = providerUser?.providerProfile;
			const name = profile?.companyName ||
				[providerUser?.firstName, providerUser?.lastName].filter(Boolean).join(' ') || 'مقدم خدمة';
			const initial = name.split(' ').map((n: string) => n[0] || '').join('').substring(0, 2) || 'مـ';
			return { name, initial, isVerified: providerUser?.status === 'ACTIVE' };
		};

		// Map ClientRequest items
		for (const item of clientRequests) {
			// Prefer the canonical Project row when both legacy and current records share an id.
			if (projects.some(project => project.id === item.id)) continue;
			const acceptedProp = item.proposals?.[0] || null;
			const provider = acceptedProp ? extractProvider(acceptedProp.provider) : { name: 'مقدم خدمة', initial: 'مـ' };
			const price = acceptedProp ? Number(acceptedProp.price || 0) : 0;
			const escrow = escrowMap.get(item.id);
			const heldAmount = escrow ? Math.max(0, Number(escrow.amount) - Number(escrow.releasedAmount || 0)) : price;
			const durationDays = item.expectedDurationDays || 14;
			const endAt = new Date(item.updatedAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
			const daysLeft = Math.ceil((endAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

			// For ClientRequest with no milestone schema, estimate progress from status + elapsed time
			let progress = 0;
			if (item.status === 'PENDING_SIGNATURE') {
				progress = 5;
			} else if (item.status === 'IN_PROGRESS' && durationDays > 0) {
				const elapsedDays = Math.max(0, Math.floor((Date.now() - item.updatedAt.getTime()) / (1000 * 60 * 60 * 24)));
				progress = Math.min(85, Math.round((elapsedDays / durationDays) * 100));
			}

			activeItems.push({
				id: item.id,
				projectId: item.id,
				workspaceId: workspaceMap.get(item.id) || null,
				title: item.title,
				status: item.status === 'PENDING_SIGNATURE' ? 'wait' : (daysLeft < 0 ? 'late' : 'run'),
				rawStatus: item.status,
				progress,
				provider,
				contract: `CT-${item.id.substring(0, 4).toUpperCase()}`,
				heldAmount,
				employee: employeeMap.get(item.id) || null,
				nextStep: item.status === 'PENDING_SIGNATURE' ? 'استكمال توقيع العقد من الطرفين' : 'التسليم النهائي للمشروع، قيد العمل لدى مقدم الخدمة',
				completedStages: 0,
				stagesCount: 1,
				daysLeft,
				expectedDurationDays: durationDays,
				updatedAt: item.updatedAt.toISOString()
			});
		}

		// Map Project items (with real milestones from ProjectProposal)
		for (const p of projects) {
			if (activeItems.some(r => r.id === p.id)) continue;

			const ppProp = p.projectProposals?.[0] || null;
			const legacyProp = p.proposals?.[0] || null;
			const providerUser = ppProp?.provider || legacyProp?.provider || null;
			const provider = providerUser ? extractProvider(providerUser) : { name: 'مقدم خدمة', initial: 'مـ' };
			const price = ppProp ? Number(ppProp.totalPrice || 0) : (legacyProp ? Number(legacyProp.price || 0) : 0);
			const escrow = p.escrow;
			const heldAmount = escrow ? Math.max(0, Number(escrow.amount) - Number(escrow.releasedAmount || 0)) : price;
			const contractStages = p.contract?.stages || [];
			const milestones = contractStages.length > 0 ? contractStages : (ppProp?.milestones || []);
			const startAt = p.contract?.clientSignedAt || p.updatedAt;
			const endAt = new Date(startAt.getTime() + Number(p.deliveryDays || 0) * 24 * 60 * 60 * 1000);
			const daysLeft = Math.ceil((endAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

			// Compute progress from real milestones
			let progress = 0;
			if (milestones.length > 0) {
				const elapsedDays = Math.max(0, Math.floor((Date.now() - startAt.getTime()) / (1000 * 60 * 60 * 24)));
				let accDays = 0;
				let completed = 0;
				for (const m of milestones) {
					accDays += Number(m.days || 0);
					const milestoneStatus = 'status' in m ? m.status : null;
					if (p.status === 'COMPLETED' || milestoneStatus === 'APPROVED' || (!milestoneStatus && elapsedDays >= accDays)) {
						completed++;
					}
				}
				progress = Math.round((completed / milestones.length) * 100);
			} else if (p.status === 'PENDING_SIGNATURE') {
				progress = 5;
			} else if (p.status === 'AWAITING_DELIVERY') {
				progress = 90;
			} else if (p.status === 'IN_PROGRESS' && p.deliveryDays > 0) {
				const elapsedDays = Math.max(0, Math.floor((Date.now() - p.updatedAt.getTime()) / (1000 * 60 * 60 * 24)));
				progress = Math.min(85, Math.round((elapsedDays / p.deliveryDays) * 100));
			}

			const completedStages = milestones.filter((m: any) => m.status === 'APPROVED').length ||
				(milestones.length > 0 ? Math.round((progress / 100) * milestones.length) : 0);
			const reviewStage = milestones.find((m: any) => m.status === 'SUBMITTED');
			const currentStage = reviewStage || milestones.find((m: any) => m.status !== 'APPROVED') || milestones[milestones.length - 1];
			const needsReview = p.status === 'AWAITING_DELIVERY' || Boolean(reviewStage);
			const displayStatus = needsReview ? 'wait' : (daysLeft < 0 ? 'late' : 'run');
			const nextStep = currentStage
				? `${currentStage.title || 'المرحلة الحالية'}، ${needsReview ? 'سُلّمت وتنتظر اعتمادك' : 'قيد العمل لدى مقدم الخدمة'}`
				: (needsReview ? 'مراجعة التسليم المرسل واعتماده' : 'متابعة تنفيذ المشروع');

			activeItems.push({
				id: p.id,
				projectId: p.id,
				workspaceId: p.contract?.id || workspaceMap.get(p.id) || null,
				title: p.title,
				status: displayStatus,
				rawStatus: p.status,
				progress,
				provider,
				contract: `CT-${p.id.substring(0, 4).toUpperCase()}`,
				heldAmount,
				employee: employeeMap.get(p.id) || null,
				nextStep,
				completedStages,
				stagesCount: milestones.length || 1,
				daysLeft,
				expectedDurationDays: p.deliveryDays,
				updatedAt: p.updatedAt.toISOString()
			});
		}

		// Batch 6 — the already-ownership-validated employee filter is applied
		// here, scoping both the list AND the KPIs below to that employee's
		// projects only. Still fully bounded by this client's own
		// clientId/clientProfileId scoping above — never a cross-client leak.
		const filteredItems = employeeId
			? activeItems.filter(item => item.employee?.id === employeeId)
			: activeItems;

		// Compute KPIs from real data
		const totalHeld = escrowRecords
			.filter(e => e.status === 'HELD')
			.reduce((acc, e) => acc + Math.max(0, Number(e.amount) - Number(e.releasedAmount || 0)), 0);
		const awaitingReviewCount = filteredItems.filter(i => i.status === 'wait').length;
		const overdueCount = filteredItems.filter(i => i.status === 'late').length;

		const kpis = [
			{ icon: 'list', value: filteredItems.length, label: 'مشاريع نشطة' },
			{ icon: 'lock', value: totalHeld, label: 'محتجز بالضمان $' },
			{ icon: 'clock', value: awaitingReviewCount, label: 'بانتظار مراجعتك' },
			{ icon: 'ai', value: overdueCount > 0 ? `${overdueCount} متأخر` : 'جيد', label: 'الحالة العامة' },
		];

		return {
			kpis,
			projects: filteredItems
		};
	}

	/**
	 * GET /api/client/my-requests/completed-projects
	 */
	public async getCompletedProjects(userId: string, page: number = 1, limit: number = 10) {
		const skip = (page - 1) * limit;
		const completedStatuses = ['COMPLETED', 'CANCELLED', 'DISPUTED'];

		const [total, contracts] = await Promise.all([
			prisma.contract.count({
				where: { clientId: userId, status: { in: completedStatuses as any } }
			}),
			prisma.contract.findMany({
				where: { clientId: userId, status: { in: completedStatuses as any } },
				include: {
					project: { include: { escrow: true, serviceCatalog: { select: { id: true, title: true } } } },
					provider: { select: { id: true, firstName: true, lastName: true, providerProfile: { select: { companyName: true } } } },
				},
				orderBy: { updatedAt: 'desc' },
				skip,
				take: limit,
			})
		]);

		const projectIds = contracts.map(c => c.projectId);
		const reviews = projectIds.length > 0
			? await prisma.review.findMany({ where: { projectId: { in: projectIds }, clientId: userId, reviewerRole: 'CLIENT' } })
			: [];
		const reviewMap = new Map(reviews.map(r => [r.projectId, r]));

		const items = contracts.map(c => {
			const providerName = c.provider?.providerProfile?.companyName ||
				[c.provider?.firstName, c.provider?.lastName].filter(Boolean).join(' ') || 'مقدم خدمة';
			const escrow = c.project?.escrow;
			const totalPrice = escrow ? Number(escrow.amount) : c.price;
			const releasedAmount = escrow ? Number(escrow.releasedAmount || 0) : 0;
			const review = reviewMap.get(c.projectId);
			return {
				id: c.id,
				projectId: c.projectId,
				title: c.project?.title || 'مشروع',
				status: c.status,
				rawStatus: c.project?.status || c.status,
				provider: {
					id: c.providerId,
					name: providerName,
					initials: providerName.split(' ').map((n: string) => n[0] || '').join('').substring(0, 2) || 'مـ',
				},
				contractReference: `CT-${c.id.substring(0, 4).toUpperCase()}`,
				totalPrice,
				releasedAmount,
				heldAmount: Math.max(0, totalPrice - releasedAmount),
				completedAt: c.updatedAt.toISOString(),
				category: c.project?.serviceCatalog?.title || c.project?.specialty || 'Marketplace',
				canRate: c.status === 'COMPLETED' && !review,
				hasRated: !!review,
				rating: review?.rating || null,
				ratingComment: review?.comment || null,
				ratedAt: review?.createdAt ? review.createdAt.toISOString() : null,
			};
		});

		return {
			items,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
		};
	}

	/**
	 * GET /api/client/requests/active-projects/:id
	 */
	public async getActiveProjectTracking(userId: string, requestId: string) {
		let projectTitle = '';
		const contractNumber = `CT-${requestId.substring(0, 4).toUpperCase()}`;
		let providerName = 'مقدم خدمة';
		let providerInitial = 'مـ';
		let progress = 0;
		let startDate: Date = new Date();
		let expectedEndDate: Date = new Date();
		let daysLeft = 0;
		let heldAmount = 0;
		let releasedAmount = 0;
		let completedMilestones = 0;
		let timelines: any[] = [];
		let price = 0;
		let realMilestones: any[] = [];
		let rawStatus = 'OPEN';

		// Check ClientRequest first
		const clientReq = await prisma.clientRequest.findFirst({
			where: { id: requestId, clientProfile: { userId } },
			include: {
				proposals: {
					where: { status: 'ACCEPTED' },
					include: { provider: { include: { providerProfile: true } } }
				}
			}
		});

		if (clientReq) {
			rawStatus = clientReq.status;
			projectTitle = clientReq.title;
			const duration = clientReq.expectedDurationDays || 14;
			startDate = clientReq.updatedAt;
			expectedEndDate = new Date(clientReq.updatedAt.getTime() + duration * 24 * 60 * 60 * 1000);
			daysLeft = Math.max(0, Math.floor((expectedEndDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)));

			if (clientReq.proposals && clientReq.proposals.length > 0) {
				const prop = clientReq.proposals[0];
				price = Number(prop.price || 0);

				// ClientRequest Proposals don't have explicit milestones in schema, so we create a dynamic one
				realMilestones = [{
					id: 'm-req-1',
					title: 'تسليم المشروع النهائي',
					amount: price,
					percentage: 100,
					days: duration,
					status: rawStatus === 'COMPLETED' ? 'COMPLETED' : 'PENDING'
				}];

				const pProfile = prop.provider.providerProfile;
				providerName = pProfile?.companyName || `${prop.provider.firstName || ''} ${prop.provider.lastName || ''}`.trim() || 'مقدم خدمة';
				providerInitial = providerName.split(' ').map((n: string) => n[0] || '').join('').substring(0, 2);
			}
		} else {
			// Fallback to Project
			const project = await prisma.project.findFirst({
				where: { id: requestId, clientId: userId },
				include: {
					projectProposals: {
						where: { status: 'ACCEPTED' },
						include: { provider: { include: { providerProfile: true } }, milestones: { orderBy: { stepOrder: 'asc' } } }
					},
					proposals: {
						where: { status: 'ACCEPTED' },
						include: { provider: { include: { providerProfile: true } } }
					}
				}
			});

			if (project) {
				rawStatus = project.status;
				projectTitle = project.title;
				const duration = Number(project.deliveryDays || 14);
				startDate = project.updatedAt;
				expectedEndDate = new Date(project.updatedAt.getTime() + duration * 24 * 60 * 60 * 1000);
				daysLeft = Math.max(0, Math.floor((expectedEndDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)));

				if (project.projectProposals && project.projectProposals.length > 0) {
					const prop = project.projectProposals[0];
					price = Number(prop.totalPrice || 0);
					realMilestones = prop.milestones || [];
					const pProfile = prop.provider.providerProfile;
					providerName = pProfile?.companyName || `${prop.provider.firstName || ''} ${prop.provider.lastName || ''}`.trim() || 'مقدم خدمة';
					providerInitial = providerName.split(' ').map((n: string) => n[0] || '').join('').substring(0, 2);
				} else if (project.proposals && project.proposals.length > 0) {
					const prop = project.proposals[0];
					price = Number(prop.price || 0);
					realMilestones = [{
						id: 'm-proj-1',
						title: 'تسليم المشروع النهائي',
						amount: price,
						percentage: 100,
						days: duration,
						status: rawStatus === 'COMPLETED' ? 'COMPLETED' : 'PENDING'
					}];
					const pProfile = prop.provider.providerProfile;
					providerName = pProfile?.companyName || `${prop.provider.firstName || ''} ${prop.provider.lastName || ''}`.trim() || 'مقدم خدمة';
					providerInitial = providerName.split(' ').map((n: string) => n[0] || '').join('').substring(0, 2);
				}
			} else {
				throw new AppError('المشروع غير موجود', 404);
			}
		}

		if (realMilestones.length > 0) {
			let accDays = 0;
			const elapsedMs = new Date().getTime() - startDate.getTime();
			const elapsedDays = Math.max(0, Math.floor(elapsedMs / (1000 * 60 * 60 * 24)));

			timelines = realMilestones.map((m, index) => {
				let mStatus: 'COMPLETED' | 'IN_PROGRESS' | 'PENDING' = 'PENDING';

				const milestoneStartDay = accDays;
				const milestoneEndDay = accDays + Number(m.days || 0);

				const milestoneStartDate = new Date(startDate.getTime() + milestoneStartDay * 24 * 60 * 60 * 1000);
				const milestoneEndDate = new Date(startDate.getTime() + milestoneEndDay * 24 * 60 * 60 * 1000);

				if (rawStatus === 'COMPLETED') {
					mStatus = 'COMPLETED';
				} else if (rawStatus === 'PENDING_SIGNATURE') {
					mStatus = 'PENDING';
				} else if (rawStatus === 'AWAITING_DELIVERY') {
					mStatus = index === realMilestones.length - 1 ? 'IN_PROGRESS' : 'COMPLETED';
				} else {
					if (elapsedDays >= milestoneEndDay) {
						if (index === realMilestones.length - 1) {
							mStatus = 'IN_PROGRESS';
						} else {
							mStatus = 'COMPLETED';
						}
					} else if (elapsedDays >= milestoneStartDay) {
						mStatus = 'IN_PROGRESS';
					} else {
						mStatus = 'PENDING';
					}
				}

				accDays += Number(m.days || 0);

				return {
					id: m.id || String(index + 1),
					title: m.title || `المرحلة ${index + 1}`,
					status: mStatus,
					startDate: milestoneStartDate.toISOString(),
					endDate: milestoneEndDate.toISOString(),
					description: m.description || '',
					days: Number(m.days || 0),
					amount: Number(m.amount || 0)
				};
			});

			completedMilestones = timelines.filter(t => t.status === 'COMPLETED').length;
			releasedAmount = timelines.filter(t => t.status === 'COMPLETED').reduce((acc, t) => acc + t.amount, 0);
			heldAmount = price - releasedAmount;
			progress = Math.round((completedMilestones / realMilestones.length) * 100);
		} else {
			timelines = [];
			completedMilestones = 0;
			releasedAmount = 0;
			heldAmount = price;

			if (rawStatus === 'PENDING_SIGNATURE') {
				progress = 10;
			} else if (rawStatus === 'AWAITING_DELIVERY') {
				progress = 90;
			} else if (rawStatus === 'COMPLETED') {
				progress = 100;
				releasedAmount = price;
				heldAmount = 0;
			} else {
				progress = 25;
			}
		}

		return {
			project: {
				id: requestId,
				title: projectTitle,
				status: rawStatus,
				contract: contractNumber,
				price: price,
				progress: progress,
				startDate: startDate.toISOString(),
				endDate: expectedEndDate.toISOString(),
				daysLeft: daysLeft,
				milestonesCount: realMilestones.length,
				completedMilestones: completedMilestones,
				heldAmount: heldAmount,
				releasedAmount: releasedAmount,
				provider: {
					name: providerName,
					initial: providerInitial
				}
			},
			timelines
		};
	}

	/**
	 * GET /api/client/my-requests/:id or /api/client/requests/:id
	 */

	public async getRequestDetails(userId: string, requestId: string) {
		const request = await prisma.clientRequest.findFirst({
			where: {
				id: requestId,
				clientProfile: { userId }
			},
			include: {
				clientProfile: {
					include: { user: { select: { email: true, firstName: true, lastName: true } } }
				},
				specialty: {
					include: { category: true }
				},
				proposals: {
					include: {
						provider: {
							select: {
								id: true,
								firstName: true,
								lastName: true,
								avatarUrl: true,
								currentLevel: true,
								gamification: { select: { points: true, currentLevelIndex: true } },
								providerProfile: {
									select: {
										headline: true,
										companyName: true,
										rating: true,
										isVerified: true
									}
								}
							}
						},
						attachments: true
					},
					orderBy: { createdAt: 'desc' }
				}
			}
		});

		if (!request) {
			throw new AppError('طلب المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);
		}

		// Fetch milestones from ProjectProposal table (the only model with a milestones relation)
		const projectProposals = await prisma.projectProposal.findMany({
			where: { projectId: requestId },
			include: {
				milestones: { orderBy: { stepOrder: 'asc' } }
			}
		});

		// Build a providerId → milestones lookup for merging
		const milestonesMap = new Map<string, any[]>();
		// providerId → the WaseetAI proposal-quality review stored at creation
		// (ProjectProposal.aiQualityTag / aiFeedback.summary). It judges the
		// proposal's own plan/price/days only — never project fit or price
		// fairness — so it is exposed under quality-specific names.
		const qualityMap = new Map<string, { tag: string | null; summary: string | null }>();
		for (const pp of projectProposals) {
			milestonesMap.set(pp.providerId, pp.milestones || []);
			const fb = pp.aiFeedback as { source?: unknown; summary?: unknown } | null;
			qualityMap.set(pp.providerId, {
				tag: pp.aiQualityTag || null,
				summary: fb && fb.source === 'WASEET_AI' && typeof fb.summary === 'string' && fb.summary.trim() ? fb.summary.trim() : null,
			});
		}

		// تنسيق المرفقات النظيفة
		const attachments = (request.attachments || []).map((url: string) => {
			const fileName = url.split('/').pop() || 'file';
			const ext = fileName.split('.').pop()?.toLowerCase() || '';
			const fileType = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image' : (ext === 'pdf' ? 'pdf' : 'doc');
			return { name: fileName, url, type: fileType };
		});

		// معالجة العروض ببيانات حقيقية 100%
		// Batch-count completed projects per provider for all proposal providers
		const providerIds = request.proposals.map(p => p.providerId).filter(Boolean);
		const completedProjectCounts = providerIds.length > 0
			? await prisma.project.groupBy({
				by: ['providerId'],
				where: { providerId: { in: providerIds }, status: 'COMPLETED' },
				_count: { id: true }
			})
			: [];
		const completedCountMap = new Map(
			completedProjectCounts.map(c => [c.providerId!, c._count.id])
		);

		const proposals = request.proposals.map(prop => {
			const providerUser = prop.provider;
			const profile = providerUser?.providerProfile;
			const providerName = profile?.companyName ||
				[providerUser?.firstName, providerUser?.lastName].filter(Boolean).join(' ') ||
				'مقدم خدمة معتمد';

			const rawRating = Number(profile?.rating || 0);
			const isAccredited = profile?.isVerified === true;

			// Batch 5 (truthfulness pass) — the REAL gamification progression
			// level, via the same resolveProviderProgression()/
			// PROVIDER_LEVEL_MATRIX source marketplace and the dashboard already
			// use. Previously this response had no real level at all, and the
			// frontend was reading the accreditation `badge` field below into a
			// variable named providerLevel — a different concept entirely
			// (verification status, not progression). null when the provider
			// genuinely has neither a ProviderGamification row nor a legacy
			// currentLevel value.
			const resolvedLevel = resolveProviderProgression(providerUser.gamification, {
				firstName: '',
				lastName: '',
				avatarUrl: null,
				profileCompletionPercent: 0,
				currentLevel: providerUser.currentLevel || '',
				currentPoints: 0,
				pointsToNextLevel: 0
			}).currentLevel;
			const providerLevel = resolvedLevel && resolvedLevel.trim() ? resolvedLevel : null;

			// Merge milestones from ProjectProposal if available
			const realMilestones = milestonesMap.get(prop.providerId) || [];

			return {
				id: prop.id,
				status: prop.status,
				coverLetter: prop.coverLetter || '',
				workPlan: prop.workPlan || '',
				bidAmount: Number(prop.price || 0),
				deliveryDays: prop.deliveryDays || 1,
				aiMatchScore: prop.aiMatchScore || null,
				aiFairPriceMin: prop.aiFairPriceMin || null,
				aiFairPriceMax: prop.aiFairPriceMax || null,
				aiPriceTag: prop.aiPriceTag || null,
				aiQualityTag: qualityMap.get(prop.providerId)?.tag ?? null,
				aiQualitySummary: qualityMap.get(prop.providerId)?.summary ?? null,
				createdAt: prop.createdAt,
				provider: {
					id: providerUser.id,
					name: providerName,
					headline: profile?.headline || request.specialty?.nameAr || 'مختص',
					completedProjects: completedCountMap.get(prop.providerId) || 0,
					rating: rawRating,
					// Accreditation/verification status (ProviderProfile.isVerified) —
					// deliberately a separate concept from providerLevel below, never
					// used to derive it. Left exactly as-is: no other consumer of
					// this endpoint relies on it, so it is kept available rather than
					// removed (not a broad API redesign).
					badge: isAccredited ? 'معتمد' : 'محترف',
					// Real gamification progression level — see resolvedLevel above.
					providerLevel,
					avatarUrl: providerUser.avatarUrl || null
				},
				attachments: (prop.attachments || []).map((a: any) => ({
					id: a.id,
					name: a.fileName || 'مرفق',
					url: a.fileUrl || a
				})),
				milestones: realMilestones.map((m: any, idx: number) => ({
					id: m.id,
					stepOrder: m.stepOrder || idx + 1,
					title: m.title,
					description: m.description || '',
					days: m.days || 1,
					amount: Number(m.amount || 0),
					percentage: m.percentage || 0
				}))
			};
		});

		return {
			id: request.id,
			title: request.title,
			description: request.description,
			status: request.status,
			budget: {
				type: request.budgetType,
				min: request.minBudget,
				max: request.maxBudget,
				currency: 'USD' // active client-request budget pricing is now USD-semantic
			},
			category: {
				id: request.specialty?.category?.id || null,
				nameAr: request.specialty?.category?.nameAr || '',
				slug: request.specialty?.category?.slug || ''
			},
			specialty: {
				id: request.specialty?.id || null,
				nameAr: request.specialty?.nameAr || '',
				slug: request.specialty?.slug || ''
			},
			subSpecialties: request.subSpecialties || [],
			expectedDurationDays: request.expectedDurationDays || 14,
			createdAt: request.createdAt,
			updatedAt: request.updatedAt,
			attachments,
			proposalsCount: proposals.length,
			proposals,
			aiAnalysis: readAiAnalysis(request.aiAnalyzedSummary, request.aiComplexityRating),
			client: {
				name: (request.clientProfile?.user?.firstName || '') + ' ' + (request.clientProfile?.user?.lastName || ''),
				email: request.clientProfile?.user?.email || ''
			}
		};
	}

	/**
	 * Select one proposal and freeze the commercial snapshot before either party signs.
	 */
	public async selectOffer(userId: string, requestId: string, offerId: string) {
		const request = await prisma.clientRequest.findFirst({
			where: { id: requestId, clientProfile: { userId } }
		});
		if (!request) throw new AppError('طلب المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);
		if (!['OPEN', 'PENDING_SIGNATURE'].includes(String(request.status))) {
			throw new AppError('لا يمكن اختيار عرض لهذا الطلب في حالته الحالية', 409);
		}

		const legacy = await prisma.proposal.findFirst({
			where: { id: offerId, clientRequestId: requestId },
			include: { provider: true }
		});
		const canonical = legacy
			? await prisma.projectProposal.findFirst({ where: { projectId: requestId, providerId: legacy.providerId }, include: { milestones: true } })
			: await prisma.projectProposal.findFirst({ where: { id: offerId, projectId: requestId }, include: { milestones: true } });

		if (!legacy && !canonical) throw new AppError('العرض المحدد غير موجود أو لا يتبع هذا الطلب', 404);
		if (legacy?.status === ProposalStatus.CANCELLED || canonical?.status === ProposalStatus.CANCELLED) {
			throw new AppError('هذا العرض مسحوب ولا يمكن اختياره', 409);
		}
		const providerId = canonical?.providerId || legacy!.providerId;

		// Phase 4 — once the client has signed + funded escrow (contract moved
		// past PENDING_CLIENT_SIGNATURE, escrow HELD), the selection is frozen.
		// Previously the upsert below would silently reset a funded contract back
		// to PENDING_CLIENT_SIGNATURE (possibly for a different provider) while
		// the client's money stayed HELD against it — and the follow-up deposit
		// then collided on the same ESCROW-<contractId> reference, stranding the
		// funds. Advisory pre-check here; the authoritative, race-safe gate is
		// the conditional updateMany inside the transaction below.
		const [existingContract, heldEscrow] = await Promise.all([
			prisma.contract.findUnique({ where: { projectId: requestId }, select: { id: true, status: true } }),
			prisma.escrow.findUnique({ where: { projectId: requestId }, select: { status: true } })
		]);
		if ((existingContract && existingContract.status !== ContractStatus.PENDING_CLIENT_SIGNATURE) || heldEscrow?.status === 'HELD') {
			throw new AppError('تم توقيع العقد وتمويل الضمان لهذا الطلب، ولا يمكن تغيير العرض المختار', 409);
		}
		const price = Number(canonical?.totalPrice ?? legacy?.price ?? 0);
		const durationDays = canonical?.deliveryDays ?? legacy?.deliveryDays ?? 0;
		if (price <= 0 || durationDays <= 0) throw new AppError('بيانات العرض المالية أو الزمنية غير صالحة', 422);

		const termsSnapshot = {
			version: 1,
			projectTitle: request.title,
			price,
			durationDays,
			milestones: canonical?.milestones || [],
			selectedAt: new Date().toISOString()
		};

		const contract = await prisma.$transaction(async tx => {
			// Authoritative gate (row lock on the contract / request rows): only a
			// contract still awaiting the client's signature may be re-pointed, and
			// the request itself must still be in a selectable state. A concurrent
			// depositEscrow() that already moved the contract forward makes this
			// match zero rows and the whole selection rolls back untouched.
			const requestGate = await tx.clientRequest.updateMany({
				where: { id: requestId, status: { in: [RequestStatus.OPEN, RequestStatus.PENDING_SIGNATURE] } },
				data: { status: RequestStatus.PENDING_SIGNATURE }
			});
			if (requestGate.count !== 1) throw new AppError('لا يمكن اختيار عرض لهذا الطلب في حالته الحالية', 409);
			const lockedContract = await tx.contract.findUnique({ where: { projectId: requestId }, select: { id: true } });
			if (lockedContract) {
				const reopenable = await tx.contract.updateMany({
					where: { id: lockedContract.id, status: ContractStatus.PENDING_CLIENT_SIGNATURE, clientSignedAt: null },
					data: { status: ContractStatus.PENDING_CLIENT_SIGNATURE }
				});
				if (reopenable.count !== 1) throw new AppError('تم توقيع العقد وتمويل الضمان لهذا الطلب، ولا يمكن تغيير العرض المختار', 409);
			}
			await tx.proposal.updateMany({
				where: { clientRequestId: requestId, providerId },
				data: { status: ProposalStatus.PENDING_SIGNATURE }
			});
			await tx.proposal.updateMany({
				where: { clientRequestId: requestId, providerId: { not: providerId } },
				data: { status: ProposalStatus.REJECTED }
			});
			await tx.projectProposal.updateMany({
				where: { projectId: requestId, providerId },
				data: { status: ProposalStatus.PENDING_SIGNATURE }
			});
			await tx.projectProposal.updateMany({
				where: { projectId: requestId, providerId: { not: providerId } },
				data: { status: ProposalStatus.REJECTED }
			});
			await tx.clientRequest.update({ where: { id: requestId }, data: { status: RequestStatus.PENDING_SIGNATURE } });
			await tx.project.update({ where: { id: requestId }, data: { status: 'PENDING_SIGNATURE' } });

			return tx.contract.upsert({
				where: { projectId: requestId },
				create: {
					projectId: requestId, clientId: userId, providerId,
					offerId: canonical?.id || legacy!.id, price, durationDays,
					phasesCount: canonical?.milestones.length || 1,
					terms: termsSnapshot, termsVersion: 1,
					status: ContractStatus.PENDING_CLIENT_SIGNATURE
				},
				update: {
					providerId, offerId: canonical?.id || legacy!.id, price, durationDays,
					phasesCount: canonical?.milestones.length || 1,
					terms: termsSnapshot, termsVersion: 1,
					status: ContractStatus.PENDING_CLIENT_SIGNATURE,
					clientSignedAt: null, providerSignedAt: null,
					clientSignatureHash: null, providerSignatureHash: null, signedAt: null
				}
			});
		});

		return { contractId: contract.id, status: contract.status, selectedOfferId: contract.offerId };
	}

	/**
	 * POST /api/client/requests/:id/contract/sign
	 * Creates an OTP and sends it to the user's email
	 */
	public async signContract(userId: string, requestId: string, offerId: string) {
		const otpSecret = process.env.OTP_SECRET || process.env.JWT_SECRET;
		if (!otpSecret) throw new AppError('إعداد التوقيع الآمن OTP_SECRET غير مكتمل', 500);
		const user = await prisma.user.findUnique({ where: { id: userId } });
		if (!user || !user.email) throw new AppError('المستخدم غير موجود أو لا يملك بريد إلكتروني', 404);

		const contract = await prisma.contract.findFirst({
			where: { projectId: requestId, clientId: userId, status: ContractStatus.PENDING_CLIENT_SIGNATURE }
		});
		if (!contract) throw new AppError('يجب اختيار عرض صالح قبل توقيع العقد', 409);
		if (offerId !== contract.offerId) {
			const selectedLegacy = await prisma.proposal.findFirst({
				where: { id: offerId, clientRequestId: requestId, providerId: contract.providerId, status: ProposalStatus.PENDING_SIGNATURE }
			});
			if (!selectedLegacy) throw new AppError('العرض لا يطابق العرض المختار للعقد', 409);
		}

		// Generate 6 digit OTP
		const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
		const recentChallenges = await prisma.otpVerification.count({
			where: {
				userId,
				type: 'EMAIL',
				createdAt: { gt: new Date(Date.now() - 60 * 1000) },
				context: { path: ['requestId'], equals: requestId }
			}
		});
		if (recentChallenges >= 3) throw new AppError('طلبات رمز التوقيع كثيرة. انتظر دقيقة ثم حاول مجدداً', 429);
		const otpHash = createHmac('sha256', otpSecret).update(`${contract.id}:${otpCode}`).digest('hex');

		const otpRecord = await prisma.otpVerification.create({
			data: {
				userId: userId,
				code: otpHash,
				type: 'EMAIL',
				context: { purpose: 'CLIENT_CONTRACT_SIGNATURE', requestId, contractId: contract.id, offerId: contract.offerId },
				expiresAt: new Date(Date.now() + 10 * 60 * 1000)
			}
		});

		// Send Email dynamically
		try {
			await mailTransporter.sendMail({
				from: process.env.SMTP_USER || '"وسيط AI" <noreply@waseetai.com>',
				to: user.email,
				subject: 'رمز التحقق لتوقيع العقد وإيداع الضمان - وسيط AI',
				html: getOtpEmailTemplate(otpCode)
			});
		} catch (err) {
			console.error('Failed to send email OTP', err);
			await prisma.otpVerification.delete({ where: { id: otpRecord.id } }).catch(() => undefined);
			throw new AppError('تعذر إرسال رمز التوقيع. لم يتم تنفيذ أي توقيع أو حجز', 503);
		}

		return { email: user.email };
	}

	/**
	 * POST /api/client/requests/:id/escrow/deposit
	 * Verifies OTP, marks contract as signed, creates escrow record, updates project status
	 */
	public async depositEscrow(userId: string, requestId: string, offerId: string, otpCode: string, paymentMethod: string) {
		const otpSecret = process.env.OTP_SECRET || process.env.JWT_SECRET;
		if (!otpSecret) throw new AppError('إعداد التوقيع الآمن OTP_SECRET غير مكتمل', 500);
		if (String(paymentMethod || '').toLowerCase() !== 'wallet') {
			throw new AppError('يجب تمويل الضمان من رصيد المحفظة الموثق', 400);
		}
		const contractBeforePayment = await prisma.contract.findFirst({
			where: { projectId: requestId, clientId: userId, status: ContractStatus.PENDING_CLIENT_SIGNATURE }
		});
		if (!contractBeforePayment) throw new AppError('العقد غير جاهز لتوقيع العميل أو تم توقيعه مسبقاً', 409);
		// Phase 4 — selectOffer() stores the CANONICAL ProjectProposal id on
		// Contract.offerId whenever one exists, while the client UI (request
		// details → contract → deposit) carries the legacy Proposal mirror id
		// (the only proposal ids GET /client/my-requests/:id returns). The old
		// strict equality therefore rejected every normal deposit with 409.
		// Accept either id, but only when it is the mirror of the SAME provider's
		// offer on THIS request that the contract was frozen for — the exact
		// rule signContract() above already applies.
		if (offerId !== contractBeforePayment.offerId) {
			const mirroredOffer = await prisma.proposal.findFirst({
				where: { id: offerId, clientRequestId: requestId, providerId: contractBeforePayment.providerId, status: ProposalStatus.PENDING_SIGNATURE },
				select: { id: true }
			});
			if (!mirroredOffer) throw new AppError('العرض لا يطابق العقد المختار', 409);
		}

		// 1. Verify OTP
		const otpRecord = await prisma.otpVerification.findFirst({
			where: {
				userId: userId,
				type: 'EMAIL',
				AND: [
					{ context: { path: ['purpose'], equals: 'CLIENT_CONTRACT_SIGNATURE' } },
					{ context: { path: ['requestId'], equals: requestId } },
					{ context: { path: ['contractId'], equals: contractBeforePayment.id } }
				],
				expiresAt: { gt: new Date() }
			},
			orderBy: { createdAt: 'desc' }
		});

		if (!otpRecord) {
			throw new AppError('رمز التحقق غير صحيح أو منتهي الصلاحية', 400);
		}
		const submittedHash = createHmac('sha256', otpSecret).update(`${contractBeforePayment.id}:${otpCode}`).digest();
		const storedHash = Buffer.from(otpRecord.code, 'hex');
		if (storedHash.length !== submittedHash.length || !timingSafeEqual(submittedHash, storedHash)) {
			const attempts = otpRecord.attempts + 1;
			if (attempts >= 5) await prisma.otpVerification.delete({ where: { id: otpRecord.id } });
			else await prisma.otpVerification.update({ where: { id: otpRecord.id }, data: { attempts } });
			throw new AppError(attempts >= 5 ? 'تم إبطال رمز التوقيع بعد محاولات متعددة' : 'رمز التحقق غير صحيح', 400);
		}

		// Execute all state-modifying operations inside a strict interactive transaction
		const { bidAmount, providerUserId, providerEmail, escrowAmount, projectName, clientName, userEmail } = await prisma.$transaction(async (tx) => {
			// a. Mark OTP as used
			await tx.otpVerification.delete({ where: { id: otpRecord.id } });

			// a2. Authoritative contract transition (Phase 4). Guarded on the exact
			// commercial snapshot read above (status, provider, price, terms
			// version), so a concurrent selectOffer() re-pointing the contract, or a
			// second deposit racing this one, matches zero rows and rolls back the
			// whole transaction BEFORE any wallet debit / escrow write below.
			const signatureHash = createHash('sha256')
				.update(`${contractBeforePayment.id}:${userId}:${otpRecord.id}:${contractBeforePayment.termsVersion}`)
				.digest('hex');
			const clientSigned = await tx.contract.updateMany({
				where: {
					id: contractBeforePayment.id,
					status: ContractStatus.PENDING_CLIENT_SIGNATURE,
					providerId: contractBeforePayment.providerId,
					price: contractBeforePayment.price,
					termsVersion: contractBeforePayment.termsVersion
				},
				data: {
					clientSignedAt: new Date(),
					clientSignatureHash: signatureHash,
					status: ContractStatus.PENDING_PROVIDER_SIGNATURE
				}
			});
			if (clientSigned.count !== 1) throw new AppError('تغيّر العقد أو تم توقيعه وتمويله مسبقاً — لم يتم خصم أي مبلغ', 409);

			// b. Accept Proposal and Update Project Status
			const proposal = await tx.proposal.findFirst({
				where: { id: offerId, clientRequest: { clientProfile: { userId } } },
				include: { provider: true }
			});

			let txBidAmount = 0;
			let txProviderUserId: string | null = null;
			let txProviderEmail: string | null = null;

			if (proposal) {
				txBidAmount = proposal.price;
				txProviderUserId = proposal.providerId;
				txProviderEmail = proposal.provider?.email || null;

				await tx.proposal.update({
					where: { id: proposal.id },
					data: { status: ProposalStatus.PENDING_SIGNATURE }
				});
				await tx.projectProposal.updateMany({
					where: { projectId: requestId, providerId: proposal.providerId },
					data: { status: ProposalStatus.PENDING_SIGNATURE }
				});

				// Reject all other proposals for this client request
				if (proposal.clientRequestId) {
					await tx.proposal.updateMany({
						where: {
							clientRequestId: proposal.clientRequestId,
							id: { not: proposal.id }
						},
						data: { status: 'REJECTED' }
					});
				}

				await tx.clientRequest.update({
					where: { id: proposal.clientRequestId! },
					data: { status: 'PENDING_SIGNATURE' }
				});
			} else {
				const projectProposal = await tx.projectProposal.findFirst({
					where: { id: offerId, project: { clientId: userId } },
					include: { provider: true }
				});

				if (!projectProposal) {
					throw new AppError('العرض غير موجود', 404);
				}

				txBidAmount = projectProposal.totalPrice || 0;
				txProviderUserId = projectProposal.providerId;
				txProviderEmail = projectProposal.provider?.email || null;

				await tx.projectProposal.update({
					where: { id: projectProposal.id },
					data: { status: ProposalStatus.PENDING_SIGNATURE }
				});
				await tx.proposal.updateMany({
					where: { clientRequestId: requestId, providerId: projectProposal.providerId },
					data: { status: ProposalStatus.PENDING_SIGNATURE }
				});

				// Reject all other proposals for this project
				if (projectProposal.projectId) {
					await tx.projectProposal.updateMany({
						where: {
							projectId: projectProposal.projectId,
							id: { not: projectProposal.id }
						},
						data: { status: 'REJECTED' }
					});
				}

				await tx.project.update({
					where: { id: projectProposal.projectId! },
					data: { status: 'PENDING_SIGNATURE' }
				});

				// Also sync ClientRequest table if it exists
				try {
					await tx.clientRequest.update({
						where: { id: projectProposal.projectId! },
						data: { status: 'PENDING_SIGNATURE' }
					});
				} catch (e) {
					// Ignored
				}
			}

			// c. Create Escrow Record with precise financial float conversion
			const rawEscrowAmount = contractBeforePayment.price * (1 + ESCROW_FEE_VAT + ESCROW_FEE_INSURANCE + ESCROW_FEE_PLATFORM);
			const txEscrowAmount = Math.round(rawEscrowAmount * 100) / 100;
			const walletDebit = await tx.user.updateMany({
				where: { id: userId, walletBalance: { gte: txEscrowAmount } },
				data: { walletBalance: { decrement: txEscrowAmount } }
			});
			if (walletDebit.count !== 1) {
				const wallet = await tx.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
				const available = Number(wallet?.walletBalance || 0);
				throw new AppError('رصيد المحفظة غير كافٍ لتمويل الضمان', 402, [{
					required: txEscrowAmount,
					available,
					shortfall: Math.max(0, Math.round((txEscrowAmount - available) * 100) / 100)
				}]);
			}

			const escrowReference = `ESCROW-${contractBeforePayment.id}`;
			await tx.walletTransaction.create({
				data: {
					userId,
					type: 'ESCROW_LOCK',
					amount: txEscrowAmount,
					currency: 'USD', // active contract/escrow pricing pipeline is now USD-semantic
					status: 'COMPLETED',
					paymentMethod: 'WALLET',
					referenceId: escrowReference,
					description: `حجز ضمان المشروع: ${requestId}`,
					metadata: { requestId, contractId: contractBeforePayment.id, offerId }
				}
			});

			await tx.escrow.upsert({
				where: { projectId: requestId },
				create: {
					projectId: requestId,
					amount: txEscrowAmount,
					status: 'HELD',
					paymentMethod: 'WALLET',
					paymentReference: escrowReference,
					fundedAt: new Date()
				},
				update: {
					amount: txEscrowAmount,
					status: 'HELD',
					paymentMethod: 'WALLET',
					paymentReference: escrowReference,
					fundedAt: new Date()
				}
			});

			// (Contract client-signature transition already applied, guarded, at
			// step a2 above.)

			const user = await tx.user.findUnique({ where: { id: userId } });
			const req = await tx.clientRequest.findUnique({ where: { id: requestId } }) || await tx.project.findUnique({ where: { id: requestId } });

			return {
				bidAmount: txBidAmount,
				providerUserId: txProviderUserId,
				providerEmail: txProviderEmail,
				escrowAmount: txEscrowAmount,
				projectName: req?.title || 'مشروعك',
				clientName: user?.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : 'العميل',
				userEmail: user?.email || null
			};
		});

		// 4. Send Confirmation Emails & Notifications OUTSIDE transaction block
		try {
			if (userEmail) {
				// Email to Client
				await mailTransporter.sendMail({
					from: process.env.SMTP_USER || '"وسيط AI" <noreply@waseetai.com>',
					to: userEmail,
					subject: 'تم إيداع الضمان بنجاح - وسيط AI',
					html: getDepositConfirmationTemplate(projectName, escrowAmount)
				});
			}

			if (providerEmail) {
				// Email to Provider
				await mailTransporter.sendMail({
					from: process.env.SMTP_USER || '"وسيط AI" <noreply@waseetai.com>',
					to: providerEmail,
					subject: 'دعوة لتوقيع العقد 📝 - وسيط AI',
					html: getProviderContractSignatureTemplate(projectName, clientName, bidAmount)
				});
			}

			if (providerUserId) {
				// In-App Notification to Provider
				await prisma.notification.create({
					data: {
						userId: providerUserId,
						title: `🎉 تم قبول عرضك: ${projectName}`,
						message: `قام العميل (${clientName}) بإيداع قيمة المشروع بالضمان. يرجى توقيع العقد للبدء.`,
						type: 'OFFER_ACCEPTED',
						category: 'OFFERS',
						// sign-contract resolves its offer via OffersService.getOfferById,
						// which searches GET /provider/offers — a list of CANONICAL
						// ProjectProposal ids. Phase 4: use the contract's frozen
						// canonical offer id (falls back to the submitted id only for a
						// legacy-only proposal), not the client-side legacy mirror id,
						// which that list never contains.
						actionUrl: `/provider-overview/offers/${contractBeforePayment.offerId || offerId}/sign-contract`,
						actionText: 'عرض وتوقيع العقد',
						metadata: { offerId: contractBeforePayment.offerId || offerId, requestId }
					}
				});
			}
		} catch (err) {
			console.error('Failed to send deposit confirmation email or notifications:', err);
		}

		return { success: true };
	}
}

export const clientRequestsService = new ClientRequestsService();
