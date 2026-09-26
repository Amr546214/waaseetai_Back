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
  // Batch 7: deterministic aggregate of the client's own proposals' real,
  // already-Gemini-computed `aiPriceTag` field (see ai-proposal.service.ts)
  // — never a new Gemini call, never a fabricated percentage. null when the
  // client has zero proposals with AI price-fairness data yet.
  priceFairnessInsight?: {
    fairPricePercentage: number;
    evaluatedOffersCount: number;
    summaryText: string;
  } | null;
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
