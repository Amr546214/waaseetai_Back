import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { IN_FLIGHT_WITHDRAWAL_STATUSES, SPENT_WITHDRAWAL_STATUSES, RESERVING_WITHDRAWAL_STATUSES } from '../utils/withdrawal-reservation';
import { round2, sumMoney } from '../utils/money';
import { SETTLED_DISPUTE_WHERE } from './settlement-state.service';
import { adminReleaseBreakdown, cancellationSettlementBreakdown, escrowFundedBreakdown, grossCard, legacyEscrowReleaseBreakdown, NOT_FOUND_TX, pageOf, stageReleaseBreakdown, stateCard, valueCard } from './wallet-breakdown';
import { AppError } from '../utils/app-error';
import { isV2Escrow, providerReleased, providerNetEntitlement, splitRelease } from '../utils/escrow-commission';

export class ProviderFinanceService {
  /**
   * `client` defaults to the global singleton so every existing caller is
   * unaffected — but withdrawal.service.ts's createForProvider() passes its
   * own `tx` here so the released-earnings read participates in the SAME
   * serializable transaction as its pending-withdrawal read and its
   * Withdrawal insert, rather than reading a snapshot from outside it.
   */
  async getWallet(providerId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
    const escrows = await client.escrow.findMany({
      where: { project: { providerId } },
      include: {
        project: {
          select: {
            id: true,
            title: true,
            status: true,
            disputes: { where: SETTLED_DISPUTE_WHERE, select: { id: true }, take: 1 },
            engagementClosure: { select: { id: true, kind: true, source: true, reason: true, releaseToProvider: true, platformCommission: true, providerNet: true, createdAt: true } },
            contract: {
              select: {
                id: true,
                price: true,
                stages: {
                  where: { status: 'APPROVED' },
                  orderBy: { approvedAt: 'desc' },
                  select: { id: true, title: true, amount: true, approvedAt: true }
                }
              }
            }
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Fee policy v2: a v2 escrow counts what the provider really receives (the net after the snapshotted platform commission); a legacy escrow is
    // unchanged (gross). The two never mix inside one escrow.
    const entitlementOf = (escrow: (typeof escrows)[number]): number => {
      const price = escrow.project.contract?.price || escrow.amount;
      return isV2Escrow(escrow) && escrow.providerCommissionRateSnapshot != null ? providerNetEntitlement(price, escrow.providerCommissionRateSnapshot) : price;
    };
    const availableBalance = sumMoney(escrows.map(escrow => providerReleased(escrow)));
    // only a HELD escrow still has money waiting: a RELEASED / REFUNDED one (e.g. closed by a mutual-cancellation settlement) has nothing left for the provider
    const escrowBalance = sumMoney(escrows.map(escrow => (escrow.status === 'HELD' ? Math.max(0, entitlementOf(escrow) - providerReleased(escrow)) : 0)));
    // availableBalance stays the total released earnings; withdrawableBalance is what a NEW request may still ask for (the server enforces the same figure).
    const reserved = await client.withdrawal.groupBy({ by: ['status'], where: { userId: providerId, status: { in: [...RESERVING_WITHDRAWAL_STATUSES] } }, _sum: { amount: true } });
    const sumOf = (statuses: readonly string[]) => round2(reserved.filter(r => statuses.includes(r.status)).reduce((sum, r) => sum + (r._sum.amount ?? 0), 0));
    const pendingWithdrawals = sumOf(IN_FLIGHT_WITHDRAWAL_STATUSES);
    const paidWithdrawals = sumOf(SPENT_WITHDRAWAL_STATUSES);
    const withdrawableBalance = round2(Math.max(0, availableBalance - pendingWithdrawals - paidWithdrawals));
    const platformCommissionTotal = sumMoney(escrows.map(escrow => (isV2Escrow(escrow) ? escrow.platformCommissionAmount : 0)));

    const stageTransactions = escrows.flatMap(escrow => {
      const stages = escrow.project.contract?.stages || [];
      const v2Rate = isV2Escrow(escrow) ? escrow.providerCommissionRateSnapshot : null;
      // v2: the same cumulative split the release used, replayed in release order, so every stage shows its commission and its net
      const splitByStage = new Map<string, { gross: number; commission: number; net: number }>();
      if (v2Rate != null) {
        let grossSoFar = 0; let commissionSoFar = 0;
        for (const stage of [...stages].sort((x, y) => (x.approvedAt?.getTime() ?? 0) - (y.approvedAt?.getTime() ?? 0))) {
          const r = splitRelease({ grossReleasedBefore: grossSoFar, commissionTotalBefore: commissionSoFar, grossReleasedAfter: grossSoFar + stage.amount, ratePercent: v2Rate });
          splitByStage.set(stage.id, { gross: r.gross, commission: r.commission, net: r.net });
          grossSoFar = r.grossReleasedAfter; commissionSoFar = r.commissionTotalAfter;
        }
      }
      return stages.map(stage => {
        const split = splitByStage.get(stage.id);
        return {
          id: `stage-release-${stage.id}`,
          type: 'credit' as const,
          category: 'STAGE_RELEASE' as const,
          amount: round2(split ? split.net : stage.amount),
          ...(split ? { grossAmount: round2(split.gross), platformCommission: round2(split.commission), commissionRatePercent: v2Rate } : {}),
          currency: 'USD',
          title: 'إفراج دفعة مرحلة',
          description: split ? `${stage.title} · ${escrow.project.title} · بعد خصم عمولة المنصة ${v2Rate}%` : `${stage.title} · ${escrow.project.title}`,
          projectId: escrow.project.id,
          projectTitle: escrow.project.title,
          stageId: stage.id,
          status: 'COMPLETED' as const,
          createdAt: stage.approvedAt || escrow.updatedAt,
          breakdown: stageReleaseBreakdown(escrow, split, stage)
        };
      });
    });

    // A mutual-cancellation settlement credits the provider through the escrow (providerNetReleasedAmount, already in availableBalance above); this line makes that
    // credit visible in the history with the same gross / commission / net split a stage release shows. Nothing is added to any balance here.
    const settledCancellations = (await (client as any).contractCancellationRequest?.findMany({ where: { providerId, status: 'SETTLED', settlementReleaseToProvider: { gt: 0 } }, include: { contract: { select: { project: { select: { id: true, title: true } } } } } })) ?? [];
    // Money released OUTSIDE stage approvals has its OWN dedicated line (a settlement / an administrative release), so it is subtracted from the legacy remainder: stages + settlements + administrative
    // releases + the legacy remainder always add up to exactly the released amount, with no line counted twice.
    const closureGrossByProject = new Map<string, number>();
    for (const r of settledCancellations as any[]) closureGrossByProject.set(r.projectId, round2((closureGrossByProject.get(r.projectId) ?? 0) + (r.settlementReleaseToProvider ?? 0)));
    for (const escrow of escrows) {
      const cl = (escrow.project as any).engagementClosure;
      if (cl?.kind === 'ADMIN_RELEASE' && cl.releaseToProvider > 0) closureGrossByProject.set(escrow.project.id, round2((closureGrossByProject.get(escrow.project.id) ?? 0) + cl.releaseToProvider));
    }
    // Keeps old completed contracts visible if they were released before stage-level tracking was introduced (legacy escrows only).
    const legacyTransactions = escrows.filter(escrow => !isV2Escrow(escrow)).flatMap(escrow => {
      const tracked = (escrow.project.contract?.stages || []).reduce((sum, stage) => sum + stage.amount, 0);
      const residual = round2(Math.max(0, escrow.releasedAmount - tracked - (closureGrossByProject.get(escrow.project.id) ?? 0)));
      return residual > 0 ? [{
        id: `escrow-release-${escrow.id}`,
        type: 'credit' as const,
        category: 'ESCROW_RELEASE' as const,
        amount: round2(residual),
        currency: 'USD',
        title: 'إفراج ضمان المشروع',
        description: escrow.project.title,
        projectId: escrow.project.id,
        projectTitle: escrow.project.title,
        stageId: null,
        status: 'COMPLETED' as const,
        createdAt: escrow.updatedAt,
        breakdown: legacyEscrowReleaseBreakdown(residual)
      }] : [];
    });
    const cancellationTransactions = settledCancellations.map((r: any) => ({
      id: `cancellation-settlement-${r.id}`,
      type: 'credit' as const,
      category: 'CANCELLATION_SETTLEMENT' as const,
      amount: round2(r.settlementProviderNet ?? r.settlementReleaseToProvider),
      grossAmount: round2(r.settlementReleaseToProvider), platformCommission: round2(r.settlementPlatformCommission ?? 0),
      currency: 'USD',
      title: 'تسوية إلغاء بالتراضي',
      description: `${r.contract?.project?.title ?? ''} · نصيبك من المتبقي في الضمان بعد خصم العمولة`.trim(),
      projectId: r.projectId,
      projectTitle: r.contract?.project?.title ?? null,
      stageId: null,
      status: 'COMPLETED' as const,
      createdAt: r.settledAt ?? r.updatedAt,
      breakdown: cancellationSettlementBreakdown(r, escrows.find(e => e.project.id === r.projectId))
    }));
    // An administrative release credits the provider through the escrow (already in availableBalance); this line shows it with gross / commission / net / contract / reason / source.
    // It has NO stage: the line carries no stageId. Withdrawal availability is unchanged (the money is withdrawable like any released earning).
    const adminReleaseTransactions = escrows.flatMap(escrow => {
      const cl = (escrow.project as any).engagementClosure;
      if (!cl || cl.kind !== 'ADMIN_RELEASE' || !(cl.releaseToProvider > 0)) return [];
      return [{
        id: `admin-release-${cl.id}`,
        type: 'credit' as const,
        category: 'ADMIN_RELEASE' as const,
        amount: round2(cl.providerNet),
        grossAmount: round2(cl.releaseToProvider), platformCommission: round2(cl.platformCommission ?? 0),
        currency: 'USD',
        title: 'صرف إداري للضمان',
        description: `${escrow.project.title} · صُرف المبلغ المحتجز بقرار إداري${cl.reason ? ` · السبب: ${cl.reason}` : ''}`,
        projectId: escrow.project.id,
        projectTitle: escrow.project.title,
        contractId: escrow.project.contract?.id ?? null,
        stageId: null,
        source: cl.source as string,
        reason: cl.reason as string | null,
        status: 'COMPLETED' as const,
        createdAt: cl.createdAt as Date,
        breakdown: adminReleaseBreakdown(cl, escrow)
      }];
    });
    const transactions = [...stageTransactions, ...legacyTransactions, ...cancellationTransactions, ...adminReleaseTransactions]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    // Cards: availableToWithdraw is the SAME figure the withdrawal path enforces (withdrawableBalance). The gross is computed only over the itemised release lines; a part of
    // availableBalance that has no line (e.g. a dispute-resolution release) is reported, not hidden.
    const itemisedNet = sumMoney(transactions.map(tx => tx.amount));
    const releasedWithoutLine = round2(Math.max(0, availableBalance - itemisedNet));
    const gross = grossCard('المبلغ قبل الخصومات', ['STAGE_RELEASE', 'ESCROW_RELEASE', 'CANCELLATION_SETTLEMENT', 'ADMIN_RELEASE'], transactions,
      releasedWithoutLine > 0.005 ? `لا يشمل ${releasedWithoutLine} $ أُفرجت بقرار نزاع ولا يوجد لها بند تفصيلي` : 'مجموع الدفعات المُفرَجة قبل عمولة المنصة');
    if (releasedWithoutLine > 0.005) gross.complete = false;
    const cards = {
      availableToWithdraw: valueCard('المتاح للسحب', withdrawableBalance, { covers: ['STAGE_RELEASE', 'ESCROW_RELEASE', 'CANCELLATION_SETTLEMENT', 'ADMIN_RELEASE'], note: 'بعد خصم طلبات السحب المعلّقة والمدفوعة' }),
      pendingWithdrawals: valueCard('طلبات سحب معلّقة', pendingWithdrawals),
      grossBeforeDeductions: gross,
      heldInEscrow: valueCard('محجوز في الضمان', escrowBalance, { covers: ['ESCROW_FUNDED'] }),
      cashback: stateCard('NOT_APPLICABLE', 'الكاش باك', 'الكاش باك ميزة لطالب الخدمة')
    };

    return {
      summary: {
        availableBalance,
        releasedWithoutLine,
        canWithdraw: true,
        cards,
        pendingWithdrawals,
        paidWithdrawals,
        withdrawableBalance,
        totalEarnings: availableBalance,
        escrowBalance,
        // what the platform kept as commission on v2 escrows (the provider's availableBalance is already net of it)
        platformCommissionTotal,
        releasedThisMonth: sumMoney(transactions.filter(tx => tx.createdAt >= monthStart).map(tx => tx.amount)),
        releasedTransactionsCount: transactions.length,
        fundedProjectsCount: escrows.filter(escrow => escrow.status === 'HELD' && (escrow.project.contract?.price || escrow.amount) > escrow.releasedAmount).length,
        completedProjectsCount: escrows.filter(escrow => escrow.project.status === 'COMPLETED' && !(escrow.project.disputes?.length) && !(escrow.project as any).engagementClosure).length,
        currency: 'USD' // active escrow/contract pricing pipeline is now USD-semantic
      },
      transactions,
      escrows: escrows.filter(escrow => escrow.status === 'HELD' && (escrow.project.contract?.price || escrow.amount) > escrow.releasedAmount).map(escrow => ({
        id: escrow.id,
        projectId: escrow.project.id,
        projectTitle: escrow.project.title,
        total: round2(entitlementOf(escrow)),
        released: round2(providerReleased(escrow)),
        held: round2(Math.max(0, entitlementOf(escrow) - providerReleased(escrow))),
        ...(isV2Escrow(escrow) ? { grossTotal: round2(escrow.project.contract?.price || escrow.amount), commissionRatePercent: escrow.providerCommissionRateSnapshot } : {}),
        status: escrow.status,
        updatedAt: escrow.updatedAt
      }))
    };
  }

  async getTransactions(providerId: string) {
    const wallet = await this.getWallet(providerId);
    const fundedEscrows = await prisma.escrow.findMany({
      where: { project: { providerId } },
      include: { project: { select: { id: true, title: true, contract: { select: { price: true } } } } },
      orderBy: { createdAt: 'desc' }
    });
    const fundingEvents = fundedEscrows.map(escrow => ({
      id: `escrow-funded-${escrow.id}`,
      type: 'hold' as const,
      category: 'ESCROW_FUNDED' as const,
      amount: round2(escrow.project.contract?.price || escrow.amount),
      currency: 'USD' as const,
      title: 'تمويل ضمان المشروع',
      description: escrow.project.title,
      projectId: escrow.project.id,
      projectTitle: escrow.project.title,
      stageId: null,
      status: escrow.status === 'REFUNDED' ? 'REFUNDED' as const : escrow.status === 'RELEASED' ? 'RELEASED' as const : 'HELD' as const,
      createdAt: escrow.fundedAt || escrow.createdAt,
      breakdown: escrowFundedBreakdown(escrow.project.contract?.price || escrow.amount)
    }));
    const events = [...wallet.transactions, ...fundingEvents]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { summary: wallet.summary, events };
  }

  /** Full paged history (release lines + funding events), each with its breakdown, and the same summary (cards). */
  async getHistory(providerId: string, query: { page?: unknown; limit?: unknown; type?: unknown }) {
    const { summary, events } = await this.getTransactions(providerId);
    const type = typeof query.type === 'string' && query.type ? query.type.toUpperCase() : null;
    const rows = type ? events.filter(e => e.category === type) : events;
    return { summary, ...pageOf(rows, query.page, query.limit) };
  }

  /** One history row by the id the list shows. Owner only: someone else's row answers 404 exactly like an unknown id. */
  async getTransaction(providerId: string, rawId: string) {
    const id = String(rawId || '').trim();
    if (!id || id.length > 200) throw new AppError(NOT_FOUND_TX, 404);
    const { events } = await this.getTransactions(providerId);
    const row = events.find(e => e.id === id);
    if (!row) throw new AppError(NOT_FOUND_TX, 404);
    const wallet = await this.getWallet(providerId);
    const escrow = wallet.escrows.find(e => e.projectId === row.projectId) ?? null;
    return { ...row, project: row.projectId ? { id: row.projectId, title: row.projectTitle } : null, escrow: escrow ? { total: escrow.total, released: escrow.released, held: escrow.held, status: escrow.status } : null };
  }
}

export const providerFinanceService = new ProviderFinanceService();
