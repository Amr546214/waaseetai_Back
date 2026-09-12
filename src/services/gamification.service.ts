import { prisma } from '../config/db';

export const LEVEL_MATRIX = [
  { index: 1, title: 'زائر', reqPoints: 0, reqProjects: 0, reqRating: 0.0, commission: 15.0 },
  { index: 2, title: 'مستكشف', reqPoints: 50, reqProjects: 2, reqRating: 3.5, commission: 15.0 },
  { index: 3, title: 'باحث', reqPoints: 150, reqProjects: 5, reqRating: 3.8, commission: 15.0 },
  { index: 4, title: 'عميل', reqPoints: 300, reqProjects: 9, reqRating: 4.0, commission: 15.0 },
  { index: 5, title: 'داعم', reqPoints: 501, reqProjects: 13, reqRating: 4.1, commission: 14.5 },
  { index: 6, title: 'ناشط', reqPoints: 751, reqProjects: 20, reqRating: 4.2, commission: 14.0 },
  { index: 7, title: 'فعال', reqPoints: 1101, reqProjects: 30, reqRating: 4.3, commission: 13.5 },
  { index: 8, title: 'راعي', reqPoints: 1501, reqProjects: 42, reqRating: 4.4, commission: 13.0 },
  { index: 9, title: 'سفير', reqPoints: 2001, reqProjects: 55, reqRating: 4.5, commission: 12.5 },
  { index: 10, title: 'استراتيجي', reqPoints: 2601, reqProjects: 70, reqRating: 4.6, commission: 12.0 },
  { index: 11, title: 'أساسي', reqPoints: 3301, reqProjects: 85, reqRating: 4.7, commission: 11.5 },
  { index: 12, title: 'مالك', reqPoints: 4101, reqProjects: 100, reqRating: 4.8, commission: 11.0 },
  { index: 13, title: 'مؤسس', reqPoints: 5001, reqProjects: 115, reqRating: 4.85, commission: 10.5 },
  { index: 14, title: 'دائم', reqPoints: 6001, reqProjects: 130, reqRating: 4.9, commission: 10.25 },
  { index: 15, title: 'مؤسسي', reqPoints: 7201, reqProjects: 150, reqRating: 4.9, commission: 10.0 }
];

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

    // Sync Gamification table (Optional cache)
    let gamification = await prisma.providerGamification.upsert({
      where: { providerId },
      update: { points: totalPoints, completedProjects, avgRating },
      create: {
        providerId,
        points: totalPoints,
        completedProjects,
        avgRating,
        currentLevelIndex: 1,
        currentCommission: 15.0
      }
    });

    const points = totalPoints;

    // 2. DYNAMIC LEVEL & GAP CALCULATOR ENGINE
    let currentLevel = LEVEL_MATRIX[0];
    for (let i = LEVEL_MATRIX.length - 1; i >= 0; i--) {
      const level = LEVEL_MATRIX[i];
      if (points >= level.reqPoints && completedProjects >= level.reqProjects && avgRating >= level.reqRating) {
        currentLevel = level;
        break;
      }
    }

    const nextLevelIndex = Math.min(currentLevel.index + 1, 15);
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
