import { prisma } from '../config/db';
import { ProjectStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { logger } from '../config/logger';
import { structuredAiExecutionService } from '../modules/ai-engine';
import {
  ProviderContextPayload,
  CandidateProjectPayload,
  ProviderProjectRankingAiOutput,
  RankProviderProjectMatchesPromptInput,
} from '../modules/ai-engine';

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
}

export class AiMatchingEngineService {
  /**
   * Main function to get the TOP 3 AI-matched projects for a given provider
   */
  async getTop3MatchingProjects(providerId: string): Promise<AiMatchingProjectItem[]> {
      // 1. Gather comprehensive Provider Profile data from Prisma
      const [
        user,
        providerProfile,
        providerSpecialties,
        testSessions,
        skillAssessments,
        assessmentAttempts,
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
        prisma.specialtyTestSession.findMany({
          where: { userId: providerId, passed: true },
          include: { providerSpecialty: { include: { specialty: true } } },
          take: 10
        }),
        prisma.providerSkillAssessment.findMany({
          where: { providerProfile: { userId: providerId } },
          include: { specialty: true }
        }),
        prisma.assessmentAttempt.findMany({
          where: { providerProfile: { userId: providerId }, isPassed: true },
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

      // Compile Provider Context Payload for the shared AI Engine
      const skillsList = (providerProfile?.skills || []).map(s => s.name);
      const specialtiesList = providerSpecialties.map(ps => ({
        name: ps.specialty?.nameAr || ps.specialty?.name || 'تخصص عام',
        subSpecialties: ps.subSpecialties || [],
        quizScore: ps.latestScore || ps.quizScore || undefined,
        isPassed: ps.isPassed || false,
        aiScore: ps.aiScore || undefined
      }));

      // Combine tests and quizzes passed
      const testsPassedList: { specialtyName: string; score: number; passed: boolean }[] = [];
      
      testSessions.forEach(ts => {
        const specName = ts.providerSpecialty?.specialty?.nameAr || ts.providerSpecialty?.specialty?.name || 'اختبار التخصص';
        testsPassedList.push({
          specialtyName: specName,
          score: ts.scorePercentage,
          passed: ts.passed
        });
      });

      skillAssessments.forEach(sa => {
        testsPassedList.push({
          specialtyName: sa.specialty?.nameAr || sa.specialty?.name || 'تقييم مهارات',
          score: sa.score,
          passed: sa.passed
        });
      });

      assessmentAttempts.forEach(aa => {
        testsPassedList.push({
          specialtyName: aa.specialty?.nameAr || aa.specialty?.name || 'اختبار مهارات',
          score: aa.score || 80,
          passed: aa.isPassed
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

      // Format candidate projects for the shared AI Engine
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

      // 3. Perform structured AI evaluation through the shared AI Engine
      const aiResult = await structuredAiExecutionService.execute<
        RankProviderProjectMatchesPromptInput,
        ProviderProjectRankingAiOutput
      >({
        capability: 'matching',
        operation: 'rank_provider_project_matches',
        input: {
          provider: providerContext,
          candidates: candidatesPayload,
        },
        locale: 'ar',
        auditContext: {
          actorUserId: providerId,
          primaryEntity: { type: 'PROVIDER', id: providerId },
        },
      });

      if (!aiResult.success) {
        logger.warn(
          `[AiMatchingEngineService] AI matching unavailable for provider ${providerId}; returning no AI-ranked matches. code=${aiResult.error.code}`
        );
        return [];
      }

      const matchedResults: AiMatchingProjectItem[] = [];
      const seenProjectIds = new Set<string>();

      for (const match of aiResult.data.matches) {
        if (seenProjectIds.has(match.projectId)) continue;
        const targetProj = openProjects.find(project => project.id === match.projectId);
        if (!targetProj) continue;

        seenProjectIds.add(match.projectId);
        const clientName = targetProj.client
          ? `${targetProj.client.firstName || ''} ${targetProj.client.lastName || ''}`.trim()
          : 'Waseet AI client';

        matchedResults.push({
          id: targetProj.id,
          title: targetProj.title,
          category: targetProj.specialty || 'Specialized service',
          specialty: targetProj.specialty || 'Development and design',
          budget: Number(targetProj.budgetFixed || targetProj.budgetMax || targetProj.budgetMin || 0),
          aiMatchScore: match.aiMatchScore,
          matchReasons: match.matchReasons,
          aiAnalysis: match.aiAnalysis,
          createdAt: targetProj.createdAt,
          deliveryDays: targetProj.deliveryDays || undefined,
          clientName: clientName || 'Verified client'
        });
      }

      return matchedResults.slice(0, 3);
  }
}

export const aiMatchingEngineService = new AiMatchingEngineService();
