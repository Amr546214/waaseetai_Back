import { prisma } from '../config/db';
import { ReportDateRange } from './client-reports.service';

// BE-2(a): provider-side "تقاريري". Same conventions as client-reports.service.ts, applied to the provider's own rows.
// Nothing here is invented: a figure with no source is null (never 0 pretending to be data) and lists are empty.

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

export type OfferBucket = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export function offerBucket(status: string): OfferBucket {
	const s = String(status || '').toUpperCase();
	if (s === 'ACCEPTED') return 'accepted';
	if (s === 'REJECTED') return 'rejected';
	if (s === 'CANCELLED') return 'cancelled';
	return 'pending'; // PENDING / DRAFT / PENDING_SIGNATURE / IN_AI_REVIEW / SUBMITTED / UNDER_NEGOTIATION
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

export class ProviderReportsService {
	public async getReports(providerId: string, range: ReportDateRange = 'month') {
		const since = rangeStart(range);
		const inRange = since ? { createdAt: { gte: since } } : {};

		const [proposals, projects, disputes, releasedAgg, heldAgg, transactions] = await Promise.all([
			prisma.proposal.findMany({
				where: { providerId, ...inRange },
				select: {
					id: true, price: true, status: true, createdAt: true,
					project: { select: { title: true, specialty: true } },
					clientRequest: { select: { title: true, specialty: { select: { nameAr: true, name: true } } } }
				},
				orderBy: { createdAt: 'desc' }
			}),
			prisma.project.findMany({
				where: { providerId, ...inRange },
				select: { id: true, title: true, status: true, createdAt: true, updatedAt: true, deliveryDays: true, contract: { select: { durationDays: true } } },
				orderBy: { createdAt: 'desc' }
			}),
			prisma.dispute.findMany({
				where: { OR: [{ openedById: providerId }, { againstUserId: providerId }], ...inRange },
				select: { id: true, status: true, reason: true, createdAt: true, resolvedAt: true },
				orderBy: { createdAt: 'desc' }
			}),
			prisma.escrow.aggregate({ where: { project: { providerId, ...inRange } }, _sum: { releasedAmount: true } }),
			prisma.escrow.aggregate({ where: { project: { providerId }, status: 'HELD' }, _sum: { amount: true } }),
			prisma.walletTransaction.findMany({
				where: { userId: providerId, ...inRange },
				// each transaction keeps its OWN stored currency; the UI must not relabel it
				select: { id: true, type: true, amount: true, currency: true, status: true, description: true, createdAt: true },
				orderBy: { createdAt: 'desc' },
				take: 50
			})
		]);

		// ── incoming requests / offers and their statuses ────────────────────
		const items = (proposals as any[]).map(p => ({
			id: p.id,
			title: p.project?.title ?? p.clientRequest?.title ?? null,
			specialty: p.project?.specialty ?? p.clientRequest?.specialty?.nameAr ?? p.clientRequest?.specialty?.name ?? null,
			price: p.price,
			status: p.status,
			bucket: offerBucket(p.status),
			createdAt: p.createdAt
		}));
		const byStatus: Record<OfferBucket, number> = { pending: 0, accepted: 0, rejected: 0, cancelled: 0 };
		for (const o of items) byStatus[o.bucket]++;

		// ── offer acceptance by specialty (null specialty is not grouped under an invented name) ──
		const spec = new Map<string, { total: number; accepted: number }>();
		for (const o of items) {
			if (!o.specialty) continue;
			const cur = spec.get(o.specialty) || { total: 0, accepted: 0 };
			cur.total++;
			if (o.bucket === 'accepted') cur.accepted++;
			spec.set(o.specialty, cur);
		}
		const acceptanceBySpecialty = Array.from(spec.entries())
			.map(([specialty, v]) => ({ specialty, total: v.total, accepted: v.accepted, rate: pct(v.accepted, v.total) }))
			.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total)
			.slice(0, 8);

		// ── projects ─────────────────────────────────────────────────────────
		const completed = (projects as any[]).filter(p => p.status === 'COMPLETED');
		const active = (projects as any[]).filter(p => ['IN_PROGRESS', 'AWAITING_DELIVERY', 'PENDING_APPROVAL', 'DISPUTED'].includes(p.status));
		// duration and on-time need a contractual/agreed number; rows without one are excluded rather than assumed
		const timed = completed
			.map(p => {
				const days = Math.max(1, Math.round((p.updatedAt.getTime() - p.createdAt.getTime()) / 86400000));
				const agreed = p.contract?.durationDays ?? p.deliveryDays ?? null;
				return { days, agreed };
			});
		const withAgreed = timed.filter(t => t.agreed !== null);
		const avgDurationDays = timed.length ? Math.round(timed.reduce((s, t) => s + t.days, 0) / timed.length) : null;

		// ── disputes ─────────────────────────────────────────────────────────
		const disputeCounts = {
			all: disputes.length,
			open: disputes.filter(d => d.status === 'OPEN' || d.status === 'UNDER_REVIEW').length,
			resolved: disputes.filter(d => d.status === 'RESOLVED').length,
			rejected: disputes.filter(d => d.status === 'REJECTED').length
		};

		return {
			range,
			requests: { total: items.length, byStatus, items: items.slice(0, 50) },
			offersBySpecialty: acceptanceBySpecialty,
			projects: {
				totalCount: projects.length,
				activeCount: active.length,
				completedCount: completed.length,
				avgDurationDays,
				completedOnTime: withAgreed.filter(t => t.days <= (t.agreed as number)).length,
				completedWithAgreedDuration: withAgreed.length
			},
			payments: {
				releasedTotal: releasedAgg._sum.releasedAmount ?? null,
				heldInEscrow: heldAgg._sum.amount ?? null,
				transactions
			},
			disputes: {
				items: disputes,
				counts: disputeCounts,
				// share of the provider's projects in range that ended up with a dispute; null when there are no projects
				ratioPercent: pct(disputes.length, projects.length)
			}
		};
	}
}

export const providerReportsService = new ProviderReportsService();
