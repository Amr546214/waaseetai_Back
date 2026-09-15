import {
  invoiceAnalysisContextService,
  InvoiceConsistencyFacts,
} from './invoice-analysis-context.service';
import { AppError } from '../utils/app-error';
import { structuredAiExecutionService } from '../modules/ai-engine';
import type {
  AiEngineErrorPayload,
  InvoiceConsistencyAnalysisAiOutput,
  InvoiceConsistencyAnalysisContext,
} from '../modules/ai-engine';

export interface InvoiceConsistencyAnalysisResponse {
  facts: InvoiceConsistencyFacts;
  analysis: InvoiceConsistencyAnalysisAiOutput;
}

const getAiFailureStatusCode = (error: AiEngineErrorPayload): number => {
  if (error.code === 'AI_PROVIDER_RATE_LIMITED') return 429;
  if (
    error.code === 'AI_RESPONSE_VALIDATION_FAILED' ||
    error.code === 'AI_PROVIDER_BAD_RESPONSE'
  ) return 502;

  return error.statusCode && error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : 503;
};

const createAiFailureAppError = (
  message: string,
  error: AiEngineErrorPayload
): AppError => {
  return new AppError(message, getAiFailureStatusCode(error), [error]);
};

export class InvoiceAiService {
  async analyzeInvoiceConsistency(
    clientId: string,
    deliveryId: string
  ): Promise<InvoiceConsistencyAnalysisResponse> {
    const { context, facts } = await invoiceAnalysisContextService.build(
      clientId,
      deliveryId
    );

    const result = await structuredAiExecutionService.execute<
      InvoiceConsistencyAnalysisContext,
      InvoiceConsistencyAnalysisAiOutput
    >({
      capability: 'finance',
      operation: 'invoice_consistency_analysis',
      input: context,
      locale: 'ar',
      auditContext: {
        actorUserId: clientId,
        primaryEntity: { type: 'CONTRACT', id: facts.invoice.contractId },
        relatedEntities: [{ type: 'PROJECT', id: facts.invoice.projectId }],
      },
    });

    if (!result.success) {
      throw createAiFailureAppError(
        'AI invoice consistency analysis failed. No simulated invoice analysis was returned.',
        result.error
      );
    }

    return {
      facts,
      analysis: result.data,
    };
  }
}

export const invoiceAiService = new InvoiceAiService();
