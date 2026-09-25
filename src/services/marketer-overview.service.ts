import { SourceChannel, CommissionStatus, UserRole } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { prisma } from '../config/db';
import { generateReferralSlug } from '../utils/slug.util';
import { initializeRoleState } from './account-management.service';

export class MarketerOverviewService {
  /**
   * Helper: Get or Create Affiliate Profile
   */
  private async getOrCreateProfile(userId: string) {
    const affiliateInclude = {
      referrals: { where: { status: 'CONVERTED' as const } },
      commissionLogs: { where: { status: 'APPROVED' as const } },
      channelMetrics: true,
    };

    let affiliate = await prisma.affiliateProfile.findUnique({ where: { userId }, include: affiliateInclude });

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

      affiliate = await prisma.affiliateProfile.findUnique({ where: { userId }, include: affiliateInclude });
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

    let nextTierThreshold = 10;
    if (affiliate.currentLevel === 'موصل') nextTierThreshold = 50;
    
    let progressPercentage = (successfulReferrals / nextTierThreshold) * 100;
    if (progressPercentage > 100) progressPercentage = 100;
    if (successfulReferrals === 0) progressPercentage = 0;

    return {
      tier: affiliate.currentLevel,
      successfulReferrals,
      totalCommissions,
      overallConversionRate: parseFloat(overallConversionRate.toFixed(2)),
      nextTierThreshold,
      progressPercentage: parseFloat(progressPercentage.toFixed(2)),
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

    const commissions = await prisma.commissionLog.findMany({
      where: { affiliateId: affiliate.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        referral: {
          include: { referredUser: true },
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
   * 4. Deterministic performance-insights engine — rule-based tips computed
   * directly from the affiliate's real channel/referral data (no AI provider
   * call). Kept as "AI Insights" in the route/method name for API
   * compatibility with the frontend, but the frontend-facing label and
   * fabricated "92% accuracy" badge that used to describe it as AI-driven
   * timing/content analysis were removed (final AI cleanup batch) since no
   * such analysis is actually performed.
   */
  async getAiInsights(userId: string) {
    const affiliate = await this.getOrCreateProfile(userId);
    const insights = [];

    if (affiliate.channelMetrics.length === 0) {
      insights.push({ text: "ابدأ ببوست تفاعلي على منصة X لجمع أول إحالة لك." });
    } else {
      const topChannel = affiliate.channelMetrics.sort((a, b) => b.conversionPercentage - a.conversionPercentage)[0];
      if (topChannel && topChannel.conversionPercentage > 0) {
        insights.push({ text: `قناة ${topChannel.channel} تحقق أفضل معدل تحويل (${topChannel.conversionPercentage}%)، ركز جهودك هناك.` });
      }
    }

    const pendingReferrals = await prisma.referral.count({
      where: { affiliateId: affiliate.id, status: 'PENDING' }
    });

    if (pendingReferrals > 0) {
      insights.push({ text: `لديك ${pendingReferrals} إحالة قيد المراجعة أو لم تكتمل بعد.` });
    }

    return insights;
  }

  /**
   * 5. Get Referral Links & Settings
   */
  async getRefLinks(userId: string) {
    let affiliate = await this.getOrCreateProfile(userId);
    
    if (!affiliate.referralSlug) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const fullName = user ? `${user.firstName} ${user.lastName}` : '';
      const slug = generateReferralSlug(fullName, userId);
      
      affiliate = await prisma.affiliateProfile.update({
        where: { id: affiliate.id },
        data: { referralSlug: slug },
        include: {
          referrals: { where: { status: 'CONVERTED' } },
          commissionLogs: { where: { status: 'APPROVED' } },
          channelMetrics: true,
        }
      });
    }

    const customLinks = await prisma.referralCustomLink.findMany({
      where: { affiliateId: affiliate.id },
      orderBy: { createdAt: 'desc' },
    });

    return {
      primarySlug: affiliate.referralSlug,
      primaryLink: `https://waseet.ai/ref/${affiliate.referralSlug}`,
      customLinks,
      settings: {
        notifyOnNewReferral: affiliate.notifyOnNewReferral,
        sharePerformanceStats: affiliate.sharePerformanceStats,
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
    
    const updated = await prisma.affiliateProfile.update({
      where: { id: affiliate.id },
      data: {
        ...(data.notifyOnNewReferral !== undefined && { notifyOnNewReferral: data.notifyOnNewReferral }),
        ...(data.sharePerformanceStats !== undefined && { sharePerformanceStats: data.sharePerformanceStats }),
      }
    });
    
    return {
      notifyOnNewReferral: updated.notifyOnNewReferral,
      sharePerformanceStats: updated.sharePerformanceStats,
    };
  }
}

export const marketerOverviewService = new MarketerOverviewService();
