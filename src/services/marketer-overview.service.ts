import { SourceChannel, CommissionStatus, UserRole } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { prisma } from '../config/db';
import { generateReferralSlug, isReferralSlugConflict } from '../utils/slug.util';
import { initializeRoleState } from './account-management.service';
import { metricSummaryEngine, type MetricSummaryEngine, type MetricSummaryResult } from './ai-features/metric-summary';
import { MARKETER_INSIGHTS_AI_FEATURE, MARKETER_INSIGHTS_ALLOW, MARKETER_INSIGHTS_PATHS, MARKETER_INSIGHTS_SYSTEM, MARKETER_TREND_DAYS, buildMarketerInsightsMetrics, marketerHasEnoughData } from './ai-features/marketer-insights.service';

export class MarketerOverviewService {
  /**
   * Helper: Get or Create Affiliate Profile
   */
  private async getOrCreateProfile(userId: string) {
    // Explicit select — deployment-safety fix. AffiliateProfile.level exists
    // in the Prisma schema but its migration has not been applied to
    // DEV/LIVE yet; the previous `include` here did NOT restrict the parent
    // model's own scalars (include only adds relations on top of a full
    // default select), so it would have requested `level` and 500'd this
    // dashboard-summary path. Only the AffiliateProfile scalars this class
    // actually reads downstream are selected — `level` is deliberately
    // excluded (see src/utils/affiliate-profile-safe-select.util.ts). The
    // nested relations are likewise restricted to exactly the fields read
    // from them below (referrals: only `.length` is used; commissionLogs:
    // only `.amount` is summed; channelMetrics: `.channel`/`.visitors`/
    // `.conversionPercentage`), so the new CommissionLog scalars can never
    // leak through this nested relation either.
    const affiliateSelect = {
      id: true,
      currentLevel: true,
      referralSlug: true,
      notifyOnNewReferral: true,
      sharePerformanceStats: true,
      referrals: { where: { status: 'CONVERTED' as const }, select: { id: true } },
      commissionLogs: { where: { status: 'APPROVED' as const }, select: { amount: true } },
      channelMetrics: { select: { channel: true, visitors: true, conversionPercentage: true } },
    };

    let affiliate = await prisma.affiliateProfile.findUnique({ where: { userId }, select: affiliateSelect });

    if (!affiliate) {
      // Phase 3D.4: routed through the same canonical role-state initializer
      // every other role-creation path uses (same referralSlug generation
      // semantics as before — full name + userId), instead of a bare
      // divergent create — seeds display fields and computes a real initial
      // completionPercentage from the exact existing Affiliate formula.
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, avatarUrl: true, email: true }
      });
      if (!user) throw new AppError('حساب المستخدم غير موجود', 404);

      await prisma.$transaction(async (tx) => {
        await initializeRoleState(tx, userId, UserRole.AFFILIATE, user);
      });

      affiliate = await prisma.affiliateProfile.findUnique({ where: { userId }, select: affiliateSelect });
      if (!affiliate) throw new AppError('تعذر تهيئة ملف الوسيط التسويقي', 500);
    }

    return affiliate;
  }

  /**
   * 1. Get Dashboard Summary
   */
  async getSummary(userId: string) {
    const affiliate = await this.getOrCreateProfile(userId);

    const successfulReferrals = affiliate.referrals.length;
    const totalCommissions = affiliate.commissionLogs.reduce((acc, log) => acc + log.amount, 0);
    
    // Average conversion rate across all channels
    const totalVisitors = affiliate.channelMetrics.reduce((acc, metric) => acc + metric.visitors, 0);
    const overallConversionRate = totalVisitors > 0 ? (successfulReferrals / totalVisitors) * 100 : 0;

    return {
      tier: affiliate.currentLevel,
      successfulReferrals,
      totalCommissions,
      overallConversionRate: parseFloat(overallConversionRate.toFixed(2)),
    };
  }

  /**
   * 2. Get Channel Performance Breakdown
   */
  async getChannelPerformance(userId: string) {
    const affiliate = await this.getOrCreateProfile(userId);

    const metrics = await prisma.affiliateChannelMetric.findMany({
      where: { affiliateId: affiliate.id }
    });

    if (metrics.length === 0) {
      return [];
    }

    return metrics.map(metric => ({
      channel: metric.channel,
      visitors: metric.visitors,
      clients: metric.clients,
      conversionPercentage: metric.conversionPercentage,
    }));
  }

  /**
   * 3. Get Recent Commissions
   */
  async getRecentCommissions(userId: string, limit = 5) {
    const affiliate = await this.getOrCreateProfile(userId);

    // Explicit select — deployment-safety fix. CommissionLog gained 6 new
    // scalars (referredUserId/sourceProjectId/sourceStageId/baseAmount/
    // appliedPercentage/level) for the P-LG-012 engine, whose migration has
    // not been applied to DEV/LIVE yet; the previous `include` fetched every
    // scalar by default and would 500 this dashboard path. Only the fields
    // the map() below actually reads are selected (matches the same pattern
    // already used safely in admin-brokers.service.ts's getBrokerDetail()).
    const commissions = await prisma.commissionLog.findMany({
      where: { affiliateId: affiliate.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        type: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        referral: {
          select: { referredUser: { select: { id: true } } },
        },
      },
    });

    return commissions.map(log => ({
      id: log.id,
      source: log.referral?.referredUser ? `إحالة عميل جديد` : 'إحالة',
      type: log.type,
      time: log.createdAt,
      amount: log.amount,
      currency: log.currency,
      status: log.status,
    }));
  }

  /**
   * 4. Marketer insights as an AiResult (MetricSummaryEngine over the affiliate's REAL aggregates). NOT_ENOUGH_DATA when there is too
   * little data (the model is never called); FAILED when the model is unavailable. Nothing is rule-generated or static.
   */
  async getAiInsights(userId: string, engine: Pick<MetricSummaryEngine, 'summarise'> = metricSummaryEngine): Promise<MetricSummaryResult> {
    const affiliate = await this.getOrCreateProfile(userId);
    const day = 86_400_000;
    const now = Date.now();
    const since30 = new Date(now - MARKETER_TREND_DAYS * day);
    const since60 = new Date(now - 2 * MARKETER_TREND_DAYS * day);

    const [grouped, last30, previous30] = await Promise.all([
      prisma.referral.groupBy({ by: ['status'], where: { affiliateId: affiliate.id }, _count: { _all: true } }),
      prisma.referral.count({ where: { affiliateId: affiliate.id, createdAt: { gte: since30 } } }),
      prisma.referral.count({ where: { affiliateId: affiliate.id, createdAt: { gte: since60, lt: since30 } } }),
    ]);

    const metrics = buildMarketerInsightsMetrics({
      channels: affiliate.channelMetrics,
      referralsByStatus: grouped.map((g) => ({ status: g.status, count: g._count._all })),
      referralsLast30Days: last30,
      referralsPrevious30Days: previous30,
      approvedCommissionAmounts: affiliate.commissionLogs.map((c) => c.amount),
    });

    return engine.summarise({
      feature: MARKETER_INSIGHTS_AI_FEATURE, userId, metrics, allow: MARKETER_INSIGHTS_ALLOW,
      paths: MARKETER_INSIGHTS_PATHS, minUsedPaths: 1, system: MARKETER_INSIGHTS_SYSTEM, hasEnoughData: marketerHasEnoughData,
    });
  }

  /**
   * 4b. Get this affiliate's own referred users, paginated. Strictly scoped
   * to the calling affiliate's OWN AffiliateProfile (resolved from userId via
   * getOrCreateProfile(), exactly like every other method in this class) —
   * never accepts or looks up another affiliate's id, so there is no way for
   * a caller to query another affiliate's referrals through this method.
   *
   * Per-referred-user fields (P-LG-012/PII-safety): display name is
   * firstName/lastName ONLY, never email/phone. "Total commission earned"
   * counts only CommissionLog rows with status APPROVED or PAID for that
   * specific referral — PENDING is deliberately excluded from this
   * caller-facing "earned" total since it has not yet cleared to an
   * available/payable state (mirrors createForMarketer()'s own withdrawable
   * balance, which likewise only sums APPROVED commissions).
   */
  async getReferredUsers(userId: string, page = 1, limit = 20) {
    const affiliate = await this.getOrCreateProfile(userId);
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
    const skip = (safePage - 1) * safeLimit;

    const [referrals, total] = await Promise.all([
      prisma.referral.findMany({
        where: { affiliateId: affiliate.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        include: {
          referredUser: { select: { firstName: true, lastName: true } },
          commissionLogs: {
            where: { status: { in: [CommissionStatus.APPROVED, CommissionStatus.PAID] } },
            select: { amount: true }
          }
        }
      }),
      prisma.referral.count({ where: { affiliateId: affiliate.id } })
    ]);

    return {
      items: referrals.map(r => ({
        referralId: r.id,
        displayName: `${r.referredUser.firstName || ''} ${r.referredUser.lastName || ''}`.trim() || 'مستخدم وسيط',
        status: r.status,
        joinedAt: r.createdAt,
        totalCommissionEarned: r.commissionLogs.reduce((sum, log) => sum + log.amount, 0)
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      }
    };
  }

  /**
   * 5. Get Referral Links & Settings
   */
  async getRefLinks(userId: string) {
    const affiliate = await this.getOrCreateProfile(userId);

    // Only these 4 fields are needed for the rest of this method — pulled
    // into their own narrower, reassignable variables instead of reassigning
    // `affiliate` itself (which carries getOrCreateProfile()'s wider
    // referrals/commissionLogs/channelMetrics shape).
    let { id: affiliateId, referralSlug, notifyOnNewReferral, sharePerformanceStats } = affiliate;

    if (!referralSlug) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const fullName = user ? `${user.firstName} ${user.lastName}` : '';
      let slug = generateReferralSlug(fullName, userId);

      // Explicit select — deployment-safety fix (see getOrCreateProfile's
      // comment above for the same class of bug). Only referralSlug/id/
      // notifyOnNewReferral/sharePerformanceStats are read from `affiliate`
      // for the rest of this method — the referrals/commissionLogs/
      // channelMetrics relations that used to be `include`d here were never
      // actually used after this reassignment, so they're dropped entirely
      // rather than converted to a nested select.
      let updated: { id: string; referralSlug: string | null; notifyOnNewReferral: boolean; sharePerformanceStats: boolean } | undefined;
      for (let attempt = 1; !updated; attempt++) {
        try {
          updated = await prisma.affiliateProfile.update({
            where: { id: affiliateId },
            data: { referralSlug: slug },
            select: {
              id: true,
              referralSlug: true,
              notifyOnNewReferral: true,
              sharePerformanceStats: true,
            }
          });
        } catch (error) {
          if (attempt >= 3 || !isReferralSlugConflict(error)) throw error;
          slug = generateReferralSlug(fullName, userId);
        }
      }
      affiliateId = updated.id;
      referralSlug = updated.referralSlug;
      notifyOnNewReferral = updated.notifyOnNewReferral;
      sharePerformanceStats = updated.sharePerformanceStats;
    }

    const customLinks = await prisma.referralCustomLink.findMany({
      where: { affiliateId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      primarySlug: referralSlug,
      primaryLink: `https://waseet.ai/ref/${referralSlug}`,
      customLinks,
      settings: {
        notifyOnNewReferral,
        sharePerformanceStats,
      }
    };
  }

  /**
   * 6. Create Custom Campaign Link
   */
  async createCustomLink(userId: string, data: { channelName: string; utmSource: string; customSlug?: string }) {
    const affiliate = await this.getOrCreateProfile(userId);
    
    const newLink = await prisma.referralCustomLink.create({
      data: {
        affiliateId: affiliate.id,
        channelName: data.channelName,
        utmSource: data.utmSource,
        customSlug: data.customSlug,
      }
    });
    
    return newLink;
  }

  /**
   * 7. Update Referral Settings
   */
  async updateSettings(userId: string, data: { notifyOnNewReferral?: boolean; sharePerformanceStats?: boolean }) {
    const affiliate = await this.getOrCreateProfile(userId);
    
    // Explicit select — deployment-safety fix; only these two fields are
    // read from the return value below.
    const updated = await prisma.affiliateProfile.update({
      where: { id: affiliate.id },
      data: {
        ...(data.notifyOnNewReferral !== undefined && { notifyOnNewReferral: data.notifyOnNewReferral }),
        ...(data.sharePerformanceStats !== undefined && { sharePerformanceStats: data.sharePerformanceStats }),
      },
      select: { notifyOnNewReferral: true, sharePerformanceStats: true }
    });
    
    return {
      notifyOnNewReferral: updated.notifyOnNewReferral,
      sharePerformanceStats: updated.sharePerformanceStats,
    };
  }
}

export const marketerOverviewService = new MarketerOverviewService();
