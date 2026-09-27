import { prisma } from '../config/db';
import { ProjectStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { logger } from '../config/logger';
import { geminiClient } from './ai/gemini/gemini.client';
import {
  AI_MATCHING_ENGINE_SYSTEM_PROMPT,
  buildAiMatchingUserPrompt,
  ProviderContextPayload,
  CandidateProjectPayload
} from '../prompts/ai-matching.prompt';

export type AiMatchingGenerationSource = 'GEMINI' | 'DETERMINISTIC';

export interface AiMatchingProjectItem {
  id: string;
  title: string;
  category: string;
  specialty: string;
  budget: number;
  aiMatchScore: number;
  matchReasons: string[];
  aiAnalysis?: string;
  createdAt: Date | string;
  deliveryDays?: number;
  clientName?: string;
  generationSource: AiMatchingGenerationSource;
}

interface GeminiMatchItem {
  projectId: string;
  aiMatchScore: number;
  matchReasons: string[];
  aiAnalysis: string;
}

interface GeminiMatchingResponse {
  matches: GeminiMatchItem[];
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const MATCHING_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          aiMatchScore: { type: 'number', description: 'integer between 82 and 99' },
          matchReasons: { type: 'array', items: { type: 'string' } },
          aiAnalysis: { type: 'string' }
        },
        required: ['projectId', 'aiMatchScore', 'matchReasons', 'aiAnalysis']
      }
    }
  },
  required: ['matches']
};

// Rejects malformed/hallucinated Gemini output. Every projectId must
// correspond to a project actually supplied in the candidate set — Gemini
// must never be able to invent a project that wasn't offered to it.
function buildMatchingValidator(candidateIds: Set<string>) {
  return function isValidMatchingResponse(value: unknown): value is GeminiMatchingResponse {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.matches) || v.matches.length === 0) return false;

    const seenIds = new Set<string>();
    return v.matches.every((item) => {
      if (!item || typeof item !== 'object') return false;
      const m = item as Record<string, unknown>;
      if (!isNonEmptyString(m.projectId) || !candidateIds.has(m.projectId)) return false;
      if (seenIds.has(m.projectId)) return false; // duplicate id
      seenIds.add(m.projectId);
      if (typeof m.aiMatchScore !== 'number' || !Number.isFinite(m.aiMatchScore) || m.aiMatchScore < 0 || m.aiMatchScore > 100) return false;
      if (!Array.isArray(m.matchReasons) || m.matchReasons.length === 0 || !m.matchReasons.every((r) => isNonEmptyString(r))) return false;
      if (!isNonEmptyString(m.aiAnalysis)) return false;
      return true;
    });
  };
}

export class AiMatchingEngineService {
  /**
   * Main function to get the TOP 3 AI-matched projects for a given provider
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

      // Compile Provider Context Payload for OpenAI
      const skillsList = (providerProfile?.skills || []).map(s => s.name);
      const specialtiesList = providerSpecialties.map(ps => ({
        name: ps.specialty?.nameAr || ps.specialty?.name || 'تخصص عام',
        subSpecialties: ps.subSpecialties || [],
        quizScore: ps.latestScore || ps.quizScore || undefined,
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
      const testsPassedList: { specialtyName: string; score: number; passed: boolean }[] = [];

      providerSpecialties.filter(ps => ps.isPassed).forEach(ps => {
        const specName = ps.specialty?.nameAr || ps.specialty?.name || 'اختبار التخصص';
        testsPassedList.push({
          specialtyName: specName,
          score: ps.latestScore || ps.quizScore || 80,
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
        rating: providerProfile?.rating || user?.ratingAverage || 5.0,
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

      // Format candidate projects for OpenAI
      const candidatesPayload: CandidateProjectPayload[] = openProjects.map(p => ({
        id: p.id,
        title: p.title,
        description: p.description || p.title,
        specialty: p.specialty || 'تطوير وبرمجة',
        subSpecialties: p.subSpecialties || [],
        requirements: p.requirements || [],
        budget: Number(p.budgetFixed || p.budgetMax || p.budgetMin || 1500),
        deliveryDays: p.deliveryDays || 7,
        requiredLevel: p.provLevel || 'الكل'
      }));

      // 3. Perform Gemini evaluation if configured
      if (geminiClient.isConfigured()) {
        try {
          const candidateIds = new Set(openProjects.map(p => p.id));
          const userPrompt = buildAiMatchingUserPrompt(providerContext, candidatesPayload);

          const result = await geminiClient.generateStructured<GeminiMatchingResponse>(userPrompt, {
            systemInstruction: AI_MATCHING_ENGINE_SYSTEM_PROMPT,
            responseSchema: MATCHING_RESPONSE_SCHEMA,
            validate: buildMatchingValidator(candidateIds),
            temperature: 0.2,
            maxOutputTokens: 800
          });

          const projectsById = new Map(openProjects.map(p => [p.id, p]));
          const matchedResults: AiMatchingProjectItem[] = result.data.matches
            .map((m): AiMatchingProjectItem | null => {
              const targetProj = projectsById.get(m.projectId);
              if (!targetProj) return null;

              const clientName = targetProj.client
                ? `${targetProj.client.firstName || ''} ${targetProj.client.lastName || ''}`.trim()
                : 'عميل Waseet AI';

              return {
                id: targetProj.id,
                title: targetProj.title,
                category: targetProj.specialty || 'خدمة تخصصية',
                specialty: targetProj.specialty || 'تطوير وتصميم',
                budget: Number(targetProj.budgetFixed || targetProj.budgetMax || targetProj.budgetMin || 2500),
                aiMatchScore: Math.min(99, Math.max(82, Math.round(m.aiMatchScore))),
                matchReasons: m.matchReasons,
                aiAnalysis: m.aiAnalysis,
                createdAt: targetProj.createdAt,
                deliveryDays: targetProj.deliveryDays || 7,
                clientName: clientName || 'عميل موثوق',
                generationSource: 'GEMINI'
              };
            })
            .filter((m): m is AiMatchingProjectItem => m !== null);

          if (matchedResults.length > 0) {
            logger.info(`[AiMatchingEngineService] Gemini successfully evaluated top ${matchedResults.length} real matches for provider ${providerId}`);
            return matchedResults.slice(0, 3);
          }
        } catch (geminiError: any) {
          logger.warn(`[AiMatchingEngineService] Gemini execution failed or timed out (${geminiError.message}). Falling back to multi-factor rule engine.`);
        }
      }

      // 4. Fallback Rule-Based Multi-Factor Scoring Engine (if Gemini is not configured or fails)
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
      if (passedTestsSet.has(projSpecialty) || provider.testsPassed.some(t => t.score >= 80)) {
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

      // 4. Rating & Level (15%)
      let ratingScore = Math.min(100, Math.round(provider.rating * 19));

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

      return {
        id: proj.id,
        title: proj.title,
        category: proj.specialty || 'خدمة تخصصية',
        specialty: proj.specialty || 'تطوير وتصميم',
        budget: Number(proj.budgetFixed || proj.budgetMax || proj.budgetMin || 2000),
        aiMatchScore: clampedScore,
        matchReasons: Array.from(new Set(reasons)),
        // Honest label — this is the deterministic rule engine, not a Gemini
        // analysis, so it must never claim to be AI-generated.
        aiAnalysis: `تم ترشيح هذا المشروع بمعايير المطابقة الآلية بناءً على تخصصاتك (${provider.skills.slice(0, 3).join(', ')}) واختباراتك المعتمدة.`,
        createdAt: proj.createdAt || new Date(),
        deliveryDays: proj.deliveryDays || 7,
        clientName: clientName || 'عميل موثوق',
        generationSource: 'DETERMINISTIC' as const
      };
    });

    scoredList.sort((a, b) => b.aiMatchScore - a.aiMatchScore);
    return scoredList.slice(0, 3);
  }

}

export const aiMatchingEngineService = new AiMatchingEngineService();
