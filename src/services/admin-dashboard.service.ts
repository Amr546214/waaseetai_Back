import { AccountType, AccreditationStatus, DisputeStatus, EscrowStatus, KYCStatus, ModificationStatus, OnboardingStatus, ChangeRequestStatus, ProjectStatus, SpecialtyVerificationStatus, SupportTicketStatus, UserStatus, WithdrawalStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { deliveryCompletedProject } from './settlement-state.service';

// Admin dashboard aggregates. Every number comes from a COUNT / SUM / GROUP over the real tables — nothing is a fixed figure, a percentage with no
// base, or a placeholder. With no rows every figure is 0 and every list is []. Revenue = the platform commission recorded on escrows
// (Escrow.platformCommissionAmount, USD); it is dated by the escrow's last update (the release that accrued it) and covers fee-policy-v2 escrows only,
// so a legacy escrow contributes 0.

const ADMIN_TYPES: AccountType[] = [AccountType.ADMIN, AccountType.SUPER_ADMIN, AccountType.EMPLOYEE];
const DAY = 24 * 60 * 60 * 1000;
const ADMIN_ROUTE = '/supper-admin-overview';

const OPEN_DISPUTES: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW];
const OPEN_TICKETS: SupportTicketStatus[] = [SupportTicketStatus.OPEN, SupportTicketStatus.IN_PROGRESS];
const PENDING_ACCREDITATION: AccreditationStatus[] = [AccreditationStatus.MANUAL_REVIEW, AccreditationStatus.PENDING_AI_AUDIT];
const PENDING_AFFILIATE_REQUESTS: ChangeRequestStatus[] = [ChangeRequestStatus.PENDING_AI_REVIEW, ChangeRequestStatus.PENDING_HUMAN_APPROVAL];
const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = [ProjectStatus.IN_PROGRESS, ProjectStatus.AWAITING_DELIVERY, ProjectStatus.PENDING_APPROVAL];

const num = (v: unknown) => Number(v ?? 0) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;
const growth = (current: number, previous: number): number | null => previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const fullName = (u?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null) => `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || u?.email || '—';

export type ActivityKind = 'USER_REGISTERED' | 'DISPUTE_OPENED' | 'WITHDRAWAL_REQUESTED' | 'TICKET_OPENED' | 'ACCREDITATION_SUBMITTED' | 'ADMIN_ACTION';
export interface ActivityItem { id: string; kind: ActivityKind; title: string; actor: string; actorType: string | null; at: Date; status: string | null; link: string }

const ACCOUNT_LABEL: Record<string, string> = {
	CLIENT_INDIVIDUAL: 'طالب خدمة فرد', CLIENT_COMPANY: 'طالب خدمة شركة', PROVIDER_INDIVIDUAL: 'مقدم خدمة فرد', PROVIDER_COMPANY: 'مقدم خدمة شركة',
	MARKETING_BROKER: 'وسيط تسويقي', ADMIN: 'إداري', SUPER_ADMIN: 'مدير عام', EMPLOYEE: 'موظف'
};

export class AdminDashboardService {
	async getSummary(now = new Date()) {
		const monthStart = startOfMonth(now);
		const prevMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1));
		const sevenDaysAgo = new Date(now.getTime() - 7 * DAY);
		const day = new Date(now.getTime() - DAY);
		const memberWhere = { accountType: { notIn: ADMIN_TYPES } };

		const [
			usersTotal, usersActive, usersNewThisMonth, usersNewPrevMonth, usersSuspended,
			activeProjects, completedProjects, openRequests,
			commissionTotal, commissionMonth, escrowHeld,
			openDisputes, disputesOver7Days, openTickets, pendingWithdrawals, pendingWithdrawalsAmount,
			modificationRequests, providerKyc, clientKyc, marketerKyc, affiliateRequests, accreditation, specialtyReview, kycOver24h
		] = await Promise.all([
			prisma.user.count({ where: memberWhere }),
			prisma.user.count({ where: { ...memberWhere, status: UserStatus.ACTIVE } }),
			prisma.user.count({ where: { ...memberWhere, createdAt: { gte: monthStart } } }),
			prisma.user.count({ where: { ...memberWhere, createdAt: { gte: prevMonthStart, lt: monthStart } } }),
			prisma.user.count({ where: { ...memberWhere, status: { in: [UserStatus.SUSPENDED, UserStatus.SUSPENDED_REVIEW] } } }),
			prisma.project.count({ where: { status: { in: ACTIVE_PROJECT_STATUSES } } }),
			prisma.project.count({ where: deliveryCompletedProject() }),
			prisma.clientRequest.count({ where: { status: 'OPEN' } }),
			prisma.escrow.aggregate({ _sum: { platformCommissionAmount: true } }),
			prisma.escrow.aggregate({ _sum: { platformCommissionAmount: true }, where: { platformCommissionAmount: { gt: 0 }, updatedAt: { gte: monthStart } } }),
			prisma.escrow.aggregate({ _sum: { amount: true }, where: { status: EscrowStatus.HELD } }),
			prisma.dispute.count({ where: { status: { in: OPEN_DISPUTES } } }),
			prisma.dispute.count({ where: { status: { in: OPEN_DISPUTES }, createdAt: { lt: sevenDaysAgo } } }),
			prisma.supportTicket.count({ where: { status: { in: OPEN_TICKETS } } }),
			prisma.withdrawal.count({ where: { status: WithdrawalStatus.PENDING } }),
			prisma.withdrawal.aggregate({ _sum: { amount: true }, where: { status: WithdrawalStatus.PENDING, currency: 'USD' } }),
			prisma.profileModificationRequest.count({ where: { status: ModificationStatus.PENDING_HUMAN_REVIEW } }),
			prisma.providerProfile.count({ where: { kycStatus: KYCStatus.PENDING } }),
			prisma.clientOnboarding.count({ where: { status: OnboardingStatus.PENDING } }),
			prisma.affiliateProfile.count({ where: { identityVerified: false, kycDocumentUrl: { not: null } } }),
			prisma.profileChangeRequest.count({ where: { status: { in: PENDING_AFFILIATE_REQUESTS } } }),
			prisma.accreditationSample.count({ where: { status: { in: PENDING_ACCREDITATION } } }),
			prisma.providerSpecialty.count({ where: { status: SpecialtyVerificationStatus.UNDER_AI_REVIEW } }),
			prisma.clientOnboarding.count({ where: { status: OnboardingStatus.PENDING, createdAt: { lt: day } } })
		]);

		const kycPending = providerKyc + clientKyc;
		const queues = [
			{ key: 'modificationRequests', label: 'طلبات تعديل معلقة', count: modificationRequests, link: `${ADMIN_ROUTE}/modification-requests` },
			{ key: 'kyc', label: 'طلبات توثيق الهوية', count: kycPending, link: `${ADMIN_ROUTE}/kyc` },
			{ key: 'marketerKyc', label: 'توثيق هوية الوسطاء', count: marketerKyc, link: `${ADMIN_ROUTE}/brokers` },
			{ key: 'affiliateRequests', label: 'طلبات تعديل بيانات الوسطاء', count: affiliateRequests, link: `${ADMIN_ROUTE}/brokers` },
			{ key: 'accreditation', label: 'نماذج اعتماد بانتظار المراجعة', count: accreditation, link: `${ADMIN_ROUTE}/accreditations` },
			{ key: 'specialtyReview', label: 'تخصصات بانتظار قرار الإدارة', count: specialtyReview, link: `${ADMIN_ROUTE}/specialties-accreditation` },
			{ key: 'withdrawals', label: 'طلبات سحب تنتظر الإقرار', count: pendingWithdrawals, link: `${ADMIN_ROUTE}/withdrawals` },
			{ key: 'disputes', label: 'نزاعات مفتوحة', count: openDisputes, link: `${ADMIN_ROUTE}/disputes` },
			{ key: 'tickets', label: 'تذاكر دعم مفتوحة', count: openTickets, link: `${ADMIN_ROUTE}/support` }
		];

		const alerts: Array<{ key: string; severity: 'high' | 'warn' | 'info'; text: string; count: number; link: string }> = [];
		if (disputesOver7Days > 0) alerts.push({ key: 'disputesOver7Days', severity: 'high', text: `${disputesOver7Days} نزاع مفتوح مضى عليه أكثر من 7 أيام`, count: disputesOver7Days, link: `${ADMIN_ROUTE}/disputes` });
		if (kycOver24h > 0) alerts.push({ key: 'kycOver24h', severity: 'warn', text: `${kycOver24h} طلب توثيق هوية ينتظر قرارك منذ أكثر من 24 ساعة`, count: kycOver24h, link: `${ADMIN_ROUTE}/kyc` });
		if (pendingWithdrawals > 0) alerts.push({ key: 'pendingWithdrawals', severity: 'info', text: `${pendingWithdrawals} طلب سحب بانتظار الإقرار`, count: pendingWithdrawals, link: `${ADMIN_ROUTE}/withdrawals` });

		return {
			generatedAt: now.toISOString(),
			currency: 'USD',
			kpis: {
				users: { total: usersTotal, active: usersActive, suspended: usersSuspended, newThisMonth: usersNewThisMonth, newPreviousMonth: usersNewPrevMonth, growthPercent: growth(usersNewThisMonth, usersNewPrevMonth) },
				projects: { active: activeProjects, completed: completedProjects, openRequests },
				revenue: { platformCommissionTotal: round2(num(commissionTotal._sum.platformCommissionAmount)), platformCommissionThisMonth: round2(num(commissionMonth._sum.platformCommissionAmount)), escrowHeld: round2(num(escrowHeld._sum.amount)) },
				disputes: { open: openDisputes, openOver7Days: disputesOver7Days },
				tickets: { open: openTickets },
				withdrawals: { pending: pendingWithdrawals, pendingAmount: round2(num(pendingWithdrawalsAmount._sum.amount)) }
			},
			queues,
			alerts
		};
	}

	async getCharts(rawDays?: number, now = new Date()) {
		const days = rawDays === 30 ? 30 : 7;
		const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
		const monthsBack = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));

		const [users, escrows, statusGroups] = await Promise.all([
			prisma.user.findMany({ where: { accountType: { notIn: ADMIN_TYPES }, createdAt: { gte: from } }, select: { createdAt: true } }),
			prisma.escrow.findMany({ where: { platformCommissionAmount: { gt: 0 }, updatedAt: { gte: monthsBack } }, select: { platformCommissionAmount: true, updatedAt: true } }),
			prisma.project.groupBy({ by: ['status'], _count: { _all: true } })
		]);

		const registrations = Array.from({ length: days }, (_, i) => {
			const d = new Date(from.getTime() + i * DAY);
			return { date: d.toISOString().slice(0, 10), count: 0 };
		});
		const byDay = new Map(registrations.map(r => [r.date, r]));
		for (const u of users) { const row = byDay.get(new Date(u.createdAt).toISOString().slice(0, 10)); if (row) row.count += 1; }

		const commission = Array.from({ length: 6 }, (_, i) => {
			const d = new Date(Date.UTC(monthsBack.getUTCFullYear(), monthsBack.getUTCMonth() + i, 1));
			return { month: d.toISOString().slice(0, 7), amount: 0 };
		});
		const byMonth = new Map(commission.map(r => [r.month, r]));
		for (const e of escrows) { const row = byMonth.get(new Date(e.updatedAt).toISOString().slice(0, 7)); if (row) row.amount = round2(row.amount + num(e.platformCommissionAmount)); }

		return {
			days,
			currency: 'USD',
			registrations,
			registrationsTotal: registrations.reduce((s, r) => s + r.count, 0),
			commission,
			commissionTotal: round2(commission.reduce((s, r) => s + r.amount, 0)),
			projectsByStatus: statusGroups.map(g => ({ status: g.status, count: g._count._all }))
		};
	}

	async getActivity(rawLimit?: number) {
		const limit = Math.min(50, Math.max(1, Math.floor(Number(rawLimit)) || 15));
		const owner = { select: { firstName: true, lastName: true, email: true, accountType: true } } as const;
		const [users, disputes, withdrawals, tickets, samples, adminLogs] = await Promise.all([
			prisma.user.findMany({ where: { accountType: { notIn: ADMIN_TYPES } }, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, firstName: true, lastName: true, email: true, accountType: true, status: true, createdAt: true } }),
			prisma.dispute.findMany({ orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, reason: true, status: true, createdAt: true, openedBy: owner } }),
			prisma.withdrawal.findMany({ orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, amount: true, currency: true, status: true, createdAt: true, user: owner } }),
			prisma.supportTicket.findMany({ orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, subject: true, status: true, createdAt: true, user: owner } }),
			prisma.accreditationSample.findMany({ orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, title: true, status: true, createdAt: true, providerProfile: { select: { user: owner } } } }),
			prisma.accountAuditLog.findMany({ where: { source: 'ADMIN' }, orderBy: { occurredAt: 'desc' }, take: limit, select: { id: true, title: true, status: true, occurredAt: true, user: owner } })
		]);

		const items: ActivityItem[] = [
			...users.map(u => ({ id: `u:${u.id}`, kind: 'USER_REGISTERED' as const, title: 'تسجيل حساب جديد', actor: fullName(u), actorType: ACCOUNT_LABEL[u.accountType] ?? null, at: u.createdAt, status: u.status, link: `${ADMIN_ROUTE}/users/${u.id}` })),
			...disputes.map(d => ({ id: `d:${d.id}`, kind: 'DISPUTE_OPENED' as const, title: `فتح نزاع: ${d.reason}`, actor: fullName(d.openedBy), actorType: ACCOUNT_LABEL[d.openedBy?.accountType ?? ''] ?? null, at: d.createdAt, status: d.status, link: `${ADMIN_ROUTE}/disputes/${d.id}` })),
			...withdrawals.map(w => ({ id: `w:${w.id}`, kind: 'WITHDRAWAL_REQUESTED' as const, title: `طلب سحب ${w.amount} ${w.currency === 'USD' ? '$' : w.currency}`, actor: fullName(w.user), actorType: ACCOUNT_LABEL[w.user?.accountType ?? ''] ?? null, at: w.createdAt, status: w.status, link: `${ADMIN_ROUTE}/withdrawals/${w.id}` })),
			...tickets.map(t => ({ id: `t:${t.id}`, kind: 'TICKET_OPENED' as const, title: `تذكرة دعم: ${t.subject}`, actor: fullName(t.user), actorType: ACCOUNT_LABEL[t.user?.accountType ?? ''] ?? null, at: t.createdAt, status: t.status, link: `${ADMIN_ROUTE}/support/${t.id}` })),
			...samples.map(s => ({ id: `s:${s.id}`, kind: 'ACCREDITATION_SUBMITTED' as const, title: `نموذج اعتماد: ${s.title}`, actor: fullName(s.providerProfile?.user), actorType: ACCOUNT_LABEL[s.providerProfile?.user?.accountType ?? ''] ?? null, at: s.createdAt, status: s.status, link: `${ADMIN_ROUTE}/accreditations/${s.id}` })),
			...adminLogs.map(a => ({ id: `a:${a.id}`, kind: 'ADMIN_ACTION' as const, title: a.title, actor: fullName(a.user), actorType: ACCOUNT_LABEL[a.user?.accountType ?? ''] ?? null, at: a.occurredAt, status: a.status, link: `${ADMIN_ROUTE}/audit-trail` }))
		].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime()).slice(0, limit);

		return { items };
	}
}

export const adminDashboardService = new AdminDashboardService();
