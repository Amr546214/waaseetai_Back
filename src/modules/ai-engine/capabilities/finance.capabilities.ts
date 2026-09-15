import { aiCapabilityRegistry } from '../capability-registry';
import {
  FINANCE_PROMPT_IDS,
  FINANCE_PROMPT_VERSION,
} from './finance.prompts';
import {
  FINANCE_SCHEMA_IDS,
  FINANCE_SCHEMA_VERSION,
} from './finance.schemas';

aiCapabilityRegistry.register({
  capability: 'finance',
  operation: 'invoice_consistency_analysis',
  promptId: FINANCE_PROMPT_IDS.invoiceConsistencyAnalysis,
  promptVersion: FINANCE_PROMPT_VERSION,
  schemaId: FINANCE_SCHEMA_IDS.invoiceConsistencyAnalysis,
  schemaVersion: FINANCE_SCHEMA_VERSION,
  purpose: 'complex_reasoning',
  failurePolicy: 'FAIL_CLOSED',
  temperature: 0.2,
  maxTokens: 900,
});

aiCapabilityRegistry.register({
  capability: 'finance',
  operation: 'financial_report_insights',
  promptId: FINANCE_PROMPT_IDS.financialReportInsights,
  promptVersion: FINANCE_PROMPT_VERSION,
  schemaId: FINANCE_SCHEMA_IDS.financialReportInsights,
  schemaVersion: FINANCE_SCHEMA_VERSION,
  purpose: 'complex_reasoning',
  failurePolicy: 'FAIL_CLOSED',
  temperature: 0.3,
  maxTokens: 1000,
});
