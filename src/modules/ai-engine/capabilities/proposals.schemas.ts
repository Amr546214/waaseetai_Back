import { z } from 'zod';
import { aiSchemaRegistry } from '../schema-registry';

export const PROPOSALS_SCHEMA_VERSION = '2026-09-14.v1';

export const PROPOSALS_SCHEMA_IDS = {
  proposalFeedback: 'proposals.proposal-feedback',
} as const;

export const proposalPriceAuditSchema = z.object({
  recommendedMin: z.number().nonnegative(),
  recommendedMax: z.number().nonnegative(),
  priceTag: z.enum(['UNDERPRICED', 'FAIR', 'OVERPRICED']),
  justification: z.string().min(1),
}).strict().refine(
  value => value.recommendedMax >= value.recommendedMin,
  { message: 'recommendedMax must be greater than or equal to recommendedMin.' }
);

export const proposalFeedbackSchema = z.object({
  suggestedTitle: z.string().min(1).max(80),
  suggestedMessage: z.string().min(1),
  qualityScore: z.number().int().min(0).max(100),
  qualityTag: z.enum(['POOR', 'MEDIUM', 'GOOD', 'EXCELLENT']),
  priceAudit: proposalPriceAuditSchema,
  recommendedAdvantages: z.array(z.string().min(1)).min(1).max(5),
}).strict();

export type ProposalFeedbackAiOutput = z.infer<typeof proposalFeedbackSchema>;

aiSchemaRegistry.register<ProposalFeedbackAiOutput>({
  id: PROPOSALS_SCHEMA_IDS.proposalFeedback,
  version: PROPOSALS_SCHEMA_VERSION,
  schema: proposalFeedbackSchema,
  description: 'Provider proposal feedback and fair-price audit returned by Waseet AI.',
});
