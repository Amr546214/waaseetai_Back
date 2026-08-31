import { prisma } from '../config/db';
import { moyasarService } from './moyasar.service';
import { LogCategory, LogStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppError } from '../utils/app-error';

const VAT_RATE = 0.15;

const buildInvoice = (contract: any, stage: any, delivery: any) => {
  const total = Number(stage.amount || 0);
  const subtotal = Number((total / (1 + VAT_RATE)).toFixed(2));
  const tax = Number((total - subtotal).toFixed(2));
  const issuedAt = delivery.submittedAt as Date;
  const status: 'paid' | 'due' = stage.status === 'APPROVED' && delivery.status === 'APPROVED' ? 'paid' : 'due';
  const verificationChecks = [
    Boolean(contract.id && contract.signedAt),
    Boolean(contract.provider?.firstName && contract.provider?.lastName),
    Boolean(contract.provider?.commercialRegistration || contract.provider?.vatCertificateUrl),
    total > 0,
    Boolean(issuedAt)
  ];
  const verificationScore = Math.round(verificationChecks.filter(Boolean).length / verificationChecks.length * 100);

  return {
    id: `INV-${issuedAt.getFullYear()}-${String(delivery.id).replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    sourceId: delivery.id,
    contractId: contract.id,
    projectId: contract.projectId,
    stageId: stage.id,
    providerName: `${contract.provider.firstName || 'مقدم الخدمة'} ${contract.provider.lastName || ''}`.trim(),
    date: issuedAt.toISOString(),
    project: `${contract.project.title} · ${stage.title}`,
    projectTitle: contract.project.title,
    stageTitle: stage.title,
    subtotal,
    total,
    tax,
    taxRate: VAT_RATE * 100,
    status,
    paymentDate: status === 'paid' ? (stage.approvedAt || delivery.reviewedAt || null) : null,
    verificationScore,
    taxDocumentAvailable: Boolean(contract.provider.vatCertificateUrl),
    commercialRegistrationAvailable: Boolean(contract.provider.commercialRegistration)
  };
};

export class ClientFinanceService {
  /** Returns invoices derived from real contracted stage deliveries for the authenticated client. */
  async getInvoices(clientId: string) {
    const contracts = await prisma.contract.findMany({
      where: { clientId },
      orderBy: { updatedAt: 'desc' },
      include: {
        project: { select: { title: true } },
        provider: { select: { firstName: true, lastName: true, commercialRegistration: true, vatCertificateUrl: true } },
        stages: {
          where: { deliveries: { some: {} } },
          orderBy: { stepOrder: 'asc' },
          include: { deliveries: { orderBy: { submittedAt: 'desc' }, take: 1 } }
        }
      }
    });

    const invoices = contracts.flatMap(contract => contract.stages.flatMap(stage => {
      const delivery = stage.deliveries[0];
      return delivery ? [buildInvoice(contract, stage, delivery)] : [];
    })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const paid = invoices.filter(invoice => invoice.status === 'paid');
    const due = invoices.filter(invoice => invoice.status === 'due');
    return {
      summary: {
        totalCount: invoices.length,
        paidCount: paid.length,
        dueCount: due.length,
        totalTax: Number(invoices.reduce((sum, invoice) => sum + invoice.tax, 0).toFixed(2)),
        averageVerificationScore: invoices.length
          ? Math.round(invoices.reduce((sum, invoice) => sum + invoice.verificationScore, 0) / invoices.length)
          : 0,
        currency: 'SAR'
      },
      invoices
    };
  }

  /** Returns one real invoice and enforces ownership through the contract's client. */
  async getInvoice(clientId: string, deliveryId: string) {
    const delivery = await prisma.stageDelivery.findFirst({
      where: { id: deliveryId, stage: { contract: { clientId } } },
      include: {
        stage: {
          include: {
            contract: {
              include: {
                project: { select: { title: true } },
                provider: { select: { firstName: true, lastName: true, commercialRegistration: true, vatCertificateUrl: true } }
              }
            }
          }
        }
      }
    });
    if (!delivery) throw new AppError('الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها', 404);
    return buildInvoice(delivery.stage.contract, delivery.stage, delivery);
  }

  /**
   * Retrieves the client's wallet overview, balances, and transaction history
   */
  async getWallet(clientId: string) {
    const user = await prisma.user.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        walletBalance: true
      }
    });

    if (!user) {
      throw new Error('المستخدم غير موجود');
    }

    // Escrows funded by this client that are still HELD
    const clientProjects = await prisma.project.findMany({
      where: { clientId },
      include: {
        escrow: true,
        contract: {
          select: {
            price: true,
            stages: {
              select: { id: true, title: true, amount: true, status: true }
            }
          }
        }
      }
    });

    const activeEscrows = clientProjects
      .filter(p => p.escrow && p.escrow.status === 'HELD')
      .map(p => p.escrow!);

    const escrowBalance = activeEscrows.reduce((sum, esc) => sum + Math.max(0, esc.amount - esc.releasedAmount), 0);
    const availableBalance = Number(user.walletBalance || 0);

    // Fetch all recorded wallet transactions
    const walletTransactions = await prisma.walletTransaction.findMany({
      where: { userId: clientId },
      orderBy: { createdAt: 'desc' }
    });
	const recordedReferences = new Set(walletTransactions.map(tx => tx.referenceId).filter(Boolean));

    // Also include escrow deposits for complete history
    const escrowTransactions = clientProjects
	  .filter(p => p.escrow && !recordedReferences.has(p.escrow.paymentReference))
      .map(p => ({
        id: `escrow-${p.escrow!.id}`,
        type: 'ESCROW_LOCK',
        amount: p.escrow!.amount,
        currency: 'SAR',
        status: p.escrow!.status === 'HELD' ? 'HELD' : 'COMPLETED',
        paymentMethod: p.escrow!.paymentMethod || 'محفظة وسيط AI',
        referenceId: p.escrow!.paymentReference || p.id,
        description: `تمويل ضمان المشروع: ${p.title}`,
        createdAt: p.escrow!.fundedAt || p.escrow!.createdAt
      }));

    const formattedWalletTx = walletTransactions.map(tx => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status,
      paymentMethod: tx.paymentMethod,
      referenceId: tx.referenceId,
      description: tx.description || (tx.type === 'DEPOSIT' ? 'إيداع رصيد بالمحفظة' : 'معاملة مالية'),
      createdAt: tx.createdAt
    }));

    const allTransactions = [...formattedWalletTx, ...escrowTransactions]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const totalDeposited = walletTransactions
      .filter(tx => tx.type === 'DEPOSIT' && tx.status === 'COMPLETED')
      .reduce((sum, tx) => sum + tx.amount, 0);

    return {
      summary: {
        availableBalance,
        escrowBalance,
        totalDeposited: totalDeposited || availableBalance,
        activeProjectsCount: clientProjects.filter(p => p.status === 'IN_PROGRESS' || p.status === 'OPEN').length,
        currency: 'SAR'
      },
      transactions: allTransactions
    };
  }

  /**
   * Prepares deposit session data and publishable config
   */
  async initiateDeposit(clientId: string, amount: number, paymentMethod: string = 'card') {
    if (!amount || amount < 50 || amount > 100000) {
      throw new Error('المبلغ يجب أن يكون بين 50 و 100,000 ريال سعودي');
    }

    if (paymentMethod !== 'card') {
      throw new Error('طريقة الإيداع المتاحة حالياً هي الدفع الآمن عبر ميسر');
    }

    const reference = randomUUID();

    return {
      reference,
      amount,
      currency: 'SAR',
      publishableKey: moyasarService.getPublishableKey(),
      paymentMethod,
      callbackUrl: `${process.env.FRONTEND_URL || 'http://localhost:4200'}/client-overview/finance/wallet`,
      metadata: {
        client_id: clientId,
        deposit_reference: reference,
        purpose: 'wallet_deposit'
      }
    };
  }

  /**
   * Verifies payment with Moyasar and credits the user's wallet in PostgreSQL database
   */
  async verifyAndProcessDeposit(clientId: string, payload: {
    paymentId: string;
    amount?: number;
    paymentMethod?: string;
    description?: string;
  }) {
    const { paymentId, amount } = payload;

    if (!paymentId) {
      throw new Error('معرف عملية الدفع مطلوب');
    }

    if (amount !== undefined && (!Number.isFinite(amount) || amount < 50 || amount > 100000)) {
      throw new Error('مبلغ الإيداع غير صحيح');
    }

    // 1. Check if payment was already processed (Idempotency)
    const existingTx = await prisma.walletTransaction.findFirst({
      where: { referenceId: paymentId }
    });

    if (existingTx) {
      if (existingTx.userId !== clientId) throw new Error('عملية الدفع مستخدمة مسبقاً لمحفظة أخرى');
      return this.getWallet(clientId);
    }

    // 2. Verify with Moyasar API
    const verification = await moyasarService.verifyDeposit(paymentId, amount);
    if (!verification.valid || !verification.payment) {
      throw new Error(verification.reason || 'فشل التحقق من صحة عملية الدفع');
    }

    const payment = verification.payment;
    if (payment.metadata?.client_id !== clientId || payment.metadata?.purpose !== 'wallet_deposit' || !payment.metadata?.deposit_reference) {
      throw new Error('عملية الدفع لا تخص هذه المحفظة أو تفتقد مرجع الإيداع الآمن');
    }
    const depositReference = payment.metadata.deposit_reference;

    const verifiedAmount = payment.amount / 100;
    if (!Number.isFinite(verifiedAmount) || verifiedAmount < 50 || verifiedAmount > 100000) {
      throw new Error('مبلغ عملية ميسر خارج حدود الإيداع المسموحة');
    }
    const paymentSource = payment.source?.company || payment.source?.type || 'card';
    const finalDescription = `إيداع رصيد بالمحفظة عبر ميسر (${paymentSource.toUpperCase()})`;

    // 3. Atomically credit wallet, log transaction & create audit log
    try {
      await prisma.$transaction(async tx => {
      // A. Create WalletTransaction
      await tx.walletTransaction.create({
        data: {
          userId: clientId,
          type: 'DEPOSIT',
          amount: verifiedAmount,
          currency: 'SAR',
          status: 'COMPLETED',
          paymentMethod: `MOYASAR_${paymentSource.toUpperCase()}`,
          referenceId: paymentId,
          description: finalDescription,
          metadata: {
            moyasarPaymentId: payment.id,
            depositReference,
            sourceType: payment.source?.type,
            sourceCompany: payment.source?.company
          }
        }
      });

      // B. Increment User's walletBalance
      await tx.user.update({
        where: { id: clientId },
        data: {
          walletBalance: { increment: verifiedAmount }
        }
      });

      // C. Account Audit Log
      await tx.accountAuditLog.create({
        data: {
          userId: clientId,
          category: LogCategory.SYSTEM_AUDIT,
          title: 'إيداع رصيد بالمحفظة',
          actionText: `إيداع بمبلغ ${verifiedAmount.toLocaleString('en-US')} ريال عبر ${paymentSource.toUpperCase()}`,
          status: LogStatus.COMPLETED,
          statusText: 'مكتمل بنجاح',
          summary: `تم شحن المحفظة بمبلغ ${verifiedAmount} ر.س - رقم المرجع: ${paymentId}`,
          source: 'USER',
          eventType: 'WALLET_DEPOSIT_COMPLETED',
          severity: 'INFO'
        }
      });

      // D. Notification
      await tx.notification.create({
        data: {
          userId: clientId,
          title: 'تم إيداع الرصيد بنجاح',
          message: `أُضيف مبلغ ${verifiedAmount.toLocaleString('en-US')} ريال إلى رصيد محفظتك، يمكنك الآن استخدامه لتمويل المشاريع.`,
          type: 'FINANCIAL',
          category: 'FINANCIAL',
          actionUrl: '/dashboard/clients-overview/finance/wallet',
          actionText: 'عرض المحفظة'
        }
      });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const processed = await prisma.walletTransaction.findUnique({ where: { referenceId: paymentId } });
        if (processed?.userId === clientId) return this.getWallet(clientId);
      }
      throw error;
    }

    return this.getWallet(clientId);
  }
}

export const clientFinanceService = new ClientFinanceService();
