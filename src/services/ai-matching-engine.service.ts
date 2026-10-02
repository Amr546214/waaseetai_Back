import { prisma } from '../config/db';
import { ProjectStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { logger } from '../config/logger';
import type { ProviderContextPayload } from '../prompts/ai-matching.prompt';

// Matching is a deterministic rule engine over stored data; no AI generation.
export type AiMatchingGenerationSource = 'DETERMINISTIC';

export interface AiMatchingProjectItem {
  id: string;
  title: string;
  category: string;
  specialty: string;
  /** null when the project genuinely has no budget set — never an invented default. */
  budget: number | null;
  /**
   * AI Cleanup Batch 5 — score semantics:
   *  - Always null. The rule-engine fallback only ORDERS
   *    candidates; its internal heuristic is not a compatibility percentage
   *    and is never exposed as one.
   */
  aiMatchScore: number | null;
  matchReasons: string[];
  aiAnalysis?: string;
  createdAt: Date | string;
  deliveryDays?: number;
  clientName?: string;
  generationSource: AiMatchingGenerationSource;
}

/** The project's real budget, or null — never an invented default amount. */
function realBudget(p: { budgetFixed?: number | null; budgetMax?: number | null; budgetMin?: number | null }): number | null {
  const value = Number(p.budgetFixed || p.budgetMax || p.budgetMin || 0);
  return value > 0 ? value : null;
}

export class AiMatchingEngineService {
  /**
   * Top 3 projects for a provider, ranked by the deterministic rule engine for a given provider
   */
  async getTop3MatchingProjects(providerId: string): Promise<AiMatchingProjectItem[]> {
    try {
      // 1. Gather comprehensive Provider Profile data from Prisma
      const [
        user,
        providerProfile,
        providerSpecialties,
        skillAssessments,
        accreditationSamples
      ] = await Promise.all([
        prisma.user.findUnique({
          where: { id: providerId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            currentLevel: true,
            currentPoints: true,
            profileCompletionPercent: true,
            completedProjectsCount: true,
            ratingAverage: true
          }
        }),
        prisma.providerProfile.findUnique({
          where: { userId: providerId },
          include: {
            skills: true,
            portfolioItems: true
          }
        }),
        prisma.providerSpecialty.findMany({
          where: {
            providerProfile: { userId: providerId },
            isActive: true,
            status: SpecialtyVerificationStatus.APPROVED
          },
          include: {
            specialty: true,
            workSamples: true
          }
        }),
        prisma.providerSkillAssessment.findMany({
          where: { providerProfile: { userId: providerId } },
          include: { specialty: true }
        }),
        prisma.accreditationSample.findMany({
          where: { providerProfile: { userId: providerId } },
          take: 5
        })
      ]);

      // The initial profile-setup specialty is informational only. Project
      // matching starts exclusively after at least one specialties assessment
      // has been approved.
      if (providerSpecialties.length === 0) {
        return [];
      }

      // Compile provider context for the rule engine
      const skillsList = (providerProfile?.skills || []).map(s => s.name);
      const specialtiesList = providerSpecialties.map(ps => ({
        name: ps.specialty?.nameAr || ps.specialty?.name || 'تخصص عام',
        subSpecialties: ps.subSpecialties || [],
        quizScore: ps.latestScore ?? ps.quizScore ?? undefined,
        isPassed: ps.isPassed || false,
        aiScore: ps.aiScore || undefined
      }));

      // Combine tests and quizzes passed. Batch 4E: derived directly from
      // providerSpecialties (already fetched above, filtered to APPROVED)
      // instead of separately querying SpecialtyTestSession/AssessmentAttempt.
      // The canonical submission flow (ai-assessment.service.ts) writes
      // latestScore/isPassed/status atomically together, so an APPROVED row
      // here is guaranteed to already carry the current derived score —
      // no separate historical query is needed for a current-qualification
      // signal.
      const testsPassedList: { specialtyName: string; score: number | null; passed: boolean }[] = [];

      providerSpecialties.filter(ps => ps.isPassed).forEach(ps => {
        const specName = ps.specialty?.nameAr || ps.specialty?.name || 'اختبار التخصص';
        testsPassedList.push({
          specialtyName: specName,
          // Batch 5: was `|| 80` — an invented test score. null when no real score exists.
          score: ps.latestScore ?? ps.quizScore ?? null,
          passed: ps.isPassed
        });
      });

      skillAssessments.forEach(sa => {
        testsPassedList.push({
          specialtyName: sa.specialty?.nameAr || sa.specialty?.name || 'تقييم مهارات',
          score: sa.score,
          passed: sa.passed
        });
      });

      const providerContext: ProviderContextPayload = {
        name: `${user?.firstName || 'مقدم'} ${user?.lastName || 'خدمة'}`.trim(),
        level: user?.currentLevel || 'مستكشف - المستوى 1',
        // Batch 5: was `|| 5.0` — an invented perfect rating for unrated
        // providers. null when the provider genuinely has no rating yet.
        rating: providerProfile?.rating || user?.ratingAverage || null,
        completedProjects: user?.completedProjectsCount || 0,
        headline: providerProfile?.headline || undefined,
        bio: providerProfile?.bio || undefined,
        skills: skillsList,
        specialties: specialtiesList,
        testsPassed: testsPassedList,
        portfolioCount: providerProfile?.portfolioItems?.length || 0,
        accreditationCount: accreditationSamples.length
      };

      // 2. Fetch candidate open projects from Prisma (excluding projects where provider already submitted a proposal)
      let openProjects = await prisma.project.findMany({
        where: {
          status: { in: [ProjectStatus.OPEN, ProjectStatus.PENDING_REVIEW] },
          OR: [
            { providerId: null },
            { providerId: { not: providerId } }
          ],
          proposals: {
            none: {
              providerId: providerId
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          title: true,
          description: true,
          specialty: true,
          subSpecialties: true,
          requirements: true,
          budgetFixed: true,
          budgetMax: true,
          budgetMin: true,
          deliveryDays: true,
          provLevel: true,
          createdAt: true,
          client: {
            select: { firstName: true, lastName: true }
          }
        }
      });

      // If database has NO open projects at all, return an empty array (STRICT DB MODE)
      if (openProjects.length === 0) {
        return [];
      }

      const approvedSpecialtyNames = new Set(
        providerSpecialties.flatMap(ps => [
          ps.specialty?.nameAr,
          ps.specialty?.name,
          ps.specialty?.nameEn,
          ...(ps.subSpecialties || [])
        ]).filter(Boolean).map(name => String(name).trim().toLowerCase())
      );

      openProjects = openProjects.filter(project => {
        const projectSpecialty = (project.specialty || '').trim().toLowerCase();
        return Boolean(projectSpecialty && approvedSpecialtyNames.has(projectSpecialty));
      });

      if (openProjects.length === 0) {
        return [];
      }

      // Deterministic multi-factor rule engine (no AI)
      return this.computeFallbackTop3Matches(providerContext, openProjects);
    } catch (error: any) {
      logger.error(`[AiMatchingEngineService] Error matching projects: ${error.message}`, error);
      return [];
    }
  }

  /**
   * Deterministic Multi-Factor Rule Engine for scoring and picking top 3 matches
   */
  private computeFallbackTop3Matches(
    provider: ProviderContextPayload,
    candidates: any[]
  ): AiMatchingProjectItem[] {
    const providerSkillsSet = new Set<string>();
    provider.skills.forEach(s => providerSkillsSet.add(s.toLowerCase()));
    provider.specialties.forEach(spec => {
      providerSkillsSet.add(spec.name.toLowerCase());
      spec.subSpecialties.forEach(sub => providerSkillsSet.add(sub.toLowerCase()));
    });

    const passedTestsSet = new Set<string>();
    provider.testsPassed.filter(t => t.passed).forEach(t => passedTestsSet.add(t.specialtyName.toLowerCase()));

    const scoredList = candidates.map(proj => {
      const projSpecialty = (proj.specialty || '').toLowerCase();
      const projRequirements = (proj.requirements || []).map((r: string) => r.toLowerCase());
      const projSubSpecialties = (proj.subSpecialties || []).map((s: string) => s.toLowerCase());

      const reasons: string[] = [];

      // 1. Specialty & Skill Match Score (40%)
      let skillScore = 75;
      if (providerSkillsSet.has(projSpecialty) || projSpecialty.includes('تطوير') || projSpecialty.includes('تصميم')) {
        skillScore += 15;
        reasons.push(`متطابق تماماً مع تخصصك: ${proj.specialty}`);
      }

      let matchedSkills = 0;
      [...projRequirements, ...projSubSpecialties].forEach(req => {
        if (providerSkillsSet.has(req)) matchedSkills++;
      });

      if (matchedSkills > 0) {
        skillScore += Math.min(10, matchedSkills * 4);
        reasons.push(`تطابق المهارات التقنية المطلوبة (${matchedSkills} مهارة)`);
      }

      // 2. Test & Quiz Performance (25%)
      let testScore = 70;
      if (passedTestsSet.has(projSpecialty) || provider.testsPassed.some(t => t.score !== null && t.score >= 80)) {
        testScore = 95;
        reasons.push('اجتياز اختبارات وتقييمات المهارة بنجاح عالية');
      } else if (provider.specialties.some(s => s.isPassed)) {
        testScore = 88;
        reasons.push('تخصص معتمد باختبار محضر');
      }

      // 3. Portfolio & Accreditation (20%)
      let portfolioScore = 75 + Math.min(20, provider.portfolioCount * 4 + provider.accreditationCount * 5);
      if (provider.accreditationCount > 0) {
        reasons.push('ملف أعمال ومعرض نماذج موثق بالذكاء');
      }

      // 4. Rating & Level (15%) — 0 contribution when genuinely unrated.
      let ratingScore = provider.rating === null ? 0 : Math.min(100, Math.round(provider.rating * 19));

      const totalScore = Math.round(
        (skillScore * 0.40) +
        (testScore * 0.25) +
        (portfolioScore * 0.20) +
        (ratingScore * 0.15)
      );

      const clampedScore = Math.max(84, Math.min(98, totalScore));
      if (reasons.length === 0) {
        reasons.push('عرض مناسب ومطابق لخبراتك ومستواك المهني');
      }

      const clientName = proj.client
        ? `${proj.client.firstName || ''} ${proj.client.lastName || ''}`.trim()
        : 'عميل Waseet AI';

      const item: AiMatchingProjectItem = {
        id: proj.id,
        title: proj.title,
        category: proj.specialty || 'خدمة تخصصية',
        specialty: proj.specialty || 'تطوير وتصميم',
        budget: realBudget(proj),
        // Batch 5: never exposed as a percentage — see AiMatchingProjectItem.
        aiMatchScore: null,
        matchReasons: Array.from(new Set(reasons)),
        // Honest label — this is the deterministic rule engine, not an AI
        // analysis, so it must never claim to be AI-generated.
        aiAnalysis: `تم ترشيح هذا المشروع بمعايير المطابقة الآلية بناءً على تخصصاتك (${provider.skills.slice(0, 3).join(', ')}) واختباراتك المعتمدة.`,
        createdAt: proj.createdAt || new Date(),
        deliveryDays: proj.deliveryDays || undefined,
        clientName: clientName || 'عميل موثوق',
        generationSource: 'DETERMINISTIC'
      };
      return { item, ruleScore: clampedScore };
    });

    // Ordering is unchanged from before Batch 5: internal rule score desc;
    // Array.prototype.sort is stable, so ties keep the candidate query's
    // createdAt-desc (newest first) order.
    scoredList.sort((a, b) => b.ruleScore - a.ruleScore);
    return scoredList.slice(0, 3).map(s => s.item);
  }

}

export const aiMatchingEngineService = new AiMatchingEngineService();
