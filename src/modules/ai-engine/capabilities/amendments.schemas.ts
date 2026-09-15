import { z } from 'zod';
import { aiSchemaRegistry } from '../schema-registry';

export const AMENDMENTS_SCHEMA_VERSION = '2026-09-15.v1';

export const AMENDMENTS_SCHEMA_IDS = {
  amendmentImpactAnalysis: 'amendments.amendment-impact-analysis',
} as const;

const boundedText = z.string().min(1).max(700);
const boundedReasons = z.array(boundedText).min(1).max(4);

const impactSectionSchema = z.object({
  assessment: boundedText,
  reasons: boundedReasons,
}).strict();

export const amendmentImpactAnalysisSchema = z.object({
  impactLevel: z.enum(['low', 'medium', 'high', 'critical']),
  scopeImpact: impactSectionSchema,
  budgetImpact: impactSectionSchema,
  scheduleImpact: impactSectionSchema,
  reasonableness: z.enum([
    'reasonable',
    'needs_revision',
    'disproportionate',
    'insufficient_context',
  ]),
  recommendedAdjustment: z.object({
    budgetDirection: z.enum([
      'increase',
      'decrease',
      'unchanged',
      'insufficient_context',
    ]),
    durationDirection: z.enum([
      'increase',
      'decrease',
      'unchanged',
      'insufficient_context',
    ]),
    guidance: boundedText,
  }).strict(),
  risks: z.array(boundedText).max(5),
  summary: boundedText,
}).strict();

export type AmendmentImpactAnalysisAiOutput = z.infer<
  typeof amendmentImpactAnalysisSchema
>;

aiSchemaRegistry.register<AmendmentImpactAnalysisAiOutput>({
  id: AMENDMENTS_SCHEMA_IDS.amendmentImpactAnalysis,
  version: AMENDMENTS_SCHEMA_VERSION,
  schema: amendmentImpactAnalysisSchema,
  description: 'Advisory project amendment impact analysis returned by Waseet AI.',
});
