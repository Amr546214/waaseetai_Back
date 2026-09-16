import { aiCapabilityRegistry } from '../capability-registry';
import {
  PROFILE_INTELLIGENCE_PROMPT_IDS,
  PROFILE_INTELLIGENCE_PROMPT_VERSION,
} from './profile-intelligence.prompts';
import {
  PROFILE_INTELLIGENCE_SCHEMA_IDS,
  PROFILE_INTELLIGENCE_SCHEMA_VERSION,
} from './profile-intelligence.schemas';

aiCapabilityRegistry.register({
  capability: 'profile_intelligence',
  operation: 'sensitive_change_review',
  promptId: PROFILE_INTELLIGENCE_PROMPT_IDS.sensitiveChangeReview,
  promptVersion: PROFILE_INTELLIGENCE_PROMPT_VERSION,
  schemaId: PROFILE_INTELLIGENCE_SCHEMA_IDS.sensitiveChangeReview,
  schemaVersion: PROFILE_INTELLIGENCE_SCHEMA_VERSION,
  purpose: 'standard_json',
  failurePolicy: 'OPTIONAL_AI',
  temperature: 0.2,
  maxTokens: 900,
});
