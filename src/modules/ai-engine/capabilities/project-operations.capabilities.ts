import { aiCapabilityRegistry } from '../capability-registry';
import {
  PROJECT_OPERATIONS_PROMPT_IDS,
  PROJECT_OPERATIONS_PROMPT_VERSION,
} from './project-operations.prompts';
import {
  PROJECT_OPERATIONS_SCHEMA_IDS,
  PROJECT_OPERATIONS_SCHEMA_VERSION,
} from './project-operations.schemas';

aiCapabilityRegistry.register({
  capability: 'project_operations',
  operation: 'project_health_analysis',
  promptId: PROJECT_OPERATIONS_PROMPT_IDS.projectHealthAnalysis,
  promptVersion: PROJECT_OPERATIONS_PROMPT_VERSION,
  schemaId: PROJECT_OPERATIONS_SCHEMA_IDS.projectHealthAnalysis,
  schemaVersion: PROJECT_OPERATIONS_SCHEMA_VERSION,
  purpose: 'standard_json',
  failurePolicy: 'OPTIONAL_AI',
  temperature: 0.4,
  maxTokens: 900,
});
