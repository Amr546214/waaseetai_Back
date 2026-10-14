import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { IN_FLIGHT_WITHDRAWAL_STATUSES, SPENT_WITHDRAWAL_STATUSES, RESERVING_WITHDRAWAL_STATUSES } from '../utils/withdrawal-reservation';
import { round2, sumMoney } from '../utils/money';
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
    const escrowBalance = sumMoney(escrows.map(escrow => Math.max(0, entitlementOf(escrow) - providerReleased(escrow))));
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
          createdAt: stage.approvedAt || escrow.updatedAt
        };
      });
    });

    // Keeps old completed contracts visible if they were released before stage-level tracking was introduced (legacy escrows only).
    const legacyTransactions = escrows.filter(escrow => !isV2Escrow(escrow)).flatMap(escrow => {
      const tracked = (escrow.project.contract?.stages || []).reduce((sum, stage) => sum + stage.amount, 0);
      const residual = Math.max(0, escrow.releasedAmount - tracked);
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
        createdAt: escrow.updatedAt
      }] : [];
    });
    const transactions = [...stageTransactions, ...legacyTransactions]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    return {
      summary: {
        availableBalance,
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
        completedProjectsCount: escrows.filter(escrow => escrow.project.status === 'COMPLETED').length,
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
      createdAt: escrow.fundedAt || escrow.createdAt
    }));
    const events = [...wallet.transactions, ...fundingEvents]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { summary: wallet.summary, events };
  }
}

export const providerFinanceService = new ProviderFinanceService();
