import { z } from 'zod';
import { aiSchemaRegistry } from '../schema-registry';

export const MATCHING_SCHEMA_VERSION = '2026-09-14.v1';

export const MATCHING_SCHEMA_IDS = {
  providerProjectRanking: 'matching.provider-project-ranking',
} as const;

export const providerProjectMatchSchema = z.object({
  projectId: z.string().min(1),
  aiMatchScore: z.number().int().min(0).max(100),
  matchReasons: z.array(z.string().min(1)).min(1).max(5),
  aiAnalysis: z.string().min(1),
}).strict();

export const providerProjectRankingSchema = z.object({
  matches: z.array(providerProjectMatchSchema).max(3),
}).strict();

export type ProviderProjectRankingAiOutput = z.infer<typeof providerProjectRankingSchema>;

aiSchemaRegistry.register<ProviderProjectRankingAiOutput>({
  id: MATCHING_SCHEMA_IDS.providerProjectRanking,
  version: MATCHING_SCHEMA_VERSION,
  schema: providerProjectRankingSchema,
  description: 'Ranked provider-to-project matches returned by Waseet AI.',
});
