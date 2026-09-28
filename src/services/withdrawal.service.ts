import { Prisma, WithdrawalStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateWithdrawalInput, RejectWithdrawalInput, ResolveWithdrawalInput } from '../dtos/withdrawal.dto';
import { providerFinanceService } from './provider-finance.service';
import { isRetryableTransactionConflict } from '../utils/prisma-retry.util';

const MAX_SERIALIZATION_RETRIES = 3;

export class WithdrawalService {
  /**
   * Provider balance is COMPUTED from Escrow.releasedAmount, not a stored
   * field — so unlike depositEscrow()'s/PayPal's conditional-decrement
   * pattern, there is no single row to atomically guard here. Instead the
   * whole read-check-create sequence (released earnings, existing pending
   * withdrawals, and the new Withdrawal insert) runs as ONE SERIALIZABLE
   * transaction. Under plain READ COMMITTED (Prisma's default), two
   * concurrent calls for the same provider could both read the same "not
   * yet reserved" pending-withdrawal sum and both succeed, together
   * exceeding what was actually released — a plain $transaction wrapper
   * alone does not prevent this, since each transaction would still see its
   * own consistent-but-stale snapshot. SERIALIZABLE makes Postgres itself
   * detect the read (withdrawal.aggregate) / write (withdrawal.create)
   * conflict between the two and abort one of them; that loser is retried
   * here, re-reading the now-current state, rather than treated as an
   * error — see isRetryableTransactionConflict() for exactly which error
   * shapes this project's Prisma 7 driver-adapter runtime can raise for
   * that conflict, and why both are checked, not just the classic P2034.
   */
  async createForProvider(userId: string, input: CreateWithdrawalInput) {
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          // Reads via `tx`, not the global `prisma` — the released-earnings
          // computation must be part of the same serializable snapshot as
          // the pending-withdrawal read and the insert below, not a read
          // taken from outside the transaction.
          const wallet = await providerFinanceService.getWallet(userId, tx);
          const availableBalance = wallet.summary.availableBalance;
          if (input.amount > availableBalance) {
            throw new AppError(`المبلغ المطلوب يتجاوز رصيدك المتاح (${availableBalance} $)`, 400);
          }
          const pendingWithdrawals = await tx.withdrawal.aggregate({
            where: { userId, status: WithdrawalStatus.PENDING },
            _sum: { amount: true },
          });
          const pendingAmount = pendingWithdrawals._sum.amount || 0;
          const withdrawable = availableBalance - pendingAmount;
          if (input.amount > withdrawable) {
            throw new AppError(`المبلغ المطلوب يتجاوز رصيدك الصافي بعد طلبات السحب المعلقة (${withdrawable} $)`, 400);
          }
          return tx.withdrawal.create({
            data: {
              userId,
              amount: input.amount,
              currency: 'USD', // new withdrawal requests are USD — never rely on the
              // schema's historical 'SAR' default. Existing rows keep whatever
              // currency they were created with; this only affects new creates.
              method: input.method,
              accountName: input.accountName || null,
              accountNumber: input.accountNumber || null,
              iban: input.iban || null,
              status: WithdrawalStatus.PENDING,
            },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        // Bounded retry, and ONLY for a recognized transaction-conflict
        // shape (see isRetryableTransactionConflict) — every other error,
        // including the plain AppError validation-rejection thrown inside
        // the transaction above, propagates immediately and unmodified.
        if (isRetryableTransactionConflict(error) && attempt < MAX_SERIALIZATION_RETRIES) continue;
        throw error;
      }
    }
    // Unreachable in practice — the loop above always returns or throws on
    // its final attempt — kept only to satisfy TypeScript's control-flow
    // analysis without an unsafe non-null assertion.
    throw new AppError('تعذر إنشاء طلب السحب بعد عدة محاولات متزامنة، حاول مرة أخرى', 409);
  }

  async listForUser(userId: string, status?: WithdrawalStatus, page = 1, limit = 10) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const where = { userId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      prisma.withdrawal.count({ where }),
    ]);
    return {
      items,
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
    };
  }

  async list(status?: WithdrawalStatus, page = 1, limit = 20) {
    const safePage = Math.max(1, page); const safeLimit = Math.min(100, Math.max(1, limit));
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      prisma.withdrawal.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, accountType: true } }, reviewedBy: { select: { id: true, firstName: true, lastName: true } } } }),
      prisma.withdrawal.count({ where })
    ]);
    return { items, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
  }

  async get(id: string) {
    const item = await prisma.withdrawal.findUnique({ where: { id }, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, accountType: true, walletBalance: true, ibanNumber: true, bankName: true } }, reviewedBy: { select: { id: true, firstName: true, lastName: true } } } });
    if (!item) throw new AppError('طلب السحب غير موجود', 404);
    return item;
  }

  async approve(id: string, adminId: string, input: ResolveWithdrawalInput) {
    const item = await prisma.withdrawal.findUnique({ where: { id } });
    if (!item) throw new AppError('طلب السحب غير موجود', 404);
    if (item.status !== WithdrawalStatus.PENDING) throw new AppError('طلب السحب تمت معالجته مسبقاً', 409);
    const wallet = await providerFinanceService.getWallet(item.userId);
    const availableBalance = wallet.summary.availableBalance;
    const alreadyWithdrawn = await prisma.withdrawal.aggregate({
      where: { userId: item.userId, status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.COMPLETED] } },
      _sum: { amount: true },
    });
    const withdrawnAmount = alreadyWithdrawn._sum.amount || 0;
    const withdrawableBalance = availableBalance - withdrawnAmount;
    if (item.amount > withdrawableBalance) {
      throw new AppError(`رصيد المزود غير كافٍ لتنفيذ السحب (المتاح: ${withdrawableBalance} $)`, 400);
    }
    return prisma.$transaction(async tx => {
      await tx.walletTransaction.create({ data: { userId: item.userId, type: 'WITHDRAWAL', amount: -item.amount, currency: item.currency, status: 'COMPLETED', paymentMethod: item.method, referenceId: item.referenceId, description: `اعتماد طلب السحب ${item.id}`, metadata: { withdrawalId: item.id } } });
      return tx.withdrawal.update({ where: { id }, data: { status: WithdrawalStatus.APPROVED, reviewedById: adminId, adminNote: input.adminNote } });
    });
  }

  async reject(id: string, adminId: string, input: RejectWithdrawalInput) {
    const item = await prisma.withdrawal.findUnique({ where: { id } });
    if (!item) throw new AppError('طلب السحب غير موجود', 404);
    if (item.status !== WithdrawalStatus.PENDING) throw new AppError('طلب السحب تمت معالجته مسبقاً', 409);
    return prisma.withdrawal.update({ where: { id }, data: { status: WithdrawalStatus.REJECTED, reviewedById: adminId, rejectionReason: input.rejectionReason } });
  }
}

export const withdrawalService = new WithdrawalService();
