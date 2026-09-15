import { aiCapabilityRegistry } from '../capability-registry';
import {
  DISPUTES_PROMPT_IDS,
  DISPUTES_PROMPT_VERSION,
} from './disputes.prompts';
import {
  DISPUTES_SCHEMA_IDS,
  DISPUTES_SCHEMA_VERSION,
} from './disputes.schemas';

aiCapabilityRegistry.register({
  capability: 'disputes',
  operation: 'dispute_case_analysis',
  promptId: DISPUTES_PROMPT_IDS.disputeCaseAnalysis,
  promptVersion: DISPUTES_PROMPT_VERSION,
  schemaId: DISPUTES_SCHEMA_IDS.disputeCaseAnalysis,
  schemaVersion: DISPUTES_SCHEMA_VERSION,
  purpose: 'complex_reasoning',
  failurePolicy: 'FAIL_CLOSED',
  temperature: 0.2,
  maxTokens: 1400,
});
