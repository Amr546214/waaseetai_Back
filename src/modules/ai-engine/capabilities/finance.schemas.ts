import { z } from 'zod';
import { aiSchemaRegistry } from '../schema-registry';

export const FINANCE_SCHEMA_VERSION = '2026-09-15.v1';

export const FINANCE_SCHEMA_IDS = {
  invoiceConsistencyAnalysis: 'finance.invoice-consistency-analysis',
  financialReportInsights: 'finance.financial-report-insights',
} as const;

const boundedText = z.string().min(1).max(700);
const boundedFindingText = z.string().min(1).max(260);
const boundedActionText = z.string().min(1).max(260);

const invoiceFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'critical']),
  area: z.enum(['amounts', 'tax', 'documents', 'status', 'timeline', 'other']),
  message: boundedFindingText,
}).strict();

export const invoiceConsistencyAnalysisSchema = z.object({
  status: z.enum(['consistent', 'needs_review', 'insufficient_context']),
  findings: z.array(invoiceFindingSchema).max(6),
  recommendedReview: z.object({
    required: z.boolean(),
    reason: boundedFindingText,
  }).strict(),
  summary: boundedText,
}).strict();

export type InvoiceConsistencyAnalysisAiOutput = z.infer<
  typeof invoiceConsistencyAnalysisSchema
>;

const financialReportRiskSchema = z.object({
  level: z.enum(['low', 'medium', 'high']),
  area: z.enum([
    'spending',
    'earnings',
    'escrow',
    'projects',
    'proposals',
    'data_quality',
  ]),
  message: boundedFindingText,
}).strict();

export const financialReportInsightsSchema = z.object({
  summary: boundedText,
  highlights: z.array(boundedActionText).max(5),
  risks: z.array(financialReportRiskSchema).max(5),
  recommendedActions: z.array(boundedActionText).max(4),
}).strict();

export type FinancialReportInsightsAiOutput = z.infer<
  typeof financialReportInsightsSchema
>;

aiSchemaRegistry.register<InvoiceConsistencyAnalysisAiOutput>({
  id: FINANCE_SCHEMA_IDS.invoiceConsistencyAnalysis,
  version: FINANCE_SCHEMA_VERSION,
  schema: invoiceConsistencyAnalysisSchema,
  description: 'Invoice consistency interpretation returned by Waseet AI.',
});

aiSchemaRegistry.register<FinancialReportInsightsAiOutput>({
  id: FINANCE_SCHEMA_IDS.financialReportInsights,
  version: FINANCE_SCHEMA_VERSION,
  schema: financialReportInsightsSchema,
  description: 'Aggregate financial report insights returned by Waseet AI.',
});
