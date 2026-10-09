import { prisma } from '../config/db';

// Batch (client reports real-data fix): the client-overview "تقاريري" page was
// entirely hardcoded markup (no data binding at all). This service replaces
// every number/list on that page with a real, derived-from-the-database
// equivalent, reusing the same status/spend conventions already established
// in dashboard.service.ts (getClientStats) and client-requests.service.ts
// (getMyRequests) rather than inventing new ones.

export type ReportDateRange = 'month' | '3m' | '6m' | 'year' | 'all';

function rangeStart(range: ReportDateRange): Date | undefined {
	const now = new Date();
	switch (range) {
		case 'month': return new Date(now.getFullYear(), now.getMonth(), 1);
		case '3m': return new Date(now.getFullYear(), now.getMonth() - 2, 1);
		case '6m': return new Date(now.getFullYear(), now.getMonth() - 5, 1);
		case 'year': return new Date(now.getFullYear(), 0, 1);
		case 'all': return undefined;
	}
}

function startOfThisMonth(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

// Mirrors the same "budget of a completed engagement" convention used by
// dashboard.service.ts#getClientStats (Project.budgetFixed, falling back to
// budgetMax) — applied here to both ClientRequest and Project rows.
function effectiveBudget(row: { minBudget?: number | null; maxBudget?: number | null; budgetFixed?: number | null; budgetMax?: number | null; budgetMin?: number | null }): number {
	return row.budgetFixed || row.maxBudget || row.budgetMax || row.minBudget || row.budgetMin || 0;
}

// Requester-facing status bucket, derived only from enum values that actually
// exist on RequestStatus/ProjectStatus — no invented intermediate states.
function statusBucket(status: string): 'مكتمل' | 'ملغي' | 'نشط' | 'منشور' {
	const s = String(status || '').toUpperCase();
	if (s === 'COMPLETED') return 'مكتمل';
	if (s === 'CANCELLED') return 'ملغي';
	if (['IN_PROGRESS', 'AWAITING_DELIVERY', 'PENDING_APPROVAL', 'PENDING_REVIEW', 'DISPUTED'].includes(s)) return 'نشط';
	return 'منشور'; // OPEN / DRAFT / PENDING_SIGNATURE — published, awaiting a proposal
}

export class ClientReportsService {
	public async getReports(userId: string, range: ReportDateRange = 'month') {
		const since = rangeStart(range);
		const monthStart = startOfThisMonth();

		const clientProfile = await prisma.clientProfile.findUnique({ where: { userId } });

		const [clientRequests, projects, reviews, disputes, walletTransactions, escrowSum] = await Promise.all([
			clientProfile
				? prisma.clientRequest.findMany({
					where: { clientProfileId: clientProfile.id, ...(since ? { createdAt: { gte: since } } : {}) },
					include: { specialty: true, proposals: { select: { status: true } } },
					orderBy: { createdAt: 'desc' }
				})
				: Promise.resolve([] as any[]),
			prisma.project.findMany({
				where: { clientId: userId, ...(since ? { createdAt: { gte: since } } : {}) },
				include: { proposals: { select: { status: true } }, contract: { select: { durationDays: true } } },
				orderBy: { createdAt: 'desc' }
			}),
			prisma.review.findMany({ where: { clientId: userId }, select: { rating: true, createdAt: true } }),
			prisma.dispute.findMany({
				where: { OR: [{ openedById: userId }, { againstUserId: userId }], ...(since ? { createdAt: { gte: since } } : {}) },
				select: { id: true, status: true, reason: true, createdAt: true, resolvedAt: true },
				orderBy: { createdAt: 'desc' }
			}),
			prisma.walletTransaction.findMany({
				where: { userId, ...(since ? { createdAt: { gte: since } } : {}) },
				// currency: each WalletTransaction keeps its OWN stored currency — exposed so the UI never relabels it.
				select: { id: true, type: true, amount: true, currency: true, status: true, description: true, createdAt: true },
				orderBy: { createdAt: 'desc' },
				take: 50
			}),
			prisma.escrow.aggregate({
				where: { project: { clientId: userId }, status: 'HELD' },
				_sum: { amount: true }
			})
		]);

		// ── Unified order list (ClientRequest + Project, same merge rule as
		// client-requests.service.ts#getMyRequests) ──────────────────────────
		type OrderRow = {
			id: string; title: string; specialty: string; budget: number;
			proposalsCount: number; status: string; bucket: ReturnType<typeof statusBucket>;
			createdAt: Date; accepted: boolean;
		};

		const orders: OrderRow[] = clientRequests.map((r: any) => ({
			id: r.id,
			title: r.title,
			specialty: r.specialty?.nameAr || r.specialty?.name || 'عام',
			budget: effectiveBudget(r),
			proposalsCount: r.proposals?.length ?? r.proposalsCount ?? 0,
			status: r.status,
			bucket: statusBucket(r.status),
			createdAt: r.createdAt,
			accepted: (r.proposals || []).some((p: any) => p.status === 'ACCEPTED') || r.status === 'COMPLETED' || r.status === 'IN_PROGRESS'
		}));

		for (const p of projects as any[]) {
			if (orders.some(o => o.id === p.id)) continue;
			orders.push({
				id: p.id,
				title: p.title,
				specialty: p.specialty || 'عام',
				budget: effectiveBudget(p),
				proposalsCount: p.proposalsCount ?? p.proposals?.length ?? 0,
				status: p.status,
				bucket: statusBucket(p.status),
				createdAt: p.createdAt,
				accepted: !!p.providerId
			});
		}
		orders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		// ── KPIs ──────────────────────────────────────────────────────────────
		const totalRequests = orders.length;
		const requestsThisMonth = orders.filter(o => o.createdAt >= monthStart).length;

		const completedProjects = orders.filter(o => o.bucket === 'مكتمل');
		const completedThisMonth = completedProjects.filter(o => o.createdAt >= monthStart).length;

		const totalSpent = completedProjects.reduce((sum, o) => sum + o.budget, 0);

		const avgRating = reviews.length
			? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10
			: 0;
		const ratingLastMonth = (() => {
			const prior = reviews.filter(r => r.createdAt < monthStart);
			if (!prior.length) return null;
			return Math.round((prior.reduce((s, r) => s + r.rating, 0) / prior.length) * 10) / 10;
		})();

		// ── Orders tab: status distribution + per-specialty acceptance rate ───
		const statusDistribution: Record<string, number> = { 'منشور': 0, 'مكتمل': 0, 'نشط': 0, 'ملغي': 0 };
		for (const o of orders) statusDistribution[o.bucket]++;

		const bySpecialty = new Map<string, { total: number; accepted: number }>();
		for (const o of orders) {
			const cur = bySpecialty.get(o.specialty) || { total: 0, accepted: 0 };
			cur.total++;
			if (o.accepted) cur.accepted++;
			bySpecialty.set(o.specialty, cur);
		}
		const acceptanceBySpecialty = Array.from(bySpecialty.entries())
			.map(([specialty, v]) => ({ specialty, rate: v.total ? Math.round((v.accepted / v.total) * 100) : 0, total: v.total }))
			.sort((a, b) => b.rate - a.rate)
			.slice(0, 6);

		// ── Projects tab ────────────────────────────────────────────────────
		const activeProjects = orders.filter(o => o.bucket === 'نشط');
		const projectDurations = (projects as any[])
			.filter(p => p.status === 'COMPLETED')
			.map(p => {
				const days = Math.max(1, Math.round((p.updatedAt.getTime() - p.createdAt.getTime()) / 86400000));
				const agreed = p.contract?.durationDays || p.deliveryDays || days;
				return { days, onTime: days <= agreed };
			});
		const avgDurationDays = projectDurations.length
			? Math.round(projectDurations.reduce((s, d) => s + d.days, 0) / projectDurations.length)
			: 0;
		const completedOnTime = projectDurations.filter(d => d.onTime).length;

		// ── Finance tab ─────────────────────────────────────────────────────
		const escrowHeld = escrowSum._sum.amount || 0;

		// ── Disputes tab ────────────────────────────────────────────────────
		const disputeCounts = {
			all: disputes.length,
			open: disputes.filter(d => d.status === 'OPEN' || d.status === 'UNDER_REVIEW').length,
			resolved: disputes.filter(d => d.status === 'RESOLVED').length,
			rejected: disputes.filter(d => d.status === 'REJECTED').length
		};

		return {
			kpis: {
				totalRequests,
				requestsDeltaThisMonth: requestsThisMonth,
				completedProjectsCount: completedProjects.length,
				completedDeltaThisMonth: completedThisMonth,
				totalSpent,
				avgRating,
				// additive: lets callers tell "no reviews" (avgRating 0) from a real rating, so AI features never treat 0 as data.
				reviewsCount: reviews.length,
				ratingDelta: ratingLastMonth === null ? 0 : Math.round((avgRating - ratingLastMonth) * 10) / 10
			},
			orders: {
				items: orders.map(o => ({
					id: o.id, title: o.title, specialty: o.specialty, budget: o.budget,
					proposalsCount: o.proposalsCount, status: o.status, bucket: o.bucket, createdAt: o.createdAt
				})),
				statusDistribution,
				acceptanceBySpecialty,
				counts: {
					all: orders.length,
					active: orders.filter(o => o.bucket === 'نشط').length,
					completed: completedProjects.length,
					published: statusDistribution['منشور'],
					cancelled: statusDistribution['ملغي']
				}
			},
			projects: {
				activeCount: activeProjects.length,
				completedCount: completedProjects.length,
				completedOnTime,
				completedTotal: projectDurations.length,
				avgDurationDays,
				avgRating
			},
			finance: {
				totalSpent,
				escrowHeld,
				transactions: walletTransactions
			},
			disputes: {
				items: disputes,
				counts: disputeCounts
			}
		};
	}
}

export const clientReportsService = new ClientReportsService();
