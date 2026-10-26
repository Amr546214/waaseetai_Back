import { Prisma, WithdrawalStatus } from '@prisma/client';
import { platformZone, formatInZone } from '../utils/platform-time';
import { prisma } from '../config/db';
import { contractInclude, invoicesOf } from './provider-invoices.service';
import { toCsv } from '../utils/csv.util';

/**
 * Admin finance read models. Everything is computed from the database tables the money already flows through (escrows, wallet transactions, PayPal
 * payments, withdrawals, affiliate commission logs, stage deliveries); nothing is typed in. USD only. No tax / VAT figure exists anywhere in the
 * platform's money flow, so none is shown. Read-only: no money moves from here.
 */
import { round2 } from '../utils/money';
import { LEGACY_CURRENCY, sumByCurrency } from '../utils/currency';
import { platformCurrency } from './platform-currency';
const fullName = (u?: { firstName?: string | null; lastName?: string | null } | null) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const CSV_ROW_CAP = 5000;

/** The last `months` calendar months (UTC), oldest first, as empty buckets. */
function monthBuckets(months: number, now = new Date()) {
	const out: { month: string; deposits: number; releasedGross: number; withdrawalsPaid: number; affiliateCommissions: number }[] = [];
	for (let i = months - 1; i >= 0; i--) {
		const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
		out.push({ month: monthKey(d), deposits: 0, releasedGross: 0, withdrawalsPaid: 0, affiliateCommissions: 0 });
	}
	return out;
}

export class AdminFinanceService {
	async overview(months = 6, now = new Date()) {
		const base = await platformCurrency(); // the headline currency: the platform base currency (other currencies are listed separately)
		const span = Math.min(12, Math.max(1, Math.floor(months) || 6));
		const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (span - 1), 1));
		const [heldEscrows, releasedEscrows, deposits, paypalFees, withdrawalGroups, commissionGroups, depositRows, approvedStages, paidWithdrawals, commissionRows, escrowHeldByCur, escrowReleasedByCur, depositsByCur] = await Promise.all([
			prisma.escrow.aggregate({ where: { status: 'HELD', currency: base }, _sum: { amount: true, releasedAmount: true }, _count: { _all: true } }),
			prisma.escrow.aggregate({ where: { currency: base }, _sum: { releasedAmount: true, platformCommissionAmount: true, providerNetReleasedAmount: true } }),
			prisma.walletTransaction.aggregate({ where: { type: 'DEPOSIT', status: 'COMPLETED', currency: base }, _sum: { amount: true }, _count: { _all: true } }),
			prisma.paypalPayment.aggregate({ where: { status: 'COMPLETED', currency: base }, _sum: { feeAmount: true } }),
			prisma.withdrawal.groupBy({ by: ['status', 'currency'], _sum: { amount: true }, _count: { _all: true } }),
			prisma.commissionLog.groupBy({ by: ['status', 'currency'], _sum: { amount: true }, _count: { _all: true } }),
			prisma.walletTransaction.findMany({ where: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: since } }, select: { amount: true, currency: true, createdAt: true }, take: 20000 }),
			prisma.projectStage.findMany({ where: { status: 'APPROVED', approvedAt: { gte: since } }, select: { amount: true, currency: true, approvedAt: true }, take: 20000 }),
			prisma.withdrawal.findMany({ where: { status: WithdrawalStatus.COMPLETED, updatedAt: { gte: since } }, select: { amount: true, currency: true, updatedAt: true }, take: 20000 }),
			prisma.commissionLog.findMany({ where: { createdAt: { gte: since } }, select: { amount: true, currency: true, createdAt: true }, take: 20000 }),
			// the same totals PER CURRENCY: amounts of different currencies are never added together
			prisma.escrow.groupBy({ by: ['currency'], where: { status: 'HELD' }, _sum: { amount: true, releasedAmount: true } }),
			prisma.escrow.groupBy({ by: ['currency'], _sum: { releasedAmount: true, platformCommissionAmount: true, providerNetReleasedAmount: true } }),
			prisma.walletTransaction.groupBy({ by: ['currency'], where: { type: 'DEPOSIT', status: 'COMPLETED' }, _sum: { amount: true } })
		]);
		const byCurrency: Record<string, Record<string, number>> = {};
		const cur = (c: string) => (byCurrency[c] ??= { escrowHeldAmount: 0, releasedGross: 0, platformCommission: 0, providerNetReleased: 0, depositsAmount: 0 });
		for (const g of escrowHeldByCur ?? []) cur(g.currency).escrowHeldAmount = round2((g._sum.amount ?? 0) - (g._sum.releasedAmount ?? 0));
		for (const g of escrowReleasedByCur ?? []) { const c = cur(g.currency); c.releasedGross = round2(g._sum.releasedAmount ?? 0); c.platformCommission = round2(g._sum.platformCommissionAmount ?? 0); c.providerNetReleased = round2(g._sum.providerNetReleasedAmount ?? 0); }
		for (const g of depositsByCur ?? []) cur(g.currency).depositsAmount = round2(g._sum.amount ?? 0);
		// one monthly series PER CURRENCY: `series` is the USD one, seriesByCurrency has every currency (rows of different currencies are never added into one bucket)
		const seriesByCurrency: Record<string, ReturnType<typeof monthBuckets>> = {};
		const seriesOf = (c: string) => (seriesByCurrency[c] ??= monthBuckets(span, now));
		const put = (c: string | null | undefined, d: Date | null | undefined, key: 'deposits' | 'releasedGross' | 'withdrawalsPaid' | 'affiliateCommissions', amount: number) => { const cc = c ?? base; const b = d ? seriesOf(cc).find(x => x.month === monthKey(d)) : undefined; if (b) b[key] += amount; };
		seriesOf(base);
		for (const r of depositRows) put((r as any).currency, r.createdAt, 'deposits', r.amount);
		for (const r of approvedStages) put((r as any).currency, r.approvedAt, 'releasedGross', r.amount);
		for (const r of paidWithdrawals) put((r as any).currency, r.updatedAt, 'withdrawalsPaid', r.amount);
		for (const r of commissionRows) put((r as any).currency, r.createdAt, 'affiliateCommissions', r.amount);
		for (const list of Object.values(seriesByCurrency)) for (const b of list) { b.deposits = round2(b.deposits); b.releasedGross = round2(b.releasedGross); b.withdrawalsPaid = round2(b.withdrawalsPaid); b.affiliateCommissions = round2(b.affiliateCommissions); }
		const series = seriesByCurrency[base];
		const otherSeries = Object.fromEntries(Object.entries(seriesByCurrency).filter(([c, l]) => c !== base && l.some(b => b.deposits || b.releasedGross || b.withdrawalsPaid || b.affiliateCommissions)));

		// count = every row of the status; amount = the USD ones; amountByCurrency lists each currency on its own
		const fold = (groups: any[]) => { const out: Record<string, { count: number; amount: number; amountByCurrency: Record<string, number> }> = {}; for (const g of groups) { const c = g.currency ?? base; const t = (out[g.status] ??= { count: 0, amount: 0, amountByCurrency: {} }); t.count += g._count._all; t.amountByCurrency[c] = round2((t.amountByCurrency[c] ?? 0) + (g._sum.amount ?? 0)); if (c === base) t.amount = round2(t.amount + (g._sum.amount ?? 0)); } return out; };
		const withdrawals = fold(withdrawalGroups);
		const affiliateCommissions = fold(commissionGroups);
		return {
			currency: base,
			// the headline totals above are the USD-labelled escrows (and the wallet ledger as stored); byCurrency lists EVERY currency separately and mixedCurrencies says when more than one exists
			byCurrency,
			mixedCurrencies: Object.keys(byCurrency).filter(c => Object.values(byCurrency[c]).some(v => v !== 0)).length > 1,
			totals: {
				escrowHeldCount: heldEscrows._count._all,
				escrowHeldAmount: round2((heldEscrows._sum.amount ?? 0) - (heldEscrows._sum.releasedAmount ?? 0)),
				releasedGross: round2(releasedEscrows._sum.releasedAmount ?? 0),
				platformCommission: round2(releasedEscrows._sum.platformCommissionAmount ?? 0),
				providerNetReleased: round2(releasedEscrows._sum.providerNetReleasedAmount ?? 0),
				depositsCount: deposits._count._all,
				depositsAmount: round2(deposits._sum.amount ?? 0),
				paymentGatewayFees: round2(Number(paypalFees._sum.feeAmount ?? 0))
			},
			withdrawals,
			affiliateCommissions,
			series,
			seriesByCurrency: otherSeries
		};
	}

	private txWhere(filters: { type?: string; status?: string; q?: string }): Prisma.WalletTransactionWhereInput {
		const q = filters.q?.trim();
		return {
			...(filters.type ? { type: filters.type } : {}),
			...(filters.status ? { status: filters.status } : {}),
			...(q ? { OR: [{ referenceId: { contains: q, mode: 'insensitive' } }, { user: { email: { contains: q, mode: 'insensitive' } } }] } : {})
		};
	}

	async transactions(filters: { type?: string; status?: string; q?: string }, pageNo = 1, limit = 20) {
		const safePage = Math.max(1, pageNo); const safeLimit = Math.min(100, Math.max(1, limit));
		const where = this.txWhere(filters);
		const [items, total, types] = await Promise.all([
			prisma.walletTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
			prisma.walletTransaction.count({ where }),
			prisma.walletTransaction.groupBy({ by: ['type'], _count: { _all: true } })
		]);
		const pages = Math.ceil(total / safeLimit);
		return {
			items: items.map(t => ({ id: t.id, type: t.type, amount: round2(t.amount), currency: t.currency, status: t.status, paymentMethod: t.paymentMethod, referenceId: t.referenceId, description: t.description, createdAt: t.createdAt, user: t.user ? { id: t.user.id, name: fullName(t.user), email: t.user.email } : null })),
			typeCounts: Object.fromEntries(types.map(g => [g.type, g._count._all])),
			pagination: { page: safePage, limit: safeLimit, total, pages, totalPages: pages }
		};
	}

	async transactionsCsv(filters: { type?: string; status?: string; q?: string }) {
		const rows = await prisma.walletTransaction.findMany({ where: this.txWhere(filters), orderBy: { createdAt: 'desc' }, take: CSV_ROW_CAP, include: { user: { select: { firstName: true, lastName: true, email: true } } } });
		return toCsv(['id', 'date', 'type', 'status', 'amount', 'currency', 'user', 'email', 'method', 'reference', 'description'], rows.map(t => [t.id, t.createdAt.toISOString(), t.type, t.status, t.amount, t.currency, fullName(t.user), t.user?.email, t.paymentMethod, t.referenceId, t.description]));
	}

	/** Platform commission per project (fee-policy-v2 escrows) + the affiliate commission ledger totals. */
	async commissions(pageNo = 1, limit = 20) {
		const base = await platformCurrency(); // the headline currency: the platform base currency (other currencies are listed separately)
		const safePage = Math.max(1, pageNo); const safeLimit = Math.min(100, Math.max(1, limit));
		const where: Prisma.EscrowWhereInput = { feePolicyVersion: 2, releasedAmount: { gt: 0 } };
		const [items, total, sums, affiliate] = await Promise.all([
			prisma.escrow.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, select: { id: true, projectId: true, status: true, releasedAmount: true, platformCommissionAmount: true, providerNetReleasedAmount: true, providerCommissionRateSnapshot: true, providerCommissionLevelSnapshot: true, updatedAt: true, project: { select: { title: true, provider: { select: { firstName: true, lastName: true } } } } } }),
			prisma.escrow.count({ where }),
			prisma.escrow.groupBy({ by: ['currency'], where, _sum: { releasedAmount: true, platformCommissionAmount: true, providerNetReleasedAmount: true } }),
			prisma.commissionLog.groupBy({ by: ['status', 'currency'], _sum: { amount: true }, _count: { _all: true } })
		]);
		const pages = Math.ceil(total / safeLimit);
		// count = every ledger row of the status; amount = the USD ones; amountByCurrency lists each currency on its own
		const affiliateTotals: Record<string, { count: number; amount: number; amountByCurrency: Record<string, number> }> = {};
		for (const g of affiliate) { const t = (affiliateTotals[g.status] ??= { count: 0, amount: 0, amountByCurrency: {} }); t.count += g._count._all; t.amountByCurrency[g.currency] = round2((t.amountByCurrency[g.currency] ?? 0) + (g._sum.amount ?? 0)); if (g.currency === base) t.amount = round2(t.amount + (g._sum.amount ?? 0)); }
		const sumsBy = (k: 'releasedAmount' | 'platformCommissionAmount' | 'providerNetReleasedAmount') => sumByCurrency(sums, (r: any) => r.currency, (r: any) => r._sum[k]);
		return {
			currency: base,
			totals: { releasedGross: sumsBy('releasedAmount')[base] ?? 0, platformCommission: sumsBy('platformCommissionAmount')[base] ?? 0, providerNet: sumsBy('providerNetReleasedAmount')[base] ?? 0 },
			totalsByCurrency: { releasedGross: sumsBy('releasedAmount'), platformCommission: sumsBy('platformCommissionAmount'), providerNet: sumsBy('providerNetReleasedAmount') },
			affiliate: affiliateTotals,
			items: items.map(e => ({ id: e.id, projectId: e.projectId, projectTitle: e.project?.title ?? '', provider: fullName(e.project?.provider), escrowStatus: e.status, releasedGross: round2(e.releasedAmount), platformCommission: round2(e.platformCommissionAmount), providerNet: round2(e.providerNetReleasedAmount), ratePercent: e.providerCommissionRateSnapshot, level: e.providerCommissionLevelSnapshot, updatedAt: e.updatedAt })),
			pagination: { page: safePage, limit: safeLimit, total, pages, totalPages: pages }
		};
	}

	async commissionsCsv() {
		const rows = await prisma.escrow.findMany({ where: { feePolicyVersion: 2, releasedAmount: { gt: 0 } }, orderBy: { updatedAt: 'desc' }, take: CSV_ROW_CAP, select: { projectId: true, currency: true, status: true, releasedAmount: true, platformCommissionAmount: true, providerNetReleasedAmount: true, providerCommissionRateSnapshot: true, providerCommissionLevelSnapshot: true, project: { select: { title: true } } } });
		return toCsv(['project_id', 'project', 'escrow_status', 'currency', 'released_gross', 'platform_commission', 'provider_net', 'rate_percent', 'level'], rows.map(e => [e.projectId, e.project?.title, e.status, e.currency, e.releasedAmount, e.platformCommissionAmount, e.providerNetReleasedAmount, e.providerCommissionRateSnapshot, e.providerCommissionLevelSnapshot]));
	}

	/** Every stage invoice on the platform (one per delivered stage), derived the same way the client and provider invoice pages derive theirs. */
	private async allInvoices(status?: 'paid' | 'due') {
		const contracts = await prisma.contract.findMany({ orderBy: { updatedAt: 'desc' }, take: 2000, include: { ...contractInclude, provider: { select: { firstName: true, lastName: true } } } });
		const invoices = contracts.flatMap((c: any) => invoicesOf(c).map((i: any) => ({ ...i, providerName: fullName(c.provider) }))).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
		return status ? invoices.filter((i: any) => i.status === status) : invoices;
	}

	async invoices(status: 'paid' | 'due' | undefined, pageNo = 1, limit = 20) {
		const base = await platformCurrency(); // the headline currency: the platform base currency (other currencies are listed separately)
		const safePage = Math.max(1, pageNo); const safeLimit = Math.min(100, Math.max(1, limit));
		const all = await this.allInvoices();
		const filtered = status ? all.filter((i: any) => i.status === status) : all;
		const sum = (list: any[], key: string) => round2(list.filter((i: any) => i.currency === base).reduce((s, i) => s + (i[key] || 0), 0));
		const sumBy = (list: any[], key: string) => sumByCurrency(list, (i: any) => i.currency, (i: any) => i[key] || 0);
		const paid = all.filter((i: any) => i.status === 'paid'); const due = all.filter((i: any) => i.status === 'due');
		const pages = Math.ceil(filtered.length / safeLimit);
		return {
			currency: base,
			summary: { totalCount: all.length, paidCount: paid.length, dueCount: due.length, paidTotal: sum(paid, 'stageValue'), dueTotal: sum(due, 'stageValue'), platformCommission: sum(paid, 'platformCommission'), paidTotalBy: sumBy(paid, 'stageValue'), dueTotalBy: sumBy(due, 'stageValue'), platformCommissionBy: sumBy(paid, 'platformCommission') },
			items: filtered.slice((safePage - 1) * safeLimit, safePage * safeLimit),
			pagination: { page: safePage, limit: safeLimit, total: filtered.length, pages, totalPages: pages }
		};
	}

	async invoicesCsv(status?: 'paid' | 'due') {
		const list = (await this.allInvoices(status)).slice(0, CSV_ROW_CAP);
		return toCsv(['invoice', 'date', 'project', 'stage', 'client', 'provider', 'currency', 'stage_value', 'platform_commission', 'provider_net', 'status'], list.map((i: any) => [i.id, i.date, i.projectTitle, i.stageTitle, i.clientName, i.providerName, i.currency, i.stageValue, i.platformCommission, i.net, i.status]));
	}

	async withdrawalsCsv(status?: WithdrawalStatus) {
		const rows = await prisma.withdrawal.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: CSV_ROW_CAP, include: { user: { select: { firstName: true, lastName: true, email: true } } } });
		// `date` stays the reference instant (ISO, UTC); when a platform time zone is configured a `date_local` column writes the same instant in that zone
		const zone = await platformZone();
		return toCsv(['id', 'date', ...(zone ? ['date_local'] : []), 'user', 'email', 'amount', 'currency', 'method', 'paypal_email', 'status', 'reference', 'rejection_reason'], rows.map(w => [w.id, w.createdAt.toISOString(), ...(zone ? [formatInZone(w.createdAt, zone)] : []), fullName(w.user), w.user?.email, w.amount, w.currency, w.method, w.paypalEmail, w.status, w.referenceId, w.rejectionReason]));
	}
}

export const adminFinanceService = new AdminFinanceService();

