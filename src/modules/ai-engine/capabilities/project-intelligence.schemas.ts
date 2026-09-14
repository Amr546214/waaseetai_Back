import { z } from 'zod';
import { aiSchemaRegistry } from '../schema-registry';

export const PROJECT_INTELLIGENCE_SCHEMA_VERSION = '2026-09-14.v1';

export const PROJECT_INTELLIGENCE_SCHEMA_IDS = {
  suggestedMilestones: 'project-intelligence.suggested-milestones',
  projectModelAnalysis: 'project-intelligence.project-model-analysis',
  clientRequestSuggestions: 'project-intelligence.client-request-suggestions',
} as const;

const percentageTotalWithinTolerance = (
  milestones: Array<{ percentage: number }>
): boolean => {
  const total = milestones.reduce((sum, milestone) => sum + milestone.percentage, 0);
  return Math.abs(total - 100) <= 1;
};

export const suggestedMilestoneSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  estimatedDays: z.number().int().min(1).max(60),
  percentage: z.number().min(0).max(100),
}).strict();

export const suggestedMilestonesResponseSchema = z.object({
  milestones: z.array(suggestedMilestoneSchema).min(1).max(4),
}).strict().refine(
  value => percentageTotalWithinTolerance(value.milestones),
  { message: 'Milestone percentages must total 100 within a tolerance of 1 percentage point.' }
);

export const projectModelAnalysisSchema = z.object({
  clarityScore: z.number().min(0).max(100),
  feasibilityScore: z.number().min(0).max(100),
  marketFitRating: z.enum(['High', 'Medium', 'Low']),
  executiveSummary: z.string().min(1),
  strengths: z.array(z.string()),
  gapsAndRisks: z.array(z.string()),
  recommendedImprovements: z.array(z.string()),
  suggestedMilestones: z.array(suggestedMilestoneSchema).min(1),
  suggestedPricingStrategy: z.object({
    recommendedRange: z.string().min(1),
    reasoning: z.string().min(1),
  }).strict(),
}).strict();

export const clientRequestSuggestionsSchema = z.object({
  suggestedTitle: z.string().min(1).max(120),
  suggestedDescription: z.string().min(1),
  suggestedSubSpecialties: z.array(z.string().min(1)).min(1).max(10),
  recommendedMinBudget: z.number().nonnegative(),
  recommendedMaxBudget: z.number().nonnegative(),
  suggestedDurationDays: z.number().int().positive(),
  complexityRating: z.enum(['LOW', 'MEDIUM', 'HIGH', 'COMPLEX']),
  personalizedNote: z.string().min(1),
  aiMatchScoreEstimate: z.number().min(0).max(100),
}).strict().refine(
  value => value.recommendedMaxBudget >= value.recommendedMinBudget,
  { message: 'recommendedMaxBudget must be greater than or equal to recommendedMinBudget.' }
);

export type SuggestedMilestonesAiOutput = z.infer<typeof suggestedMilestonesResponseSchema>;
export type ProjectModelAnalysisAiOutput = z.infer<typeof projectModelAnalysisSchema>;
export type ClientRequestSuggestionsAiOutput = z.infer<typeof clientRequestSuggestionsSchema>;

aiSchemaRegistry.register<SuggestedMilestonesAiOutput>({
  id: PROJECT_INTELLIGENCE_SCHEMA_IDS.suggestedMilestones,
  version: PROJECT_INTELLIGENCE_SCHEMA_VERSION,
  schema: suggestedMilestonesResponseSchema,
  description: 'Suggested project milestones returned by Waseet AI.',
});

aiSchemaRegistry.register<ProjectModelAnalysisAiOutput>({
  id: PROJECT_INTELLIGENCE_SCHEMA_IDS.projectModelAnalysis,
  version: PROJECT_INTELLIGENCE_SCHEMA_VERSION,
  schema: projectModelAnalysisSchema,
  description: 'Strategic project model review returned by Waseet AI.',
});

aiSchemaRegistry.register<ClientRequestSuggestionsAiOutput>({
  id: PROJECT_INTELLIGENCE_SCHEMA_IDS.clientRequestSuggestions,
  version: PROJECT_INTELLIGENCE_SCHEMA_VERSION,
  schema: clientRequestSuggestionsSchema,
  description: 'Client request draft suggestions returned by Waseet AI.',
});
