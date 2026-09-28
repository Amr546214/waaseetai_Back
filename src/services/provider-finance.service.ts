import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';

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

    const availableBalance = escrows.reduce((sum, escrow) => sum + escrow.releasedAmount, 0);
    const escrowBalance = escrows.reduce((sum, escrow) => {
      const providerEntitlement = escrow.project.contract?.price || escrow.amount;
      return sum + Math.max(0, providerEntitlement - escrow.releasedAmount);
    }, 0);
    const stageTransactions = escrows.flatMap(escrow =>
      (escrow.project.contract?.stages || []).map(stage => ({
        id: `stage-release-${stage.id}`,
        type: 'credit' as const,
        category: 'STAGE_RELEASE' as const,
        amount: stage.amount,
        currency: 'USD',
        title: 'إفراج دفعة مرحلة',
        description: `${stage.title} · ${escrow.project.title}`,
        projectId: escrow.project.id,
        projectTitle: escrow.project.title,
        stageId: stage.id,
        status: 'COMPLETED' as const,
        createdAt: stage.approvedAt || escrow.updatedAt
      }))
    );

    // Keeps old completed contracts visible if they were released before stage-level tracking was introduced.
    const legacyTransactions = escrows.flatMap(escrow => {
      const tracked = (escrow.project.contract?.stages || []).reduce((sum, stage) => sum + stage.amount, 0);
      const residual = Math.max(0, escrow.releasedAmount - tracked);
      return residual > 0 ? [{
        id: `escrow-release-${escrow.id}`,
        type: 'credit' as const,
        category: 'ESCROW_RELEASE' as const,
        amount: residual,
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
        totalEarnings: availableBalance,
        escrowBalance,
        releasedThisMonth: transactions.filter(tx => tx.createdAt >= monthStart).reduce((sum, tx) => sum + tx.amount, 0),
        releasedTransactionsCount: transactions.length,
        fundedProjectsCount: escrows.filter(escrow => (escrow.project.contract?.price || escrow.amount) > escrow.releasedAmount).length,
        completedProjectsCount: escrows.filter(escrow => escrow.project.status === 'COMPLETED').length,
        currency: 'USD' // active escrow/contract pricing pipeline is now USD-semantic
      },
      transactions,
      escrows: escrows.filter(escrow => (escrow.project.contract?.price || escrow.amount) > escrow.releasedAmount).map(escrow => ({
        id: escrow.id,
        projectId: escrow.project.id,
        projectTitle: escrow.project.title,
        total: escrow.project.contract?.price || escrow.amount,
        released: escrow.releasedAmount,
        held: Math.max(0, (escrow.project.contract?.price || escrow.amount) - escrow.releasedAmount),
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
      amount: escrow.project.contract?.price || escrow.amount,
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
