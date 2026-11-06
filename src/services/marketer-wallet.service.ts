import { CommissionStatus, WithdrawalStatus } from '@prisma/client';
import { feePolicyService } from './fee-policy.service';
import { prisma } from '../config/db';
import { readAffiliatePaypalEmail } from '../utils/affiliate-payout';
import { IN_FLIGHT_WITHDRAWAL_STATUSES, RESERVING_WITHDRAWAL_STATUSES } from '../utils/withdrawal-reservation';
import { commissionBreakdown, grossCard, NOT_FOUND_TX, pageOf, stateCard, valueCard, withdrawalBreakdown } from './wallet-breakdown';
import { AppError } from '../utils/app-error';
import { isProviderIdentity, MARKETER_PAYPAL_REQUIRED_MESSAGE } from './withdrawal.service';

/** The built-in baseline floor (the fee policy's minMarketerPayout starts at this value and may be rescheduled; this constant is only the fallback). */
export const MARKETER_MIN_WITHDRAWAL_FLOOR = 300;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The marketer's money in one read, with the SAME rule createForMarketer() / approve() enforce:
 *   withdrawable = approved commissions - every withdrawal that still holds its amount (pending, approved, processing, paid, reversed).
 * A REJECTED withdrawal holds nothing, so its amount is back in the balance. The client wallet is never involved and there is no top-up.
 */
export const marketerWalletService = {
  async getWallet(userId: string) {
    const affiliate = await prisma.affiliateProfile.findUnique({ where: { userId }, select: { id: true, minimumPayoutAmount: true } });
    const [commissionGroups, withdrawalGroups, paypalEmail, owner] = await Promise.all([
      affiliate ? prisma.commissionLog.groupBy({ by: ['status'], where: { affiliateId: affiliate.id }, _sum: { amount: true } }) : Promise.resolve([]),
      prisma.withdrawal.groupBy({ by: ['status'], where: { userId }, _sum: { amount: true } }),
      readAffiliatePaypalEmail(userId, prisma),
      prisma.user.findUnique({ where: { id: userId }, select: { accountType: true, roles: true, activeRole: true } })
    ]);
    const commission = (status: CommissionStatus) => commissionGroups.find(g => g.status === status)?._sum.amount ?? 0;
    const withdrawn = (statuses: readonly WithdrawalStatus[]) => withdrawalGroups.filter(g => statuses.includes(g.status)).reduce((sum, g) => sum + (g._sum.amount ?? 0), 0);

    const approvedEarnings = commission(CommissionStatus.APPROVED);
    const reservedWithdrawals = withdrawn(IN_FLIGHT_WITHDRAWAL_STATUSES);
    const paidWithdrawals = withdrawn([WithdrawalStatus.COMPLETED, WithdrawalStatus.REVERSED]);
    const holding = withdrawn(RESERVING_WITHDRAWAL_STATUSES);
    const withdrawableBalance = Math.max(0, round2(approvedEarnings - holding));
    // the floor is the minimum marketer payout of the fee policy in force (baseline 300); a higher per-affiliate minimum still wins
    const floor = (await feePolicyService.active()).payload.minMarketerPayout;
    const minimumWithdrawal = Math.max(affiliate?.minimumPayoutAmount ?? floor, floor);

    // Why a withdrawal cannot be requested right now, shown next to the disabled button (null = it can).
    let withdrawBlockedReason: string | null = null;
    if (!affiliate) withdrawBlockedReason = 'ملف الوسيط التسويقي غير مكتمل';
    else if (owner && isProviderIdentity(owner)) withdrawBlockedReason = 'سحب العمولات غير متاح حاليًا للحسابات التي تجمع بين دور الوسيط ودور مقدم الخدمة، يرجى التواصل مع الدعم';
    else if (!paypalEmail) withdrawBlockedReason = MARKETER_PAYPAL_REQUIRED_MESSAGE;
    else if (withdrawableBalance < minimumWithdrawal) withdrawBlockedReason = `رصيدك القابل للسحب أقل من الحد الأدنى (${minimumWithdrawal} $)`;

    // Cards. availableToWithdraw is the figure createForMarketer enforces. The platform bears the marketer commission, so the gross equals the net: no deduction applies.
    const earnedGroups = commissionGroups.filter(g => g.status === CommissionStatus.APPROVED || g.status === CommissionStatus.PAID);
    const earnedTotal = earnedGroups.reduce((sum, g) => sum + (g._sum.amount ?? 0), 0);
    const cards = {
      availableToWithdraw: valueCard('المتاح للسحب', withdrawableBalance, { covers: ['COMMISSION'], note: 'عمولات معتمدة بعد خصم طلبات السحب القائمة' }),
      pendingWithdrawals: valueCard('طلبات سحب معلّقة', reservedWithdrawals),
      grossBeforeDeductions: valueCard('المبلغ قبل الخصومات', earnedTotal, { covers: ['COMMISSION'], note: 'لا توجد خصومات على عمولات الوسيط، المنصة تتحمل العمولة' }),
      heldInEscrow: stateCard('UNAVAILABLE', 'محجوز في الضمان', 'لا يوجد ضمان على عمولات الوسيط؛ العمولات قيد الاعتماد تظهر ضمن الأرباح المعلّقة'),
      cashback: stateCard('NOT_APPLICABLE', 'الكاش باك', 'الكاش باك ميزة لطالب الخدمة')
    };

    return {
      currency: 'USD',
      cards,
      canWithdraw: withdrawBlockedReason === null,
      approvedEarnings: round2(approvedEarnings),
      pendingEarnings: round2(commission(CommissionStatus.PENDING)),
      reservedWithdrawals: round2(reservedWithdrawals),
      paidWithdrawals: round2(paidWithdrawals),
      withdrawableBalance,
      minimumWithdrawal,
      paypalEmail,
      hasPaypal: !!paypalEmail,
      withdrawBlockedReason
    };
  },

  /** All the marketer's commission + withdrawal lines, newest first, each with its breakdown. Owner scoped by affiliate / userId. */
  async historyRows(userId: string) {
    const affiliate = await prisma.affiliateProfile.findUnique({ where: { userId }, select: { id: true } });
    let commissions: any[] = [];
    if (affiliate) {
      const basic = { id: true, type: true, amount: true, currency: true, status: true, createdAt: true } as const;
      try {
        commissions = await prisma.commissionLog.findMany({ where: { affiliateId: affiliate.id }, orderBy: { createdAt: 'desc' }, select: { ...basic, baseAmount: true, appliedPercentage: true, level: true } });
      } catch {
        // a database that has not got the snapshot columns yet: lines still show, flagged as details not recorded
        commissions = await prisma.commissionLog.findMany({ where: { affiliateId: affiliate.id }, orderBy: { createdAt: 'desc' }, select: basic });
      }
    }
    const withdrawals = await prisma.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { id: true, amount: true, currency: true, status: true, createdAt: true } });
    const rows = [
      ...commissions.map(c => ({ id: `commission-${c.id}`, kind: 'COMMISSION' as const, type: c.type as string, status: c.status as string, amount: round2(c.amount), currency: c.currency as string, title: 'عمولة إحالة', createdAt: c.createdAt as Date, breakdown: commissionBreakdown(c) })),
      ...withdrawals.map(w => ({ id: `withdrawal-${w.id}`, kind: 'WITHDRAWAL' as const, type: 'WITHDRAWAL', status: w.status as string, amount: round2(w.amount), currency: w.currency, title: 'طلب سحب', createdAt: w.createdAt, breakdown: withdrawalBreakdown(w) }))
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    return rows;
  },

  async getHistory(userId: string, query: { page?: unknown; limit?: unknown; type?: unknown }) {
    const type = typeof query.type === 'string' && query.type ? query.type.toUpperCase() : null;
    const all = await this.historyRows(userId);
    const rows = type ? all.filter(r => r.kind === type) : all;
    return { summary: await this.getWallet(userId), ...pageOf(rows, query.page, query.limit) };
  },

  async getTransaction(userId: string, rawId: string) {
    const id = String(rawId || '').trim();
    if (!id || id.length > 200) throw new AppError(NOT_FOUND_TX, 404);
    const row = (await this.historyRows(userId)).find(r => r.id === id);
    if (!row) throw new AppError(NOT_FOUND_TX, 404);
    return row;
  }
};
