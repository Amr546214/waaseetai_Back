import { ProjectStatus, ProposalStatus } from '@prisma/client';

export interface DashboardStatsPayload {
  summary: {
    activeProjectsCount: number;
    newOffersCount: number;
    pendingOffersCount?: number;
    monthlyEarnings?: number;
    availableEarnings?: number;
    totalEscrowAmount: number;
    totalSpent: number;
    aiRating: number;
    humanRating: number;
    providerRating?: number;
    profileCompletionPercent: number;
    currentLevel: string;
    pointsToNextLevel: number;
    currentPoints: number;
  };
  topSteps: {
    step1_escrowRequiredCount: number;
    step2_pendingApprovalCount: number;
    step3_pendingProposalsCount: number;
  };
  latestProjects: Array<{
    id: string;
    title: string;
    budget: number;
    status: ProjectStatus;
    createdAt: Date;
  }>;
  aiMatchingProjects?: Array<{
    id: string;
    title: string;
    budget: number;
    specialty: string;
    aiMatchScore: number;
    createdAt: Date;
  }>;
  latestProposals: Array<{
    id: string;
    projectId: string | null;
    projectTitle: string;
    price: number;
    deliveryDays: number;
    aiMatchScore: number | null;
    providerName: string;
    status: ProposalStatus;
    createdAt: Date;
  }>;
  activeContract?: {
    title: string;
    provider: string;
    requestId: string;
    amount: number;
    progress: number;
    statusText: string;
  } | null;
}
