import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { round2, sumMoney } from '../utils/money';
import { LEGACY_CURRENCY, sumByCurrency } from '../utils/currency';
import { walletBalancesOf } from '../utils/wallet-balance';

// No tax is recorded on invoices (legal policy s10: no VAT is charged). The old 15% line was display-only and never collected, so it is gone: the invoice
// shows the stage amount, and tax is 0 / taxRate 0.

// A marketplace purchase with a provider coupon stores the service value and the discount in the contract's terms (see cart-checkout confirmPayment): the contract,
// escrow and stage amounts are already NET of the discount, so the invoice shows the service value, the coupon discount and the total actually paid.
const couponTerms = (terms: unknown): { listPrice: number; netPrice: number; couponCode: string | null } | null => {
  if (!terms || typeof terms !== 'object' || Array.isArray(terms)) return null;
  const t = terms as Record<string, unknown>;
  if (t.source !== 'marketplace_order') return null;
  const listPrice = Number(t.listPrice); const netPrice = Number(t.netPrice);
  if (!Number.isFinite(listPrice) || !Number.isFinite(netPrice) || netPrice <= 0 || listPrice <= netPrice) return null;
  return { listPrice, netPrice, couponCode: typeof t.couponCode === 'string' ? t.couponCode : null };
};

const buildInvoice = (contract: any, stage: any, delivery: any) => {
  const total = round2(Number(stage.amount || 0));
  const coupon = couponTerms(contract.terms);
  const subtotal = coupon ? round2(total * coupon.listPrice / coupon.netPrice) : total;
  const discount = coupon ? round2(subtotal - total) : 0;
  const tax = 0;
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
    discount,
    couponCode: coupon?.couponCode ?? null,
    total,
    tax,
    taxRate: 0,
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
        totalTax: sumMoney(invoices.map(invoice => invoice.tax)),
        averageVerificationScore: invoices.length
          ? Math.round(invoices.reduce((sum, invoice) => sum + invoice.verificationScore, 0) / invoices.length)
          : 0,
        currency: 'USD' // contract/stage pricing pipeline is now USD-semantic
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

    // the headline escrow balance is the USD one; every currency is also listed on its own (never one total across currencies)
    const escrowBalance = sumMoney(activeEscrows.filter(esc => (esc.currency ?? LEGACY_CURRENCY) === LEGACY_CURRENCY).map(esc => Math.max(0, esc.amount - esc.releasedAmount)));
    const escrowBalances = sumByCurrency(activeEscrows, esc => esc.currency, esc => Math.max(0, esc.amount - esc.releasedAmount));
    const balances = await walletBalancesOf(prisma, clientId);
    const availableBalance = round2(Number(user.walletBalance || 0));

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
        amount: round2(p.escrow!.amount),
        currency: p.escrow!.currency, // the escrow's own currency (not a stored WalletTransaction row)
        status: p.escrow!.status === 'HELD' ? 'HELD' : 'COMPLETED',
        paymentMethod: p.escrow!.paymentMethod || 'محفظة وسيط AI',
        referenceId: p.escrow!.paymentReference || p.id,
        description: `تمويل ضمان المشروع: ${p.title}`,
        createdAt: p.escrow!.fundedAt || p.escrow!.createdAt
      }));

    const formattedWalletTx = walletTransactions.map(tx => ({
      id: tx.id,
      type: tx.type,
      amount: round2(tx.amount),
      currency: tx.currency,
      status: tx.status,
      paymentMethod: tx.paymentMethod,
      referenceId: tx.referenceId,
      description: tx.description || (tx.type === 'DEPOSIT' ? 'إيداع رصيد بالمحفظة' : 'معاملة مالية'),
      createdAt: tx.createdAt
    }));

    // A deposit attempt that PayPal denied / that failed validation is never credited and has no WalletTransaction: show it as a FAILED row so the client sees what happened.
    const failedDeposits = await prisma.paypalPayment.findMany({ where: { userId: clientId, status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 50 });
    const failedDepositRows = failedDeposits.map(p => ({
      id: `paypal-failed-${p.id}`,
      type: 'DEPOSIT',
      amount: round2(Number(p.netAmount ?? p.amount)),
      currency: p.currency || 'USD',
      status: 'FAILED',
      paymentMethod: 'PAYPAL',
      referenceId: p.reference,
      description: 'محاولة إيداع عبر PayPal لم تكتمل، ولم يُضف أي مبلغ إلى رصيدك',
      createdAt: p.createdAt
    }));

    const allTransactions = [...formattedWalletTx, ...escrowTransactions, ...failedDepositRows]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const totalDeposited = sumMoney(walletTransactions
      .filter(tx => tx.type === 'DEPOSIT' && tx.status === 'COMPLETED')
      .map(tx => tx.amount));

    return {
      summary: {
        availableBalance,
        escrowBalance,
        totalDeposited: totalDeposited || availableBalance,
        activeProjectsCount: clientProjects.filter(p => p.status === 'IN_PROGRESS' || p.status === 'OPEN').length,
        // Canonical available wallet balance (PayPal) and active escrow/pricing
        // are both USD-semantic now. Each individual transaction below keeps
        // and exposes its OWN stored currency (tx.currency, line ~174) — this
        // top-level field only describes the two summary aggregates, never
        // relabels historical per-transaction rows.
        currency: 'USD',
        // every wallet balance and every held escrow amount in ITS OWN currency; availableBalance / escrowBalance above stay the USD figures
        balances,
        escrowBalances
      },
      transactions: allTransactions
    };
  }
}

export const clientFinanceService = new ClientFinanceService();
