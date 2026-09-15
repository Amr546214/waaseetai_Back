import { aiCapabilityRegistry } from '../capability-registry';
import {
  AMENDMENTS_PROMPT_IDS,
  AMENDMENTS_PROMPT_VERSION,
} from './amendments.prompts';
import {
  AMENDMENTS_SCHEMA_IDS,
  AMENDMENTS_SCHEMA_VERSION,
} from './amendments.schemas';

aiCapabilityRegistry.register({
  capability: 'amendments',
  operation: 'amendment_impact_analysis',
  promptId: AMENDMENTS_PROMPT_IDS.amendmentImpactAnalysis,
  promptVersion: AMENDMENTS_PROMPT_VERSION,
  schemaId: AMENDMENTS_SCHEMA_IDS.amendmentImpactAnalysis,
  schemaVersion: AMENDMENTS_SCHEMA_VERSION,
  purpose: 'complex_reasoning',
  failurePolicy: 'FAIL_CLOSED',
  temperature: 0.3,
  maxTokens: 1400,
});
