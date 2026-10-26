import { DisputeStatus, Prisma, ProposalStatus, RequestStatus } from '@prisma/client';
import { LEGACY_CURRENCY } from '../utils/currency';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { NEG_PREFIX, deriveNegotiationState, readNegotiationEntries } from '../utils/offer-negotiation';

// Admin read side of client requests (ClientRequest, mirrored 1:1 by a Project with the same id) and of the offers on them (ProjectProposal, the
// canonical offer). Read-only: every number and status comes from the rows; the AI fields are shown only when they are really stored on the row
// (a request's executive summary comes from the WaseetAI project-analysis call, an offer's score/tags from the offer AI review) and are null otherwise.

const OPEN_DISPUTE: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW];
const SHOWN_OFFER_STATUSES: ProposalStatus[] = [ProposalStatus.PENDING_SIGNATURE, ProposalStatus.IN_AI_REVIEW, ProposalStatus.SUBMITTED, ProposalStatus.UNDER_NEGOTIATION, ProposalStatus.ACCEPTED, ProposalStatus.REJECTED, ProposalStatus.CANCELLED];

const pageOf = (raw: unknown) => Math.max(1, Math.floor(Number(raw)) || 1);
const limitOf = (raw: unknown, def = 20) => Math.min(100, Math.max(1, Math.floor(Number(raw)) || def));
const fullName = (u?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null) => `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || u?.email || null;
const personSelect = { id: true, firstName: true, lastName: true, email: true, accountType: true, createdAt: true, ratingAverage: true, completedProjectsCount: true, tierLevel: true } as const;
const person = (u: any) => (u ? { userId: u.id, name: fullName(u), email: u.email ?? null, accountType: u.accountType ?? null, memberSince: u.createdAt ?? null, rating: u.ratingAverage ?? null, completedProjects: u.completedProjectsCount ?? 0 } : null);

function requestWhere(params: { status?: string; search?: string }): Prisma.ClientRequestWhereInput {
	const where: Prisma.ClientRequestWhereInput = {};
	const wanted = String(params.status ?? '').toUpperCase();
	if (wanted === 'DISPUTED') where.disputes = { some: { status: { in: OPEN_DISPUTE } } };
	else if (wanted && wanted !== 'ALL') {
		if (!(wanted in RequestStatus)) throw new AppError('حالة الطلب غير صحيحة', 400);
		where.status = wanted as RequestStatus;
	}
	const term = String(params.search ?? '').trim().slice(0, 100);
	if (term) where.OR = [
		{ title: { contains: term, mode: 'insensitive' } },
		{ clientProfile: { user: { email: { contains: term, mode: 'insensitive' } } } },
		{ clientProfile: { user: { firstName: { contains: term, mode: 'insensitive' } } } },
		{ clientProfile: { user: { lastName: { contains: term, mode: 'insensitive' } } } }
	];
	return where;
}

export class AdminRequestsService {
	async listRequests(params: { status?: string; search?: string; page?: number; limit?: number }) {
		const page = pageOf(params.page), limit = limitOf(params.limit);
		const where = requestWhere(params);
		const [rows, total, groups, disputed] = await Promise.all([
			prisma.clientRequest.findMany({
				where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
				select: {
					id: true, title: true, status: true, budgetType: true, minBudget: true, maxBudget: true, expectedDurationDays: true, createdAt: true,
					specialty: { select: { id: true, nameAr: true } },
					clientProfile: { select: { user: { select: personSelect } } },
					disputes: { where: { status: { in: OPEN_DISPUTE } }, select: { id: true } }
				}
			}),
			prisma.clientRequest.count({ where }),
			prisma.clientRequest.groupBy({ by: ['status'], _count: { _all: true } }),
			prisma.clientRequest.count({ where: { disputes: { some: { status: { in: OPEN_DISPUTE } } } } })
		]);
		const ids = rows.map(r => r.id);
		const [offerGroups, projects, contracts] = ids.length ? await Promise.all([
			prisma.projectProposal.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, status: { in: SHOWN_OFFER_STATUSES } }, _count: { _all: true } }),
			prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }),
			prisma.contract.findMany({ where: { projectId: { in: ids } }, select: { projectId: true, status: true } })
		]) : [[], [], []];
		const offersBy = new Map<string, number>((offerGroups as any[]).map(g => [g.projectId, g._count._all]));
		const projectBy = new Map<string, string>((projects as any[]).map(p => [p.id, p.status]));
		const contractBy = new Map<string, string>((contracts as any[]).map(c => [c.projectId, c.status]));

		const counts: Record<string, number> = { all: 0, disputed };
		for (const g of groups) { counts[g.status] = g._count._all; counts.all += g._count._all; }
		return {
			items: rows.map(r => ({
				id: r.id, title: r.title, status: r.status, projectStatus: projectBy.get(r.id) ?? null, contractStatus: contractBy.get(r.id) ?? null,
				client: person((r as any).clientProfile?.user), specialty: r.specialty?.nameAr ?? null,
				budget: { type: r.budgetType, min: r.minBudget, max: r.maxBudget, currency: ((r as { currency?: string | null }).currency ?? LEGACY_CURRENCY) as string }, durationDays: r.expectedDurationDays,
				offersCount: offersBy.get(r.id) ?? 0, openDisputes: r.disputes.length, createdAt: r.createdAt
			})),
			pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
			counts
		};
	}

	async getRequest(id: string) {
		const r: any = await prisma.clientRequest.findUnique({
			where: { id },
			select: {
				id: true, title: true, description: true, status: true, subSpecialties: true, requiredSkills: true, budgetType: true, minBudget: true, maxBudget: true, expectedDurationDays: true,
				preferredProviderType: true, requiresNda: true, outputs: true, customConditions: true, ipRights: true, allowNegotiation: true, splitMilestones: true, attachments: true,
				aiAnalyzedSummary: true, aiComplexityRating: true, createdAt: true, updatedAt: true,
				specialty: { select: { id: true, nameAr: true } },
				clientProfile: { select: { kycStatus: true, user: { select: personSelect } } },
				disputes: { orderBy: { createdAt: 'desc' }, select: { id: true, reason: true, status: true, createdAt: true } }
			}
		});
		if (!r) throw new AppError('الطلب غير موجود', 404);
		const [project, contract, offers] = await Promise.all([
			prisma.project.findUnique({ where: { id }, select: { id: true, status: true, providerId: true, escrow: { select: { status: true, amount: true, fundedAt: true } } } }),
			prisma.contract.findUnique({ where: { projectId: id }, select: { id: true, status: true, price: true, durationDays: true, clientSignedAt: true, providerSignedAt: true, createdAt: true, providerId: true } }),
			prisma.projectProposal.findMany({
				where: { projectId: id, status: { in: SHOWN_OFFER_STATUSES } }, orderBy: { createdAt: 'desc' },
				select: { id: true, status: true, totalPrice: true, deliveryDays: true, aiMatchScore: true, aiQualityTag: true, aiPriceTag: true, createdAt: true, provider: { select: personSelect } }
			})
		]);

		const timeline: Array<{ at: Date; text: string }> = [{ at: r.createdAt, text: 'أنشأ العميل الطلب' }];
		for (const o of offers as any[]) timeline.push({ at: o.createdAt, text: `وصل عرض من ${fullName(o.provider) ?? 'مقدم خدمة'}` });
		if (contract) {
			timeline.push({ at: contract.createdAt, text: 'أُنشئ العقد' });
			if (contract.clientSignedAt) timeline.push({ at: contract.clientSignedAt, text: 'وقّع العميل العقد' });
			if (contract.providerSignedAt) timeline.push({ at: contract.providerSignedAt, text: 'وقّع مقدم الخدمة العقد' });
		}
		if (project?.escrow?.fundedAt) timeline.push({ at: project.escrow.fundedAt, text: 'مُوّل الضمان' });
		for (const d of r.disputes) timeline.push({ at: d.createdAt, text: `فُتح نزاع: ${d.reason}` });
		timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

		return {
			id: r.id, title: r.title, description: r.description, status: r.status, projectStatus: project?.status ?? null,
			specialty: r.specialty?.nameAr ?? null, subSpecialties: r.subSpecialties, requiredSkills: r.requiredSkills,
			budget: { type: r.budgetType, min: r.minBudget, max: r.maxBudget, currency: ((r as { currency?: string | null }).currency ?? LEGACY_CURRENCY) as string }, durationDays: r.expectedDurationDays,
			conditions: { preferredProviderType: r.preferredProviderType, requiresNda: r.requiresNda, ipRights: r.ipRights, allowNegotiation: r.allowNegotiation, splitMilestones: r.splitMilestones, outputs: r.outputs, customConditions: r.customConditions },
			attachmentsCount: Array.isArray(r.attachments) ? r.attachments.length : 0,
			// stored only when the WaseetAI analysis call succeeded at creation; null otherwise
			aiAnalysis: r.aiAnalyzedSummary ? { source: 'WASEET_AI', summary: r.aiAnalyzedSummary, complexity: r.aiComplexityRating ?? null } : null,
			client: { ...person(r.clientProfile?.user), kycStatus: r.clientProfile?.kycStatus ?? null },
			contract: contract ? { id: contract.id, status: contract.status, price: contract.price, durationDays: contract.durationDays, clientSignedAt: contract.clientSignedAt, providerSignedAt: contract.providerSignedAt } : null,
			escrow: project?.escrow ? { status: project.escrow.status, amount: project.escrow.amount, fundedAt: project.escrow.fundedAt } : null,
			offers: (offers as any[]).map(o => ({ id: o.id, status: o.status, price: o.totalPrice, deliveryDays: o.deliveryDays, aiMatchScore: o.aiMatchScore, aiQualityTag: o.aiQualityTag, aiPriceTag: o.aiPriceTag, createdAt: o.createdAt, accepted: o.status === ProposalStatus.ACCEPTED, provider: person(o.provider) })),
			disputes: r.disputes,
			timeline, createdAt: r.createdAt, updatedAt: r.updatedAt
		};
	}

	async listOffers(params: { status?: string; search?: string; page?: number; limit?: number }) {
		const page = pageOf(params.page), limit = limitOf(params.limit);
		const where: Prisma.ProjectProposalWhereInput = { status: { in: SHOWN_OFFER_STATUSES } };
		const wanted = String(params.status ?? '').toUpperCase();
		if (wanted && wanted !== 'ALL') {
			if (!SHOWN_OFFER_STATUSES.includes(wanted as ProposalStatus)) throw new AppError('حالة العرض غير صحيحة', 400);
			where.status = wanted as ProposalStatus;
		}
		const term = String(params.search ?? '').trim().slice(0, 100);
		if (term) where.OR = [
			{ title: { contains: term, mode: 'insensitive' } },
			{ project: { title: { contains: term, mode: 'insensitive' } } },
			{ provider: { email: { contains: term, mode: 'insensitive' } } },
			{ provider: { firstName: { contains: term, mode: 'insensitive' } } },
			{ provider: { lastName: { contains: term, mode: 'insensitive' } } }
		];
		const [rows, total, groups] = await Promise.all([
			prisma.projectProposal.findMany({
				where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
				select: { id: true, projectId: true, title: true, status: true, totalPrice: true, deliveryDays: true, aiMatchScore: true, aiQualityTag: true, aiPriceTag: true, createdAt: true, provider: { select: personSelect }, project: { select: { title: true, client: { select: personSelect } } } }
			}),
			prisma.projectProposal.count({ where }),
			prisma.projectProposal.groupBy({ by: ['status'], where: { status: { in: SHOWN_OFFER_STATUSES } }, _count: { _all: true } })
		]);
		const counts: Record<string, number> = { all: 0 };
		for (const g of groups) { counts[g.status] = g._count._all; counts.all += g._count._all; }
		return {
			items: (rows as any[]).map(o => ({ id: o.id, requestId: o.projectId, requestTitle: o.project?.title ?? null, title: o.title, status: o.status, price: o.totalPrice, deliveryDays: o.deliveryDays, aiMatchScore: o.aiMatchScore, aiQualityTag: o.aiQualityTag, aiPriceTag: o.aiPriceTag, createdAt: o.createdAt, currency: (o.currency ?? o.project?.currency ?? LEGACY_CURRENCY) as string, provider: person(o.provider), client: person(o.project?.client) })),
			pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
			counts
		};
	}

	async getOffer(id: string) {
		const o: any = await prisma.projectProposal.findUnique({
			where: { id },
			select: {
				id: true, projectId: true, title: true, message: true, advantages: true, outputs: true, totalPrice: true, deliveryDays: true, status: true, aiMatchScore: true, aiQualityTag: true, aiPriceTag: true, aiFeedback: true,
				agreedToTerms: true, agreedToEscrow: true, createdAt: true, updatedAt: true, providerId: true,
				milestones: { orderBy: { stepOrder: 'asc' }, select: { id: true, stepOrder: true, title: true, description: true, days: true, percentage: true, amount: true } },
				provider: { select: personSelect },
				project: { select: { id: true, title: true, status: true, client: { select: personSelect } } }
			}
		});
		if (!o) throw new AppError('العرض غير موجود', 404);
		const [contract, messages] = await Promise.all([
			prisma.contract.findUnique({ where: { projectId: o.projectId }, select: { id: true, status: true, price: true, providerId: true, offerId: true } }),
			prisma.message.findMany({ where: { content: { startsWith: NEG_PREFIX }, conversation: { projectId: o.projectId, providerId: o.providerId } }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, senderId: true, content: true, createdAt: true } })
		]);
		const entries = readNegotiationEntries(messages as any[], o.providerId);
		const state = deriveNegotiationState(entries, o.id);
		const relevant = entries.filter(e => e.kind === 'CLIENT_REQUEST' || e.offerId === o.id);
		const ai = o.aiFeedback && typeof o.aiFeedback === 'object' ? o.aiFeedback : null;
		return {
			id: o.id, requestId: o.projectId, requestTitle: o.project?.title ?? null, requestStatus: o.project?.status ?? null, title: o.title, message: o.message, advantages: o.advantages, outputs: o.outputs,
			price: o.totalPrice, deliveryDays: o.deliveryDays, currency: (o.currency ?? o.project?.currency ?? LEGACY_CURRENCY) as string, status: o.status, agreedToTerms: o.agreedToTerms, agreedToEscrow: o.agreedToEscrow,
			// real fields of the offer's AI review; each is null when no review produced it
			aiReview: o.aiMatchScore != null || o.aiQualityTag || o.aiPriceTag || ai ? { matchScore: o.aiMatchScore, qualityTag: o.aiQualityTag, priceTag: o.aiPriceTag, feedback: ai } : null,
			milestones: o.milestones, provider: person(o.provider), client: person(o.project?.client),
			contract: contract && contract.providerId === o.providerId ? { id: contract.id, status: contract.status, price: contract.price } : null,
			negotiation: {
				state: state.counterPending ? 'COUNTER_PENDING' : state.openRequest ? 'REQUEST_SENT' : 'NONE',
				entriesCount: relevant.length,
				entries: relevant.slice(0, 20).map(e => ({ kind: e.kind, price: e.price, deliveryDays: e.deliveryDays, notes: e.notes, createdAt: e.createdAt }))
			},
			createdAt: o.createdAt, updatedAt: o.updatedAt
		};
	}
}

export const adminRequestsService = new AdminRequestsService();
