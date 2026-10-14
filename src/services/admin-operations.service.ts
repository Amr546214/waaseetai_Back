import { ContractStatus, DisputeStatus, Prisma, ProjectStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { heldEscrowAmount } from './dispute.service';
import { adminAudit } from './admin-audit.service';
import { adminSettlementFor, adminSettledView, settlementsByProject, stageDisplayStatus, SETTLED_LABEL_AR, SETTLED_DISPUTE_WHERE } from './settlement-state.service';

const settledProjectWhere = { disputes: { some: SETTLED_DISPUTE_WHERE } } as const;

/**
 * Read-only admin view of projects, contracts and their escrow. Every number comes from the database; the escrow status is Escrow.status as stored
 * (HELD / RELEASED / REFUNDED). There is deliberately NO release / hold / refund action here: the fee-policy documents do not define refund or manual
 * release semantics, so those stay a product decision (the UI shows them disabled with that reason). Money only moves through the stage-approval flow.
 */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const fullName = (u?: { firstName?: string | null; lastName?: string | null } | null) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
const party = (u?: { id: string; firstName?: string | null; lastName?: string | null; email?: string | null } | null) => (u ? { id: u.id, name: fullName(u), email: u.email ?? null } : null);

const USER_SELECT = { id: true, firstName: true, lastName: true, email: true } as const;

const escrowView = (escrow: any, price: number | null | undefined) =>
	escrow
		? { status: escrow.status as string, amount: escrow.amount as number, releasedAmount: escrow.releasedAmount as number, heldAmount: heldEscrowAmount(escrow, price), fundedAt: escrow.fundedAt ?? null, platformCommissionAmount: escrow.platformCommissionAmount ?? 0, providerNetReleasedAmount: escrow.providerNetReleasedAmount ?? 0, feePolicyVersion: escrow.feePolicyVersion ?? null }
		: null;

const progressOf = (stages: { status: string }[] | undefined) => {
	const total = stages?.length ?? 0;
	if (!total) return { totalStages: 0, approvedStages: 0, percent: 0 };
	const approvedStages = stages!.filter(s => s.status === 'APPROVED').length;
	return { totalStages: total, approvedStages, percent: Math.round((approvedStages / total) * 100) };
};

const page = (n: number | undefined, limit: number | undefined) => ({ safePage: Math.max(1, n || 1), safeLimit: Math.min(100, Math.max(1, limit || 20)) });

export class AdminOperationsService {
	async listProjects(filters: { status?: ProjectStatus; q?: string }, pageNo?: number, limit?: number) {
		const { safePage, safeLimit } = page(pageNo, limit);
		const q = filters.q?.trim();
		const where: Prisma.ProjectWhereInput = {
			...(filters.status ? { status: filters.status } : {}),
			...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { client: { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }] } }] } : {})
		};
		const [items, total, grouped, activeEscrows] = await Promise.all([
			prisma.project.findMany({
				where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit,
				select: {
					id: true, title: true, status: true, createdAt: true, deliveryDays: true,
					client: { select: USER_SELECT }, provider: { select: USER_SELECT },
					escrow: true,
					contract: { select: { id: true, price: true, status: true, stages: { select: { status: true } } } }
				}
			}),
			prisma.project.count({ where }),
			prisma.project.groupBy({ by: ['status'], _count: { _all: true } }),
			prisma.escrow.aggregate({ where: { status: 'HELD' }, _sum: { amount: true, releasedAmount: true }, _count: { _all: true } })
		]);
		const counts: Record<string, number> = {};
		for (const g of grouped) counts[g.status] = g._count._all;
		// Closed by a dispute settlement is its own bucket: it is not counted as a delivery-completed project.
		const settledView = await settlementsByProject(items.map(p => p.id));
		const settledCompleted = await prisma.project.count({ where: { status: ProjectStatus.COMPLETED, ...settledProjectWhere } });
		if (counts.COMPLETED !== undefined) counts.COMPLETED = Math.max(0, counts.COMPLETED - settledCompleted);
		counts.CLOSED_BY_SETTLEMENT = settledCompleted;
		const pages = Math.ceil(total / safeLimit);
		return {
			items: items.map(p => ({
				adminSettled: settledView.get(p.id) ?? null, statusLabel: settledView.has(p.id) ? SETTLED_LABEL_AR : null,
				id: p.id, title: p.title, status: p.status, createdAt: p.createdAt, deliveryDays: p.deliveryDays,
				client: party(p.client), provider: party(p.provider),
				contract: p.contract ? { id: p.contract.id, price: p.contract.price, status: p.contract.status } : null,
				escrow: escrowView(p.escrow, p.contract?.price),
				progress: progressOf(p.contract?.stages)
			})),
			counts,
			kpis: { escrowHeldCount: activeEscrows._count._all, escrowHeldTotal: round2((activeEscrows._sum.amount ?? 0) - (activeEscrows._sum.releasedAmount ?? 0)), currency: 'USD' },
			pagination: { page: safePage, limit: safeLimit, total, pages, totalPages: pages }
		};
	}

	async getProject(id: string) {
		const project = await prisma.project.findUnique({
			where: { id },
			include: {
				client: { select: USER_SELECT }, provider: { select: USER_SELECT }, escrow: true,
				contract: { include: { stages: { orderBy: { stepOrder: 'asc' }, include: { deliveries: { orderBy: { submittedAt: 'desc' } } } }, amendments: { orderBy: { createdAt: 'desc' }, select: { id: true, title: true, type: true, status: true, budgetDelta: true, durationDeltaDays: true, createdAt: true } } } }
			}
		});
		if (!project) throw new AppError('المشروع غير موجود', 404);
		const disputes = await prisma.dispute.findMany({ where: { OR: [{ projectId: id }, { requestId: id }] }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, reason: true, createdAt: true, resolvedAt: true } });
		const contract = project.contract;
		const settlement = await adminSettlementFor({ projectId: id });
		return {
			adminSettled: adminSettledView(settlement), statusLabel: settlement.settled ? SETTLED_LABEL_AR : null,
			id: project.id, title: project.title, description: project.description, status: project.status, createdAt: project.createdAt, deliveryDays: project.deliveryDays, specialty: project.specialty,
			client: party(project.client), provider: party(project.provider),
			contract: contract ? { id: contract.id, price: contract.price, status: contract.status, durationDays: contract.durationDays, signedAt: contract.signedAt, clientSignedAt: contract.clientSignedAt, providerSignedAt: contract.providerSignedAt } : null,
			escrow: escrowView(project.escrow, contract?.price),
			stages: (contract?.stages ?? []).map(s => ({ ...stageDisplayStatus(s.status, settlement.settled), id: s.id, stepOrder: s.stepOrder, title: s.title, amount: s.amount, percentage: s.percentage, days: s.days, status: s.status, startedAt: s.startedAt, approvedAt: s.approvedAt, deliveries: s.deliveries.map(d => ({ id: d.id, status: d.status, note: d.note, files: d.files, reviewNote: d.reviewNote, submittedAt: d.submittedAt, reviewedAt: d.reviewedAt })) })),
			amendments: contract?.amendments ?? [],
			progress: progressOf(contract?.stages),
			disputes,
			openDisputes: disputes.filter(d => d.status === DisputeStatus.OPEN || d.status === DisputeStatus.UNDER_REVIEW).length,
			currency: 'USD'
		};
	}

	async listContracts(filters: { status?: ContractStatus; q?: string }, pageNo?: number, limit?: number) {
		const { safePage, safeLimit } = page(pageNo, limit);
		const q = filters.q?.trim();
		const where: Prisma.ContractWhereInput = {
			...(filters.status ? { status: filters.status } : {}),
			...(q ? { OR: [{ project: { title: { contains: q, mode: 'insensitive' } } }, { id: { contains: q, mode: 'insensitive' } }] } : {})
		};
		const [items, total, grouped, priceAgg] = await Promise.all([
			prisma.contract.findMany({
				where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit,
				select: { id: true, projectId: true, price: true, durationDays: true, status: true, signedAt: true, createdAt: true, client: { select: USER_SELECT }, provider: { select: USER_SELECT }, project: { select: { title: true, escrow: true } } }
			}),
			prisma.contract.count({ where }),
			prisma.contract.groupBy({ by: ['status'], _count: { _all: true } }),
			prisma.contract.aggregate({ where: { status: { in: [ContractStatus.ACTIVE, ContractStatus.DISPUTED] } }, _sum: { price: true } })
		]);
		const counts: Record<string, number> = {};
		for (const g of grouped) counts[g.status] = g._count._all;
		const pages = Math.ceil(total / safeLimit);
		return {
			items: items.map(c => ({ id: c.id, projectId: c.projectId, projectTitle: c.project?.title ?? '', price: c.price, durationDays: c.durationDays, status: c.status, signedAt: c.signedAt, createdAt: c.createdAt, client: party(c.client), provider: party(c.provider), escrow: escrowView(c.project?.escrow, c.price) })),
			counts,
			kpis: { activeContractsValue: round2(priceAgg._sum.price ?? 0), currency: 'USD' },
			pagination: { page: safePage, limit: safeLimit, total, pages, totalPages: pages }
		};
	}

	async getContract(id: string) {
		const contract = await prisma.contract.findUnique({ where: { id }, select: { projectId: true } });
		if (!contract) throw new AppError('العقد غير موجود', 404);
		const [project, full] = await Promise.all([
			this.getProject(contract.projectId),
			prisma.contract.findUnique({ where: { id }, select: { terms: true, termsVersion: true, phasesCount: true, clientSignatureHash: true, providerSignatureHash: true } })
		]);
		return { ...project, contractId: id, terms: full?.terms ?? null, termsVersion: full?.termsVersion ?? null, phasesCount: full?.phasesCount ?? null, signatures: { client: !!full?.clientSignatureHash, provider: !!full?.providerSignatureHash } };
	}

	/** Admin staff the disputes / tickets can be assigned to. */
	async listStaff() {
		const users = await prisma.user.findMany({ where: { accountType: { in: ['ADMIN', 'SUPER_ADMIN'] } }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, lastName: true, email: true, accountType: true } });
		return users.map(u => ({ id: u.id, name: fullName(u) || u.email, email: u.email, accountType: u.accountType }));
	}

	/** Audit trail of everything an admin did on one project / contract / escrow (empty today: this area is read-only). */
	async auditFor(entity: 'PROJECT' | 'CONTRACT' | 'ESCROW', id: string) {
		return adminAudit.listForEntity(entity, id);
	}
}

export const adminOperationsService = new AdminOperationsService();
