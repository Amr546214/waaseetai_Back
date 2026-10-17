import { CommissionStatus, WithdrawalStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { readAffiliatePaypalEmail } from '../utils/affiliate-payout';
import { IN_FLIGHT_WITHDRAWAL_STATUSES, RESERVING_WITHDRAWAL_STATUSES } from '../utils/withdrawal-reservation';
import { isProviderIdentity, MARKETER_PAYPAL_REQUIRED_MESSAGE } from './withdrawal.service';

/** The same 300 floor createForMarketer() enforces for everyone (a higher per-affiliate minimum wins). */
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
    const minimumWithdrawal = Math.max(affiliate?.minimumPayoutAmount ?? MARKETER_MIN_WITHDRAWAL_FLOOR, MARKETER_MIN_WITHDRAWAL_FLOOR);

    // Why a withdrawal cannot be requested right now, shown next to the disabled button (null = it can).
    let withdrawBlockedReason: string | null = null;
    if (!affiliate) withdrawBlockedReason = 'ملف الوسيط التسويقي غير مكتمل';
    else if (owner && isProviderIdentity(owner)) withdrawBlockedReason = 'سحب العمولات غير متاح حاليًا للحسابات التي تجمع بين دور الوسيط ودور مقدم الخدمة، يرجى التواصل مع الدعم';
    else if (!paypalEmail) withdrawBlockedReason = MARKETER_PAYPAL_REQUIRED_MESSAGE;
    else if (withdrawableBalance < minimumWithdrawal) withdrawBlockedReason = `رصيدك القابل للسحب أقل من الحد الأدنى (${minimumWithdrawal} $)`;

    return {
      currency: 'USD',
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
  }
};
