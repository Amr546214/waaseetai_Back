import {
  AI_MATCHING_ENGINE_SYSTEM_PROMPT,
  buildAiMatchingUserPrompt,
} from '../../../prompts/ai-matching.prompt';
import type {
  CandidateProjectPayload,
  ProviderContextPayload,
} from '../../../prompts/ai-matching.prompt';
import { aiPromptRegistry } from '../prompt-registry';

export const MATCHING_PROMPT_VERSION = '2026-09-14.v1';

export const MATCHING_PROMPT_IDS = {
  providerProjectRanking: 'matching.rank-provider-projects',
} as const;

export interface RankProviderProjectMatchesPromptInput {
  provider: ProviderContextPayload;
  candidates: CandidateProjectPayload[];
}

export type {
  CandidateProjectPayload,
  ProviderContextPayload,
};

aiPromptRegistry.register<RankProviderProjectMatchesPromptInput>({
  id: MATCHING_PROMPT_IDS.providerProjectRanking,
  version: MATCHING_PROMPT_VERSION,
  capability: 'matching',
  operation: 'rank_provider_project_matches',
  defaultLocale: 'ar',
  supportedLocales: ['ar'],
  buildSystemPrompt: () => AI_MATCHING_ENGINE_SYSTEM_PROMPT,
  buildUserPrompt: input => buildAiMatchingUserPrompt(input.provider, input.candidates),
});
