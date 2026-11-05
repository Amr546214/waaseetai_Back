import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { round2, sumMoney } from '../utils/money';

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

// One wallet-history row. The list (getWallet) and the single-transaction read (getTransaction) build rows through the SAME functions, so a row opened by id is
// exactly the row the list showed.
const escrowRow = (p: any) => ({
  id: `escrow-${p.escrow!.id}`,
  type: 'ESCROW_LOCK',
  amount: round2(p.escrow!.amount),
  currency: 'USD', // active escrow pricing is now USD-semantic (not a stored WalletTransaction row)
  status: p.escrow!.status === 'HELD' ? 'HELD' : 'COMPLETED',
  paymentMethod: p.escrow!.paymentMethod || 'محفظة وسيط AI',
  referenceId: p.escrow!.paymentReference || p.id,
  description: `تمويل ضمان المشروع: ${p.title}`,
  createdAt: p.escrow!.fundedAt || p.escrow!.createdAt
});

const walletRow = (tx: any) => ({
  id: tx.id,
  type: tx.type,
  amount: round2(tx.amount),
  currency: tx.currency,
  status: tx.status,
  paymentMethod: tx.paymentMethod,
  referenceId: tx.referenceId,
  description: tx.description || (tx.type === 'DEPOSIT' ? 'إيداع رصيد بالمحفظة' : 'معاملة مالية'),
  createdAt: tx.createdAt
});

const failedDepositRow = (p: any) => ({
  id: `paypal-failed-${p.id}`,
  type: 'DEPOSIT',
  amount: round2(Number(p.netAmount ?? p.amount)),
  currency: p.currency || 'USD',
  status: 'FAILED',
  paymentMethod: 'PAYPAL',
  referenceId: p.reference,
  description: 'محاولة إيداع عبر PayPal لم تكتمل، ولم يُضف أي مبلغ إلى رصيدك',
  createdAt: p.createdAt
});

// the counterpart's name as the project room already shows it to the client; null when no provider is assigned yet
const providerName = (u: { firstName?: string | null; lastName?: string | null } | null | undefined) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || null : null);

const NOT_FOUND = 'المعاملة غير موجودة أو لا تملك صلاحية الوصول إليها';

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
   * One wallet transaction by the id the wallet list shows. Owner only: a row that is not the caller's answers 404 exactly like a row that does not exist.
   * Ids: a stored WalletTransaction id, `escrow-<escrowId>` (an escrow funding with no wallet row) or `paypal-failed-<id>` (a denied PayPal attempt).
   * Besides the list row it returns what the backend really has: the project it belongs to and, for an escrow, the held / released amounts.
   */
  async getTransaction(clientId: string, rawId: string) {
    const id = String(rawId || '').trim();
    if (!id || id.length > 200) throw new AppError(NOT_FOUND, 404);

    if (id.startsWith('escrow-')) {
      const escrowId = id.slice('escrow-'.length);
      const project = await prisma.project.findFirst({ where: { clientId, escrow: { is: { id: escrowId } } }, include: { escrow: true, provider: { select: { firstName: true, lastName: true } } } });
      if (!project || !project.escrow) throw new AppError(NOT_FOUND, 404);
      return {
        ...escrowRow(project),
        project: { id: project.id, title: project.title, providerName: providerName(project.provider) },
        escrow: { amount: round2(project.escrow.amount), releasedAmount: round2(project.escrow.releasedAmount), status: project.escrow.status }
      };
    }

    if (id.startsWith('paypal-failed-')) {
      const payment = await prisma.paypalPayment.findFirst({ where: { id: id.slice('paypal-failed-'.length), userId: clientId, status: 'FAILED' } });
      if (!payment) throw new AppError(NOT_FOUND, 404);
      return { ...failedDepositRow(payment), project: null, escrow: null };
    }

    const tx = await prisma.walletTransaction.findFirst({ where: { id, userId: clientId } });
    if (!tx) throw new AppError(NOT_FOUND, 404);
    // The project is shown only when the stored metadata names one that is THIS client's.
    const meta = tx.metadata && typeof tx.metadata === 'object' && !Array.isArray(tx.metadata) ? (tx.metadata as Record<string, unknown>) : {};
    const projectId = typeof meta.projectId === 'string' ? meta.projectId : null;
    const project = projectId ? await prisma.project.findFirst({ where: { id: projectId, clientId }, select: { id: true, title: true, provider: { select: { firstName: true, lastName: true } } } }) : null;
    return { ...walletRow(tx), project: project ? { id: project.id, title: project.title, providerName: providerName(project.provider) } : null, escrow: null };
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

    const escrowBalance = sumMoney(activeEscrows.map(esc => Math.max(0, esc.amount - esc.releasedAmount)));
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
      .map(p => escrowRow(p));

    const formattedWalletTx = walletTransactions.map(tx => walletRow(tx));

    // A deposit attempt that PayPal denied / that failed validation is never credited and has no WalletTransaction: show it as a FAILED row so the client sees what happened.
    const failedDeposits = await prisma.paypalPayment.findMany({ where: { userId: clientId, status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 50 });
    const failedDepositRows = failedDeposits.map(p => failedDepositRow(p));

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
        currency: 'USD'
      },
      transactions: allTransactions
    };
  }
}

export const clientFinanceService = new ClientFinanceService();
