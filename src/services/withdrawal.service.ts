import { WithdrawalStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { RejectWithdrawalInput, ResolveWithdrawalInput } from '../dtos/withdrawal.dto';

export class WithdrawalService {
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
    return prisma.$transaction(async tx => {
      const debited = await tx.user.updateMany({ where: { id: item.userId, walletBalance: { gte: item.amount } }, data: { walletBalance: { decrement: item.amount } } });
      if (debited.count !== 1) throw new AppError('رصيد المستخدم غير كافٍ لتنفيذ السحب', 400);
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
