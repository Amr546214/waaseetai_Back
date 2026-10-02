import { prisma } from '../config/db';
import { ProjectStatus, ProposalStatus } from '@prisma/client';
import { logger } from '../config/logger';
import { aiMatchingEngineService } from './ai-matching-engine.service';

export interface ProviderActivityItem {
  id: string;
  title: string;
  category: string;
  budget: number;
  status: string;
  type: 'PROJECT' | 'PROPOSAL';
  createdAt: Date;
  updatedAt: Date;
}

export interface AiMatchingProjectItem {
  id: string;
  title: string;
  category: string;
  specialty: string;
  budget: number | null;
  // Batch 5: null for the deterministic fallback (never a percentage) —
  // see ai-matching-engine.service.ts#AiMatchingProjectItem.
  aiMatchScore: number | null;
  matchReasons: string[];
  createdAt: Date | string;
  deliveryDays?: number;
  clientName?: string;
}

export class ProviderOverviewService {
  /**
   * Retrieves the top 4 most recent items (Active projects in progress + Pending proposals)
   */
  async getLatestProviderActivity(providerId: string): Promise<ProviderActivityItem[]> {
    try {
      const [activeProjects, pendingProposals] = await Promise.all([
        prisma.project.findMany({
          where: {
            providerId,
            status: {
              in: [
                ProjectStatus.IN_PROGRESS,
                ProjectStatus.AWAITING_DELIVERY,
                ProjectStatus.PENDING_APPROVAL
              ]
            }
          },
          orderBy: { updatedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            title: true,
            specialty: true,
            budgetFixed: true,
            budgetMax: true,
            budgetMin: true,
            status: true,
            createdAt: true,
            updatedAt: true
          }
        }),
        prisma.proposal.findMany({
          where: {
            providerId,
            status: {
              in: [
                ProposalStatus.PENDING,
                ProposalStatus.SUBMITTED,
                ProposalStatus.UNDER_NEGOTIATION,
                ProposalStatus.IN_AI_REVIEW
              ]
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            project: {
              select: {
                title: true,
                specialty: true,
                status: true
              }
            }
          }
        })
      ]);

      const projectItems: ProviderActivityItem[] = activeProjects.map(p => ({
        id: p.id,
        title: p.title,
        category: p.specialty || 'تطوير مشاريع',
        budget: Number(p.budgetFixed || p.budgetMax || p.budgetMin || 0),
        status: p.status,
        type: 'PROJECT',
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      }));

      const proposalItems: ProviderActivityItem[] = pendingProposals.map(p => ({
        id: p.id,
        title: p.project?.title || 'عرض على مشروع',
        category: p.project?.specialty || 'عروض تقديمية',
        budget: Number(p.price || 0),
        status: p.status,
        type: 'PROPOSAL',
        createdAt: p.createdAt,
        updatedAt: p.createdAt
      }));

      const combined: ProviderActivityItem[] = [...projectItems, ...proposalItems];

      // Sort descending by timestamp and return exactly top 4
      combined.sort((a, b) => {
        const timeB = new Date(b.updatedAt || b.createdAt).getTime();
        const timeA = new Date(a.updatedAt || a.createdAt).getTime();
        return timeB - timeA;
      });

      return combined.slice(0, 4);
    } catch (error: any) {
      logger.error(`[ProviderOverviewService] Error fetching provider activity: ${error.message}`, error);
      return [];
    }
  }

  /**
   * Delegates AI matching to the dedicated AiMatchingEngineService
   * Returns TOP 3 best matching open client projects.
   */
  async getAiMatchingProjects(providerId: string): Promise<AiMatchingProjectItem[]> {
    return aiMatchingEngineService.getTop3MatchingProjects(providerId);
  }
}

export const providerOverviewService = new ProviderOverviewService();
