import { aiCapabilityRegistry } from '../capability-registry';
import {
  MATCHING_PROMPT_IDS,
  MATCHING_PROMPT_VERSION,
} from './matching.prompts';
import {
  MATCHING_SCHEMA_IDS,
  MATCHING_SCHEMA_VERSION,
} from './matching.schemas';

aiCapabilityRegistry.register({
  capability: 'matching',
  operation: 'rank_provider_project_matches',
  promptId: MATCHING_PROMPT_IDS.providerProjectRanking,
  promptVersion: MATCHING_PROMPT_VERSION,
  schemaId: MATCHING_SCHEMA_IDS.providerProjectRanking,
  schemaVersion: MATCHING_SCHEMA_VERSION,
  purpose: 'standard_json',
  failurePolicy: 'OPTIONAL_AI',
  temperature: 0.2,
  maxTokens: 800,
});
