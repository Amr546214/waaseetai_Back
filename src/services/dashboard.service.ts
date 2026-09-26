import { prisma } from '../config/db';
import { AccountType, UserRole } from '@prisma/client';
import { DashboardStatsPayload } from '../types/dashboard.types';
import { AppError } from '../utils/app-error';
import { getRoleFromAccountType } from './account-management.service';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';

export class DashboardService {
  /**
   * Retrieves dashboard statistics tailored for a Client.
   */
  public async getClientStats(userId: string): Promise<DashboardStatsPayload> {
    try {
      // 1. Active Projects Count (projects where status = IN_PROGRESS)
      const activeProjectsCount = await prisma.project.count({
        where: {
          clientId: userId,
          status: 'IN_PROGRESS'
        }
      });

      // 2. New Offers Count (proposals received across all client's OPEN projects)
      const newOffersCount = await prisma.proposal.count({
        where: {
          project: {
            clientId: userId,
            status: 'OPEN'
          }
        }
      });

      // 3. Total Escrow Amount (sum of all amounts in Escrow where status = HELD for client's projects)
      const escrowResult = await prisma.escrow.aggregate({
        where: {
          project: {
            clientId: userId
          },
          status: 'HELD'
        },
        _sum: {
          amount: true
        }
      });
      const totalEscrowAmount = escrowResult._sum.amount || 0;

      // 4. Total Spent (sum of budgets of all client's COMPLETED projects)
      const spentResult = await prisma.project.aggregate({
        where: {
          clientId: userId,
          status: 'COMPLETED'
        },
        _sum: {
          budgetFixed: true,
          budgetMax: true
        }
      });
      const totalSpent = (spentResult._sum.budgetFixed || 0) + (spentResult._sum.budgetMax || 0);

      // 5. Latest Projects (Top 3 recent projects)
      const latestProjectsRaw = await prisma.project.findMany({
        where: { clientId: userId },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: {
          id: true,
          title: true,
          budgetFixed: true,
          budgetMax: true,
          status: true,
          createdAt: true
        }
      });

      const latestProjectsData = latestProjectsRaw.map(p => ({
        id: p.id,
        title: p.title,
        budget: p.budgetFixed || p.budgetMax || 0,
        status: p.status,
        createdAt: p.createdAt
      }));

      // 6. Latest Proposals (Top 3 recent proposals received for client's projects)
      const latestProposalsData = await prisma.proposal.findMany({
        where: {
          project: {
            clientId: userId
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 3,
        include: {
          project: { select: { title: true } },
          provider: {
            select: {
              firstName: true,
              lastName: true
            }
          }
        }
      });

      const latestProposals = latestProposalsData.map(p => ({
        id: p.id,
        projectId: p.projectId,
        projectTitle: p.project?.title || 'طلب مشروع',
        price: p.price,
        deliveryDays: p.deliveryDays,
        aiMatchScore: p.aiMatchScore,
        providerName: `${p.provider.firstName} ${p.provider.lastName}`,
        status: p.status,
        createdAt: p.createdAt
      }));

      // Fetch User profile metrics. This endpoint is only reached for
      // activeRole === CLIENT (see getStats below), so the display/progression
      // fields resolve from ClientProfile, falling back to the legacy User
      // columns when the role-specific value is missing (Phase 3C).
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          activeRole: true,
          profileCompletionPercent: true,
          currentLevel: true,
          pointsToNextLevel: true,
          currentPoints: true,
          clientProfile: {
            select: {
              currentLevel: true,
              currentPoints: true,
              pointsToNextLevel: true,
              completionPercentage: true
            }
          }
        }
      });

      const clientDisplayFields = resolveActiveRoleDisplayFields({
        activeRole: user?.activeRole ?? UserRole.CLIENT,
        legacy: {
          firstName: '',
          lastName: '',
          avatarUrl: null,
          profileCompletionPercent: user?.profileCompletionPercent ?? 0,
          currentLevel: user?.currentLevel ?? 'مستكشف - المستوى 1',
          currentPoints: user?.currentPoints ?? 0,
          pointsToNextLevel: user?.pointsToNextLevel ?? 100
        },
        clientProfile: user?.clientProfile
      });

      // 7. Price-fairness AI insight (Batch 7) — a deterministic aggregate
      // of the client's own proposals' real, already-Gemini-computed
      // aiPriceTag field (see ai-proposal.service.ts / proposal.service.ts
      // createProposal). This is NOT a new Gemini call: it summarizes AI
      // output that already exists on Proposal rows. Replaces a previously
      // fully-hardcoded static "96%" AI Insights card that had zero backend
      // behind it at all.
      const proposalsWithPriceTag = await prisma.proposal.findMany({
        where: {
          project: { clientId: userId },
          aiPriceTag: { not: null }
        },
        select: { aiPriceTag: true }
      });
      let priceFairnessInsight: DashboardStatsPayload['priceFairnessInsight'] = null;
      if (proposalsWithPriceTag.length > 0) {
        const fairCount = proposalsWithPriceTag.filter((p) => p.aiPriceTag === 'FAIR').length;
        const fairPricePercentage = Math.round((fairCount / proposalsWithPriceTag.length) * 100);
        priceFairnessInsight = {
          fairPricePercentage,
          evaluatedOffersCount: proposalsWithPriceTag.length,
          summaryText: `${fairPricePercentage}% من عروضك المقيَّمة بالذكاء الاصطناعي ضمن النطاق العادل لأسعار السوق`
        };
      }

      // 8. Active Contract (Find real active contract for this client, if any)
      const activeContractEntity = await prisma.contract.findFirst({
        where: {
          clientId: userId,
          status: { in: ['ACTIVE', 'PENDING_PAYMENT'] }
        },
        include: {
          project: { select: { id: true, title: true, status: true } },
          provider: {
            select: {
              firstName: true,
              lastName: true,
              providerProfile: { select: { companyName: true } }
            }
          }
        },
        orderBy: { updatedAt: 'desc' }
      });

      let activeContract = null;
      if (activeContractEntity && activeContractEntity.project) {
        const providerName = activeContractEntity.provider?.providerProfile?.companyName || 
                             `${activeContractEntity.provider?.firstName || ''} ${activeContractEntity.provider?.lastName || ''}`.trim() || 
                             'مقدم خدمة موثق';
        let progress = 0;
        if (activeContractEntity.status === 'COMPLETED' || activeContractEntity.project.status === 'COMPLETED') {
          progress = 100;
        } else if (activeContractEntity.status === 'ACTIVE' || activeContractEntity.project.status === 'IN_PROGRESS') {
          progress = 0;
        }

        activeContract = {
          title: activeContractEntity.project.title,
          provider: providerName,
          requestId: `#${activeContractEntity.project.id.substring(0, 4)}`,
          amount: activeContractEntity.price,
          progress,
          statusText: 'العقد النشط'
        };
      }

      return {
        summary: {
          activeProjectsCount,
          newOffersCount,
          totalEscrowAmount,
          totalSpent,
          aiRating: 0,
          humanRating: 0,
          profileCompletionPercent: clientDisplayFields.profileCompletionPercent,
          currentLevel: clientDisplayFields.currentLevel,
          pointsToNextLevel: clientDisplayFields.pointsToNextLevel,
          currentPoints: clientDisplayFields.currentPoints
        },
        priceFairnessInsight,
        topSteps: {
          step1_escrowRequiredCount: 0,
          step2_pendingApprovalCount: 0,
          step3_pendingProposalsCount: 0
        },
        latestProjects: latestProjectsData,
        latestProposals,
        activeContract
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Retrieves dashboard statistics tailored for a Provider.
   * STRICT DB MODE: Returns only true data, zero values for empty states.
   */
  public async getProviderStats(userId: string): Promise<DashboardStatsPayload> {
    try {
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      // Fetch Provider Profile for skills & rating
      const providerProfile = await prisma.providerProfile.findUnique({
        where: { userId },
        include: { skills: true }
      });
      const providerSkills = providerProfile?.skills?.map((s: any) => s.name) || [];
      const providerRating = providerProfile?.rating || 0;

      // Parallel data fetching for high performance
      const [
        activeProjectsCount,
        pendingOffersCount,
        monthlyEarningsAgg,
        user,
        gamification,
        aiMatchingProjectsRaw,
        latestProposalsData
      ] = await Promise.all([
        // 1. Active Projects Count
        prisma.project.count({
          where: { providerId: userId, status: 'IN_PROGRESS' }
        }),
        // 2. Pending Offers Count
        prisma.proposal.count({
          where: { providerId: userId, status: 'PENDING' }
        }),
        // 3. Monthly Earnings (Completed projects in current month)
        prisma.project.aggregate({
          where: {
            providerId: userId,
            status: 'COMPLETED',
            updatedAt: { gte: firstDayOfMonth }
          },
          _sum: { budgetFixed: true, budgetMax: true }
        }),
        // 4. User details for profile completion level (legacy fallback only —
        // see resolveActiveRoleDisplayFields below for the actual source)
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            profileCompletionPercent: true,
            currentLevel: true,
            pointsToNextLevel: true,
            currentPoints: true
          }
        }),
        // 4b. Provider progression (Phase 3C source of truth for
        // currentPoints/currentLevel/pointsToNextLevel — see gamification.service.ts LEVEL_MATRIX)
        prisma.providerGamification.findUnique({
          where: { providerId: userId },
          select: { points: true, currentLevelIndex: true }
        }),
        // 5. AI Matching Projects (Open projects matching provider skills)
        providerSkills.length > 0 
          ? prisma.project.findMany({
              where: {
                status: 'OPEN',
                specialty: { in: providerSkills }
              },
              orderBy: { createdAt: 'desc' },
              take: 3,
              select: {
                id: true,
                title: true,
                budgetFixed: true,
                budgetMax: true,
                specialty: true,
                createdAt: true
              }
            })
          : Promise.resolve([]),
        // 6. Latest Proposals Grid (Top 5 recent proposals)
        prisma.proposal.findMany({
          where: { providerId: userId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            project: { select: { title: true } },
            provider: { select: { firstName: true, lastName: true } }
          }
        })
      ]);

      const monthlyEarnings = (monthlyEarningsAgg._sum.budgetFixed || 0) + (monthlyEarningsAgg._sum.budgetMax || 0);

      // Phase 3C: profileCompletionPercent comes from ProviderProfile, and
      // currentPoints/currentLevel/pointsToNextLevel come from the provider's
      // own gamification system (ProviderGamification + LEVEL_MATRIX) — never
      // from ClientProfile and never from the legacy User columns unless the
      // provider genuinely has no ProviderProfile/ProviderGamification row yet.
      const providerDisplayFields = resolveActiveRoleDisplayFields({
        activeRole: UserRole.PROVIDER,
        legacy: {
          firstName: '',
          lastName: '',
          avatarUrl: null,
          profileCompletionPercent: user?.profileCompletionPercent ?? 0,
          currentLevel: user?.currentLevel ?? '',
          currentPoints: user?.currentPoints ?? 0,
          pointsToNextLevel: user?.pointsToNextLevel ?? 0
        },
        providerProfile,
        providerGamification: gamification
      });

      // Map AI Matching Projects
      const aiMatchingProjects = aiMatchingProjectsRaw.map((p) => {
        return {
          id: p.id,
          title: p.title,
          budget: p.budgetFixed || p.budgetMax || 0,
          specialty: p.specialty,
          aiMatchScore: 0, // Placeholder until semantic AI service is integrated
          createdAt: p.createdAt
        };
      });

      const latestProposals = latestProposalsData.map(p => ({
        id: p.id,
        projectId: p.projectId,
        projectTitle: p.project?.title || 'طلب مشروع',
        price: p.price,
        deliveryDays: p.deliveryDays,
        aiMatchScore: p.aiMatchScore,
        providerName: `${p.provider.firstName} ${p.provider.lastName}`,
        status: p.status,
        createdAt: p.createdAt
      }));

      return {
        summary: {
          activeProjectsCount,
          newOffersCount: pendingOffersCount,
          pendingOffersCount,
          monthlyEarnings,
          totalEscrowAmount: 0, // Escrow calculation is currently omitted for provider
          totalSpent: 0,
          aiRating: 0,
          humanRating: 0,
          providerRating,
          profileCompletionPercent: providerDisplayFields.profileCompletionPercent,
          currentLevel: providerDisplayFields.currentLevel,
          pointsToNextLevel: providerDisplayFields.pointsToNextLevel,
          currentPoints: providerDisplayFields.currentPoints
        },
        topSteps: {
          step1_escrowRequiredCount: 0,
          step2_pendingApprovalCount: 0,
          step3_pendingProposalsCount: 0
        },
        latestProjects: [],
        aiMatchingProjects,
        latestProposals
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Main entry point to get statistics based on the user's currently active
   * role — NOT their original signup accountType. A MARKETING_BROKER account
   * that has switched activeRole to CLIENT must get client stats, not a 501,
   * since accountType only reflects how the identity first registered while
   * activeRole reflects which account they're using right now.
   *
   * accountType is only used as a fallback for legacy rows where activeRole
   * hasn't been populated yet (should be rare after registration/login now
   * always sets it — see auth.service.ts).
   */
  public async getStats(userId: string, activeRole?: UserRole, accountType?: AccountType): Promise<any> {
    const role = activeRole || (accountType ? getRoleFromAccountType(accountType) : undefined);

    if (role === UserRole.CLIENT) {
      return this.getClientStats(userId);
    }

    if (role === UserRole.PROVIDER) {
      return this.getProviderStats(userId);
    }

    if (role === UserRole.AFFILIATE) {
      // The affiliate/marketing-broker dashboard has its own dedicated
      // endpoints (GET /marketer-overview/summary, /channel-performance,
      // /commissions, /ai-insights) — this generic endpoint doesn't serve it.
      throw new AppError('إحصائيات الوسيط التسويقي متاحة عبر نقاط /marketer-overview الخاصة بها', 400);
    }

    throw new AppError('Statistics not implemented for this account type yet', 501);
  }
}

export const dashboardService = new DashboardService();
