import { WithdrawalStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateWithdrawalInput, RejectWithdrawalInput, ResolveWithdrawalInput } from '../dtos/withdrawal.dto';
import { providerFinanceService } from './provider-finance.service';

export class WithdrawalService {
  async createForProvider(userId: string, input: CreateWithdrawalInput) {
    const wallet = await providerFinanceService.getWallet(userId);
    const availableBalance = wallet.summary.availableBalance;
    if (input.amount > availableBalance) {
      throw new AppError(`المبلغ المطلوب يتجاوز رصيدك المتاح (${availableBalance} ريال)`, 400);
    }
    const pendingWithdrawals = await prisma.withdrawal.aggregate({
      where: { userId, status: WithdrawalStatus.PENDING },
      _sum: { amount: true },
    });
    const pendingAmount = pendingWithdrawals._sum.amount || 0;
    if (input.amount > availableBalance - pendingAmount) {
      throw new AppError(`المبلغ المطلوب يتجاوز رصيدك الصافي بعد طلبات السحب المعلقة (${availableBalance - pendingAmount} ريال)`, 400);
    }
    return prisma.withdrawal.create({
      data: {
        userId,
        amount: input.amount,
        method: input.method,
        accountName: input.accountName || null,
        accountNumber: input.accountNumber || null,
        iban: input.iban || null,
        status: WithdrawalStatus.PENDING,
      },
    });
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
      throw new AppError(`رصيد المزود غير كافٍ لتنفيذ السحب (المتاح: ${withdrawableBalance} ريال)`, 400);
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
