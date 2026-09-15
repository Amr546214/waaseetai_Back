import { z } from 'zod';
import { aiSchemaRegistry } from '../schema-registry';

export const DISPUTES_SCHEMA_VERSION = '2026-09-15.v1';

export const DISPUTES_SCHEMA_IDS = {
  disputeCaseAnalysis: 'disputes.dispute-case-analysis',
} as const;

const boundedSummaryText = z.string().min(1).max(700);
const boundedItemText = z.string().min(1).max(300);

const scopeAlignmentSchema = z.object({
  assessment: z.enum([
    'aligned',
    'partially_aligned',
    'not_aligned',
    'insufficient_context',
  ]),
  reasons: z.array(boundedItemText).min(1).max(4),
}).strict();

const evidenceAssessmentSchema = z.object({
  coverage: z.enum([
    'adequate_for_initial_review',
    'partial',
    'insufficient',
  ]),
  missingItems: z.array(boundedItemText).max(5),
  observations: z.array(boundedItemText).max(5),
}).strict();

const recommendationSchema = z.object({
  type: z.enum([
    'continue_review',
    'request_more_evidence',
    'consider_settlement',
    'manual_review_required',
  ]),
  rationale: boundedSummaryText,
}).strict();

const settlementGuidanceSchema = z.object({
  appropriate: z.boolean(),
  guidance: boundedSummaryText,
}).strict();

export const disputeCaseAnalysisSchema = z.object({
  caseSummary: boundedSummaryText,
  scopeAlignment: scopeAlignmentSchema,
  evidenceAssessment: evidenceAssessmentSchema,
  keyIssues: z.array(boundedItemText).max(5),
  recommendation: recommendationSchema,
  settlementGuidance: settlementGuidanceSchema.nullable(),
  humanReviewRequired: z.literal(true),
  summary: boundedSummaryText,
}).strict();

export type DisputeCaseAnalysisAiOutput = z.infer<
  typeof disputeCaseAnalysisSchema
>;

aiSchemaRegistry.register<DisputeCaseAnalysisAiOutput>({
  id: DISPUTES_SCHEMA_IDS.disputeCaseAnalysis,
  version: DISPUTES_SCHEMA_VERSION,
  schema: disputeCaseAnalysisSchema,
  description: 'Advisory dispute case analysis for Waseet admin review.',
});
