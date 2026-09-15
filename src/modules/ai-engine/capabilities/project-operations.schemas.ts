import { z } from 'zod';
import { aiSchemaRegistry } from '../schema-registry';

export const PROJECT_OPERATIONS_SCHEMA_VERSION = '2026-09-14.v1';

export const PROJECT_OPERATIONS_SCHEMA_IDS = {
  projectHealthAnalysis: 'project-operations.project-health-analysis',
} as const;

export const projectHealthAnalysisSchema = z.object({
  healthStatus: z.enum([
    'healthy',
    'attention_needed',
    'delayed',
    'blocked',
    'review_required',
  ]),
  riskLevelKey: z.enum(['none', 'low', 'medium', 'high']),
  healthRating: z.string().min(1),
  primaryReason: z.string().min(1),
  bullets: z.array(z.string().min(1)).min(1).max(4),
  recommendedAction: z.object({
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
    owner: z.enum(['client', 'provider', 'both']),
    action: z.string().min(1),
    reason: z.string().min(1),
  }).strict(),
}).strict();

export type ProjectHealthAnalysisAiOutput = z.infer<
  typeof projectHealthAnalysisSchema
>;

aiSchemaRegistry.register<ProjectHealthAnalysisAiOutput>({
  id: PROJECT_OPERATIONS_SCHEMA_IDS.projectHealthAnalysis,
  version: PROJECT_OPERATIONS_SCHEMA_VERSION,
  schema: projectHealthAnalysisSchema,
  description: 'Active project health interpretation returned by Waseet AI.',
});
