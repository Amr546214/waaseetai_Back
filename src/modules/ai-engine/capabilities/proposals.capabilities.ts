import { aiCapabilityRegistry } from '../capability-registry';
import {
  PROPOSALS_PROMPT_IDS,
  PROPOSALS_PROMPT_VERSION,
} from './proposals.prompts';
import {
  PROPOSALS_SCHEMA_IDS,
  PROPOSALS_SCHEMA_VERSION,
} from './proposals.schemas';

aiCapabilityRegistry.register({
  capability: 'proposals',
  operation: 'proposal_feedback',
  promptId: PROPOSALS_PROMPT_IDS.proposalFeedback,
  promptVersion: PROPOSALS_PROMPT_VERSION,
  schemaId: PROPOSALS_SCHEMA_IDS.proposalFeedback,
  schemaVersion: PROPOSALS_SCHEMA_VERSION,
  purpose: 'standard_json',
  failurePolicy: 'FAIL_CLOSED',
  temperature: 0.7,
  maxTokens: 1500,
});

aiCapabilityRegistry.register({
  capability: 'proposals',
  operation: 'proposal_submission_evaluation',
  promptId: PROPOSALS_PROMPT_IDS.proposalFeedback,
  promptVersion: PROPOSALS_PROMPT_VERSION,
  schemaId: PROPOSALS_SCHEMA_IDS.proposalFeedback,
  schemaVersion: PROPOSALS_SCHEMA_VERSION,
  purpose: 'standard_json',
  failurePolicy: 'OPTIONAL_AI',
  temperature: 0.7,
  maxTokens: 1500,
});
