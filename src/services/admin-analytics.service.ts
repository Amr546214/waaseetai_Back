import { prisma } from '../config/db';

// Read-only analytics over real aggregates (no writes). Every number is a COUNT / AVG over database rows,
// optionally limited to the [from, to] createdAt window. Nothing is estimated or invented.

export interface AnalyticsRange {
	from?: Date;
	to?: Date;
}

export function parseAnalyticsRange(fromRaw: unknown, toRaw: unknown): AnalyticsRange {
	const parse = (v: unknown, endOfDay: boolean): Date | undefined => {
		if (typeof v !== 'string' || !v.trim()) return undefined;
		const d = new Date(v);
		if (Number.isNaN(d.getTime())) return undefined;
		// A bare YYYY-MM-DD "to" means the whole day.
		if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) d.setUTCHours(23, 59, 59, 999);
		return d;
	};
	const from = parse(fromRaw, false);
	const to = parse(toRaw, true);
	return { from, to };
}

function createdAtWhere(range: AnalyticsRange): { createdAt?: { gte?: Date; lte?: Date } } {
	if (!range.from && !range.to) return {};
	return { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } };
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function fullName(u?: { firstName?: string | null; lastName?: string | null } | null): string {
	return u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || '—' : '—';
}

export const adminAnalyticsService = {
	async overview(range: AnalyticsRange) {
		const when = createdAtWhere(range);

		const [usersByType, usersInRange, projectsByStatus, requestsByStatus, ordersByStatus, disputesByStatus, referralsByStatus, reviewAgg, reviewsByRating, recentReviews, lowReviews, providerRatings, reviewSeries, completedByProvider, demandBySpecialty, supplyBySpecialty] = await Promise.all([
			prisma.user.groupBy({ by: ['accountType'], _count: { _all: true } }),
			prisma.user.findMany({ where: when, select: { createdAt: true, accountType: true } }),
			prisma.project.groupBy({ by: ['status'], where: when, _count: { _all: true } }),
			prisma.clientRequest.groupBy({ by: ['status'], where: when, _count: { _all: true } }),
			prisma.order.groupBy({ by: ['status'], where: when, _count: { _all: true } }),
			prisma.dispute.groupBy({ by: ['status'], where: when, _count: { _all: true } }),
			prisma.referral.groupBy({ by: ['status'], where: when, _count: { _all: true } }),
			prisma.review.aggregate({ where: when, _avg: { rating: true }, _count: { _all: true } }),
			prisma.review.groupBy({ by: ['rating'], where: when, _count: { _all: true } }),
			prisma.review.findMany({
				where: when,
				orderBy: { createdAt: 'desc' },
				take: 10,
				select: { id: true, rating: true, comment: true, createdAt: true, provider: { select: { firstName: true, lastName: true } }, client: { select: { firstName: true, lastName: true } } },
			}),
			prisma.review.findMany({
				where: { ...when, rating: { lt: 3 } },
				orderBy: { createdAt: 'desc' },
				take: 10,
				select: { id: true, rating: true, comment: true, createdAt: true, provider: { select: { firstName: true, lastName: true } }, client: { select: { firstName: true, lastName: true } } },
			}),
			prisma.review.groupBy({ by: ['providerId'], where: when, _avg: { rating: true }, _count: { _all: true } }),
			prisma.review.findMany({ where: when, select: { createdAt: true, rating: true } }),
			prisma.project.groupBy({ by: ['providerId'], where: { ...when, status: 'COMPLETED', providerId: { not: null } }, _count: { _all: true } }),
			prisma.project.groupBy({ by: ['specialty'], where: when, _count: { _all: true } }),
			prisma.providerProfile.groupBy({ by: ['mainSpecialty'], where: { mainSpecialty: { not: null } }, _count: { _all: true } }),
		]);

		const totalUsers = usersByType.reduce((s, r) => s + r._count._all, 0);
		const newByType = new Map<string, number>();
		const newByMonth = new Map<string, number>();
		for (const u of usersInRange) {
			newByType.set(u.accountType, (newByType.get(u.accountType) ?? 0) + 1);
			const k = monthKey(u.createdAt);
			newByMonth.set(k, (newByMonth.get(k) ?? 0) + 1);
		}

		// Providers: top / lowest by real review average within the window (needs at least one review).
		const ranked = providerRatings
			.filter((r) => r._avg.rating !== null)
			.map((r) => ({ providerId: r.providerId, averageRating: Number((r._avg.rating as number).toFixed(2)), reviewCount: r._count._all }));
		const completedMap = new Map(completedByProvider.map((r) => [r.providerId as string, r._count._all]));
		const top = [...ranked].sort((a, b) => b.averageRating - a.averageRating || b.reviewCount - a.reviewCount).slice(0, 10);
		const bottom = ranked.filter((r) => r.averageRating < 3.5).sort((a, b) => a.averageRating - b.averageRating).slice(0, 10);
		const ids = Array.from(new Set([...top, ...bottom].map((r) => r.providerId)));
		const names = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, accountType: true } }) : [];
		const nameMap = new Map(names.map((u) => [u.id, u]));
		const decorate = (r: (typeof ranked)[number]) => ({
			...r,
			name: fullName(nameMap.get(r.providerId)),
			accountType: nameMap.get(r.providerId)?.accountType ?? null,
			completedProjects: completedMap.get(r.providerId) ?? 0,
		});

		const byMonthAcc = new Map<string, { sum: number; n: number }>();
		for (const r of reviewSeries) {
			const k = monthKey(r.createdAt);
			const cur = byMonthAcc.get(k) ?? { sum: 0, n: 0 };
			byMonthAcc.set(k, { sum: cur.sum + r.rating, n: cur.n + 1 });
		}
		const reviewsByMonth = Array.from(byMonthAcc.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, count: v.n, average: Number((v.sum / v.n).toFixed(2)) }));

		const total = reviewAgg._count._all;
		const dist = [5, 4, 3, 2, 1].map((stars) => {
			const count = reviewsByRating.filter((r) => Math.round(r.rating) === stars).reduce((s, r) => s + r._count._all, 0);
			return { stars, count, percent: total ? Number(((count / total) * 100).toFixed(1)) : 0 };
		});
		const mapReview = (r: (typeof recentReviews)[number]) => ({ id: r.id, rating: r.rating, comment: r.comment, createdAt: r.createdAt, providerName: fullName(r.provider), clientName: r.client ? fullName(r.client) : null });

		const demand = demandBySpecialty.map((r) => ({ specialty: r.specialty, projects: r._count._all }));
		const supply = supplyBySpecialty.map((r) => ({ specialty: r.mainSpecialty as string, providers: r._count._all }));
		const names2 = Array.from(new Set([...demand.map((d) => d.specialty), ...supply.map((s) => s.specialty)]));
		const specialties = names2
			.map((specialty) => ({ specialty, projects: demand.find((d) => d.specialty === specialty)?.projects ?? 0, providers: supply.find((s) => s.specialty === specialty)?.providers ?? 0 }))
			.sort((a, b) => b.projects - a.projects);

		const toList = (rows: any[], key: string) => rows.map((r) => ({ [key]: r[key], count: r._count._all }));

		return {
			range: { from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null },
			users: {
				total: totalUsers,
				byAccountType: usersByType.map((r) => ({ accountType: r.accountType, count: r._count._all, newInRange: newByType.get(r.accountType) ?? 0 })),
				newInRange: usersInRange.length,
				newByMonth: Array.from(newByMonth.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count })),
			},
			projects: { total: projectsByStatus.reduce((s, r) => s + r._count._all, 0), byStatus: toList(projectsByStatus, 'status') },
			requests: { total: requestsByStatus.reduce((s, r) => s + r._count._all, 0), byStatus: toList(requestsByStatus, 'status') },
			orders: { total: ordersByStatus.reduce((s, r) => s + r._count._all, 0), byStatus: toList(ordersByStatus, 'status') },
			disputes: { total: disputesByStatus.reduce((s, r) => s + r._count._all, 0), byStatus: toList(disputesByStatus, 'status') },
			referrals: { total: referralsByStatus.reduce((s, r) => s + r._count._all, 0), byStatus: toList(referralsByStatus, 'status') },
			reviews: {
				count: total,
				average: reviewAgg._avg.rating === null ? null : Number((reviewAgg._avg.rating as number).toFixed(2)),
				negativeCount: dist.filter((d) => d.stars <= 2).reduce((s, d) => s + d.count, 0),
				distribution: dist,
				byMonth: reviewsByMonth,
				recent: recentReviews.map(mapReview),
				lowRated: lowReviews.map(mapReview),
			},
			providers: { topRated: top.map(decorate), atRisk: bottom.map(decorate), totalProviderAccounts: usersByType.filter((r) => r.accountType.startsWith('PROVIDER')).reduce((s, r) => s + r._count._all, 0) },
			specialties,
		};
	},
};
