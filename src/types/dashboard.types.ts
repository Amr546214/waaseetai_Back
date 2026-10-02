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
    aiMatchScore: number | null;
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
    // Batch 5 — the real gamification-derived provider level (same
    // resolveProviderProgression()/PROVIDER_LEVEL_MATRIX source marketplace
    // uses), never an accreditation badge and never fabricated from index/
    // rating/AI score. null when the provider genuinely has neither a
    // ProviderGamification row nor a legacy currentLevel value. Optional so
    // getProviderStats (Provider's own dashboard, out of this batch's scope)
    // is unaffected.
    providerLevel?: string | null;
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
