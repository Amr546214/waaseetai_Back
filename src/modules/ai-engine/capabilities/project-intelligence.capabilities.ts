import { aiCapabilityRegistry } from '../capability-registry';
import {
  PROJECT_INTELLIGENCE_PROMPT_IDS,
  PROJECT_INTELLIGENCE_PROMPT_VERSION,
} from './project-intelligence.prompts';
import {
  PROJECT_INTELLIGENCE_SCHEMA_IDS,
  PROJECT_INTELLIGENCE_SCHEMA_VERSION,
} from './project-intelligence.schemas';

aiCapabilityRegistry.register({
  capability: 'project_intelligence',
  operation: 'suggest_milestones',
  promptId: PROJECT_INTELLIGENCE_PROMPT_IDS.suggestMilestones,
  promptVersion: PROJECT_INTELLIGENCE_PROMPT_VERSION,
  schemaId: PROJECT_INTELLIGENCE_SCHEMA_IDS.suggestedMilestones,
  schemaVersion: PROJECT_INTELLIGENCE_SCHEMA_VERSION,
  purpose: 'standard_json',
  failurePolicy: 'FAIL_CLOSED',
  temperature: 0.5,
  maxTokens: 800,
});

aiCapabilityRegistry.register({
  capability: 'project_intelligence',
  operation: 'analyze_project_model',
  promptId: PROJECT_INTELLIGENCE_PROMPT_IDS.analyzeProjectModel,
  promptVersion: PROJECT_INTELLIGENCE_PROMPT_VERSION,
  schemaId: PROJECT_INTELLIGENCE_SCHEMA_IDS.projectModelAnalysis,
  schemaVersion: PROJECT_INTELLIGENCE_SCHEMA_VERSION,
  purpose: 'complex_reasoning',
  failurePolicy: 'FAIL_CLOSED',
  temperature: 0.5,
  maxTokens: 1500,
});

aiCapabilityRegistry.register({
  capability: 'project_intelligence',
  operation: 'client_request_suggestions',
  promptId: PROJECT_INTELLIGENCE_PROMPT_IDS.clientRequestSuggestions,
  promptVersion: PROJECT_INTELLIGENCE_PROMPT_VERSION,
  schemaId: PROJECT_INTELLIGENCE_SCHEMA_IDS.clientRequestSuggestions,
  schemaVersion: PROJECT_INTELLIGENCE_SCHEMA_VERSION,
  purpose: 'complex_reasoning',
  failurePolicy: 'FAIL_CLOSED',
  temperature: 0.7,
  maxTokens: 1200,
});
