import { CommissionStatus, WithdrawalStatus } from '@prisma/client';
import { feePolicyService } from './fee-policy.service';
import { prisma } from '../config/db';
import { readAffiliatePaypalEmail } from '../utils/affiliate-payout';
import { IN_FLIGHT_WITHDRAWAL_STATUSES, RESERVING_WITHDRAWAL_STATUSES } from '../utils/withdrawal-reservation';
import { isProviderIdentity, MARKETER_PAYPAL_REQUIRED_MESSAGE } from './withdrawal.service';
import { LEGACY_CURRENCY } from '../utils/currency';

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
      affiliate ? prisma.commissionLog.groupBy({ by: ['status', 'currency'], where: { affiliateId: affiliate.id }, _sum: { amount: true } }) : Promise.resolve([]),
      prisma.withdrawal.groupBy({ by: ['status'], where: { userId }, _sum: { amount: true } }),
      readAffiliatePaypalEmail(userId, prisma),
      prisma.user.findUnique({ where: { id: userId }, select: { accountType: true, roles: true, activeRole: true } })
    ]);
    // earnings per currency: the figures below are the USD ones (payouts are PayPal/USD); other currencies are listed on their own and are never added in
    const commissionIn = (cur: string, status: CommissionStatus) => commissionGroups.filter(g => g.status === status && (g.currency ?? LEGACY_CURRENCY) === cur).reduce((sum, g) => sum + (g._sum.amount ?? 0), 0);
    const commission = (status: CommissionStatus) => commissionIn(LEGACY_CURRENCY, status);
    const earningsByCurrency: Record<string, { approved: number; pending: number }> = {};
    for (const g of commissionGroups) { const c = g.currency ?? LEGACY_CURRENCY; earningsByCurrency[c] ??= { approved: round2(commissionIn(c, CommissionStatus.APPROVED)), pending: round2(commissionIn(c, CommissionStatus.PENDING)) }; }
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

    return {
      currency: LEGACY_CURRENCY,
      earningsByCurrency,
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
