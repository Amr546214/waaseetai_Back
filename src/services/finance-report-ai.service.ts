import {
  financeReportContextService,
  FinanceReportFacts,
} from './finance-report-context.service';
import { AppError } from '../utils/app-error';
import { structuredAiExecutionService } from '../modules/ai-engine';
import type {
  AiEngineErrorPayload,
  FinancialReportInsightsAiOutput,
  FinancialReportInsightsContext,
} from '../modules/ai-engine';
import type { AccountType } from '@prisma/client';

export interface FinancialReportInsightsResponse {
  facts: FinanceReportFacts;
  analysis: FinancialReportInsightsAiOutput;
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

export class FinanceReportAiService {
  async analyzeFinancialReport(
    userId: string,
    accountType: AccountType
  ): Promise<FinancialReportInsightsResponse> {
    const { context, facts } = await financeReportContextService.build(
      userId,
      accountType
    );

    const result = await structuredAiExecutionService.execute<
      FinancialReportInsightsContext,
      FinancialReportInsightsAiOutput
    >({
      capability: 'finance',
      operation: 'financial_report_insights',
      input: context,
      locale: 'ar',
      auditContext: {
        actorUserId: userId,
      },
    });

    if (!result.success) {
      throw createAiFailureAppError(
        'AI financial report insights failed. No simulated financial report insights were returned.',
        result.error
      );
    }

    return {
      facts,
      analysis: result.data,
    };
  }
}

export const financeReportAiService = new FinanceReportAiService();
