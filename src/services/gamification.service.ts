import { prisma } from '../config/db';
import { LEVEL_MATRIX, deriveProviderProgression } from '../utils/progression-calculators';

// Phase 3D.3A: LEVEL_MATRIX now lives in progression-calculators.ts (a pure
// module with no Prisma/DB imports) — re-exported here unchanged so existing
// importers of `LEVEL_MATRIX from '../services/gamification.service'`
// (role-display-resolver.ts, provider-profile.service.ts) need no changes.
export { LEVEL_MATRIX };

class GamificationService {
  async getLevelDetails(providerId: string) {
    // 1. LIVE DATABASE AGGREGATION LOGIC
    const completedProjects = await prisma.project.count({
      where: { providerId, status: 'COMPLETED' }
    });

    const pointsSum = await prisma.pointTransaction.aggregate({
      where: { providerId },
      _sum: { amount: true }
    });
    const totalPoints = pointsSum._sum.amount || 0; // STRICTLY 0 FOR NEW USERS

    const ratingAggregate = await prisma.review.aggregate({
      where: { providerId, reviewerRole: 'CLIENT' },
      _avg: { rating: true }
    });
    const avgRating = Number(ratingAggregate._avg.rating || 0);

    // 1B. FETCH DYNAMIC RULES
    let rules = await prisma.gamificationRule.findMany();
    if (rules.length === 0) {
      // Seed default rules if table is empty
      const defaultRules = [
        { code: 'GAIN_PROJECT_COMPLETE', type: 'GAIN' as const, label: 'إكمال مشروع بنجاح', points: 50 },
        { code: 'GAIN_REFERRAL', type: 'GAIN' as const, label: 'إحالة عميل جديد', points: 30 },
        { code: 'GAIN_HIGH_RATING', type: 'GAIN' as const, label: 'تقييم عالي من العميل (>4 نجوم)', points: 15 },
        { code: 'GAIN_DETAILED_RATING', type: 'GAIN' as const, label: 'تقييم مفصل', points: 10 },
        { code: 'GAIN_EARLY_DELIVERY', type: 'GAIN' as const, label: 'تسليم في الوقت (قبل الموعد)', points: 10 },
        { code: 'GAIN_FAST_ACCEPT', type: 'GAIN' as const, label: 'قبول طلب سريع (خلال ساعة)', points: 5 },
        { code: 'GAIN_AI_APPROVED', type: 'GAIN' as const, label: 'نموذج خدمة معتمد (تقييم AI >80%)', points: 1 },
        { code: 'LOSS_LATE_DELIVERY', type: 'LOSS' as const, label: 'تأخير التسليم (أكثر من 48 ساعة)', points: -25 },
        { code: 'LOSS_CANCEL_AFTER_ACCEPT', type: 'LOSS' as const, label: 'إلغاء مشروع بعد القبول', points: -20 },
        { code: 'LOSS_LOW_RATING', type: 'LOSS' as const, label: 'تقييم منخفض من العميل (أقل من 3 نجوم)', points: -15 }
      ];
      await prisma.gamificationRule.createMany({ data: defaultRules });
      rules = await prisma.gamificationRule.findMany();
    }

    const gainRules = rules.filter(r => r.type === 'GAIN').map(r => ({ label: r.label, points: `+${r.points} نقطة` }));
    const lossRules = rules.filter(r => r.type === 'LOSS').map(r => ({ label: r.label, points: `${r.points} نقطة` }));

    const points = totalPoints;

    // 2. DYNAMIC LEVEL & GAP CALCULATOR ENGINE
    // Phase 3D.3A: delegates the 3-dimensional level qualification (points
    // AND completedProjects AND avgRating, all inclusive >=) to the shared
    // pure helper also used by reviewDelivery/rateRequest, so this endpoint's
    // computed level can never again disagree with what those mutation paths
    // persist. Same LEVEL_MATRIX, same semantics — behavior-preserving.
    const progression = deriveProviderProgression({ points, completedProjects, avgRating });
    const currentLevel = LEVEL_MATRIX.find(level => level.index === progression.currentLevelIndex) || LEVEL_MATRIX[0];

    // Sync Gamification table (Optional cache) — now also persists
    // currentLevelIndex/currentCommission (previously frozen at their
    // creation-time defaults forever), so this endpoint's returned level and
    // the persisted ProviderGamification row agree after every call.
    let gamification = await prisma.providerGamification.upsert({
      where: { providerId },
      update: {
        points: totalPoints,
        completedProjects,
        avgRating,
        currentLevelIndex: progression.currentLevelIndex,
        currentCommission: progression.currentCommission
      },
      create: {
        providerId,
        points: totalPoints,
        completedProjects,
        avgRating,
        currentLevelIndex: progression.currentLevelIndex,
        currentCommission: progression.currentCommission
      }
    });

    // Matrix-derived max index (no hardcoded literal) — mirrors the same
    // pattern progression-calculators.ts uses.
    const maxLevelIndex = LEVEL_MATRIX[LEVEL_MATRIX.length - 1].index;
    const nextLevelIndex = Math.min(currentLevel.index + 1, maxLevelIndex);
    const nextLevel = LEVEL_MATRIX.find(l => l.index === nextLevelIndex)!;

    const pointsGap = Math.max(0, nextLevel.reqPoints - points);
    const projectsGap = Math.max(0, nextLevel.reqProjects - completedProjects);
    const ratingGap = Math.max(0, Number((nextLevel.reqRating - avgRating).toFixed(2)));
    
    const pointsPercent = nextLevel.reqPoints > 0 ? Math.min(100, (points / nextLevel.reqPoints) * 100) : 100;
    const projectsPercent = nextLevel.reqProjects > 0 ? Math.min(100, (completedProjects / nextLevel.reqProjects) * 100) : 100;
    const ratingPercent = nextLevel.reqRating > 0 ? Math.min(100, (avgRating / nextLevel.reqRating) * 100) : 100;

    const roadmap = LEVEL_MATRIX.map(level => ({
      ...level,
      isCurrent: level.index === currentLevel.index
    }));

    let aiRecommendation = '';
    if (completedProjects === 0) {
      aiRecommendation = 'مرحباً بك! ابدأ بنشر نموذج خدمتك الأول في السوق وقدم على المشاريع المتاحة لكسب أول 50 نقطة والارتقاء لمستوى \'مستكشف\'.';
    } else if (currentLevel.index === 15) {
      aiRecommendation = 'أنت في أعلى مستوى مؤسسي! حافظ على أدائك الاستثنائي.';
    } else {
      aiRecommendation = `توصية الذكاء: أكمل ${projectsGap} مشاريع إضافية للوصول للمستوى التالي. التسليم في الوقت (+15 نقطة) والتقييم المفصل (+10 نقطة) أسرع طريقة لكسب النقاط المتبقية وخفض عمولة المنصة.`;
    }

    return {
      currentStats: {
        points: points,
        completedProjects: completedProjects,
        avgRating: avgRating,
        commissionRate: currentLevel.commission
      },
      currentLevel: {
        index: currentLevel.index,
        title: currentLevel.title
      },
      nextLevelProgress: {
        title: nextLevel.title,
        pointsGap,
        projectsGap,
        ratingGap: Number(ratingGap.toFixed(1)),
        pointsPercent,
        projectsPercent,
        ratingPercent,
        nextCommission: nextLevel.commission
      },
      aiRecommendation,
      roadmap,
      pointRules: {
        gainRules,
        lossRules
      }
    };
  }
}

export const gamificationService = new GamificationService();
