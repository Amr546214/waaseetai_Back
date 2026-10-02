export interface SuggestMilestonesDto {
  title: string;
  description?: string;
  totalAmount?: number;
}

export interface MilestoneDto {
  title?: string;
  desc?: string;
  description?: string;
  days?: number;
  estimatedDays?: number;
  percentage?: number;
}

export interface CompleteProjectDataDto {
  title: string;
  description: string;
  category?: string;
  specialtyId?: string;
  modelType?: string;
  portfolioItemId?: string;
  accreditationSampleId?: string;
  totalAmount?: number;
  stages?: MilestoneDto[];
  milestones?: MilestoneDto[];
}

export interface SuggestedMilestone {
  title: string;
  estimatedDays: number;
  description: string;
  percentage?: number;
}

// Backed by WaseetAI /v1/ai/project-analysis (+ /v1/ai/milestones). Fields
// WaseetAI does not provide are honestly empty/null — see
// services/ai/waseet-ai/waseet-ai.adapters.ts (mapProjectAnalysisResponse).
export interface AiReviewResponse {
  clarityScore: number;
  feasibilityScore: number;
  /** null when WaseetAI's rating is not exactly High/Medium/Low. */
  marketFitRating: 'High' | 'Medium' | 'Low' | null;
  executiveSummary: string;
  strengths: string[];
  gapsAndRisks: string[];
  /** Not returned by WaseetAI project-analysis — always []. */
  recommendedImprovements: string[];
  suggestedMilestones: SuggestedMilestone[];
  /** Not returned by WaseetAI project-analysis — always null. */
  suggestedPricingStrategy: {
    recommendedRange: string;
    reasoning: string;
  } | null;
}
