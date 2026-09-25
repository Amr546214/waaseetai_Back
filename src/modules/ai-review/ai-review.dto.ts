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

export interface AiReviewResponse {
  clarityScore: number;
  feasibilityScore: number;
  marketFitRating: 'High' | 'Medium' | 'Low';
  executiveSummary: string;
  strengths: string[];
  gapsAndRisks: string[];
  recommendedImprovements: string[];
  suggestedMilestones: SuggestedMilestone[];
  suggestedPricingStrategy: {
    recommendedRange: string;
    reasoning: string;
  };
}
