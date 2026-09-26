import { UserStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

// Implementation Batch 3, Part B — replaces the fully mock sa-brokers
// frontend page with real AffiliateProfile/Referral/CommissionLog/
// AffiliateChannelMetric data. All aggregates below are computed
// deterministically from real rows — no AI score, no "aiFlag"/"aiNotes",
// no fabricated numbers.
//
// OPTIONAL_FUTURE_AI_SUMMARY (not built in this batch, per explicit
// instruction): a genuine future Gemini summary for this page could
// take, as real inputs, the same deterministic aggregates already
// computed here (conversionRate, totalReferrals, commission totals,
// channel count) plus User.aiRiskScore/aiRiskLevel/aiSuspiciousNotes
// (which already exist on User for a DIFFERENT, general-purpose risk
// concept — not affiliate-specific) and produce a plain-language,
// advisory-only explanation for a human admin. It would never itself
// decide to suspend an account or freeze commissions. Deliberately not
// implemented here — this page must work fully without it.

const ALLOWED_STATUSES = new Set<UserStatus>([
  UserStatus.PENDING_VERIFICATION,
  UserStatus.ACTIVE,
  UserStatus.SUSPENDED,
  UserStatus.SUSPENDED_REVIEW,
]);

function computeAggregates(affiliate: {
  referrals: { status: string }[];
  commissionLogs: { status: string; amount: number }[];
  marketingChannels: unknown[];
}) {
  const totalReferrals = affiliate.referrals.length;
  const convertedReferrals = affiliate.referrals.filter((r) => r.status === 'CONVERTED').length;
  const conversionRate = totalReferrals > 0 ? Math.round((convertedReferrals / totalReferrals) * 1000) / 10 : 0;

  const paidCommission = affiliate.commissionLogs
    .filter((c) => c.status === 'APPROVED' || c.status === 'PAID')
    .reduce((sum, c) => sum + c.amount, 0);
  const pendingCommission = affiliate.commissionLogs
    .filter((c) => c.status === 'PENDING')
    .reduce((sum, c) => sum + c.amount, 0);

  return {
    totalReferrals,
    convertedReferrals,
    conversionRate,
    paidCommission,
    pendingCommission,
    channelCount: affiliate.marketingChannels.length,
  };
}

export class AdminBrokersService {
  async listBrokers(opts: { page?: number; limit?: number; search?: string; status?: UserStatus }) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(100, Math.max(1, opts.limit || 20));

    const userWhere: Record<string, unknown> = {};
    if (opts.status && ALLOWED_STATUSES.has(opts.status)) {
      userWhere.status = opts.status;
    }
    if (opts.search) {
      const q = opts.search.trim();
      if (q) {
        userWhere.OR = [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ];
      }
    }
    const where = { user: userWhere };

    const [rows, total] = await Promise.all([
      prisma.affiliateProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, status: true, createdAt: true } },
          referrals: { select: { status: true } },
          commissionLogs: { select: { status: true, amount: true } },
          marketingChannels: { select: { id: true } },
        },
      }),
      prisma.affiliateProfile.count({ where }),
    ]);

    const items = rows.map((affiliate) => {
      const aggregates = computeAggregates(affiliate);
      return {
        id: affiliate.userId,
        name: `${affiliate.firstName || affiliate.user.firstName || ''} ${affiliate.lastName || affiliate.user.lastName || ''}`.trim() || null,
        email: affiliate.user.email,
        referralSlug: affiliate.referralSlug,
        level: affiliate.currentLevel,
        status: affiliate.user.status,
        joinedAt: affiliate.user.createdAt,
        ...aggregates,
      };
    });

    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async getBrokerDetail(userId: string) {
    const affiliate = await prisma.affiliateProfile.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, status: true, createdAt: true } },
        referrals: { select: { status: true } },
        commissionLogs: { select: { status: true, amount: true } },
        marketingChannels: { select: { platform: true, handle: true, url: true } },
        channelMetrics: { select: { channel: true, visitors: true, clients: true, conversionPercentage: true } },
        customLinks: { select: { channelName: true, utmSource: true, customSlug: true, createdAt: true } },
      },
    });
    if (!affiliate) throw new AppError('الوسيط غير موجود', 404);

    const aggregates = computeAggregates(affiliate);

    const recentCommissionRows = await prisma.commissionLog.findMany({
      where: { affiliateId: affiliate.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        type: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        referral: { select: { referredUser: { select: { firstName: true, lastName: true } } } },
      },
    });
    const recentCommissions = recentCommissionRows.map((c) => ({
      type: c.type,
      amount: c.amount,
      currency: c.currency,
      status: c.status,
      createdAt: c.createdAt,
      referredUserName: c.referral?.referredUser ? `${c.referral.referredUser.firstName} ${c.referral.referredUser.lastName}`.trim() : null,
    }));

    return {
      id: affiliate.userId,
      name: `${affiliate.firstName || affiliate.user.firstName || ''} ${affiliate.lastName || affiliate.user.lastName || ''}`.trim() || null,
      email: affiliate.user.email,
      referralSlug: affiliate.referralSlug,
      level: affiliate.currentLevel,
      status: affiliate.user.status,
      joinedAt: affiliate.user.createdAt,
      channels: affiliate.marketingChannels,
      channelMetrics: affiliate.channelMetrics,
      customLinks: affiliate.customLinks,
      recentCommissions,
      ...aggregates,
    };
  }
}

export const adminBrokersService = new AdminBrokersService();
