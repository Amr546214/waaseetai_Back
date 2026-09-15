import {
  disputeAnalysisContextService,
  DisputeCaseAnalysisFacts,
} from './dispute-analysis-context.service';
import { AppError } from '../utils/app-error';
import { structuredAiExecutionService } from '../modules/ai-engine';
import type {
  AiAuditEntityRef,
  AiEngineErrorPayload,
  DisputeCaseAnalysisAiOutput,
  DisputeCaseAnalysisContext,
} from '../modules/ai-engine';

export interface DisputeCaseAnalysisResponse {
  facts: DisputeCaseAnalysisFacts;
  analysis: DisputeCaseAnalysisAiOutput;
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

export class DisputeAiService {
  async analyzeDisputeCase(
    adminUserId: string,
    disputeId: string
  ): Promise<DisputeCaseAnalysisResponse> {
    const { context, facts, auditRefs } =
      await disputeAnalysisContextService.build(disputeId);
    const relatedEntities: AiAuditEntityRef[] = [];
    if (auditRefs.projectId) {
      relatedEntities.push({ type: 'PROJECT', id: auditRefs.projectId });
    }
    if (auditRefs.contractId) {
      relatedEntities.push({ type: 'CONTRACT', id: auditRefs.contractId });
    }

    const result = await structuredAiExecutionService.execute<
      DisputeCaseAnalysisContext,
      DisputeCaseAnalysisAiOutput
    >({
      capability: 'disputes',
      operation: 'dispute_case_analysis',
      input: context,
      locale: 'ar',
      auditContext: {
        actorUserId: adminUserId,
        primaryEntity: { type: 'DISPUTE', id: auditRefs.disputeId },
        ...(relatedEntities.length > 0 && { relatedEntities }),
      },
    });

    if (!result.success) {
      throw createAiFailureAppError(
        'AI dispute case analysis failed. No simulated dispute analysis was returned.',
        result.error
      );
    }

    return {
      facts,
      analysis: result.data,
    };
  }
}

export const disputeAiService = new DisputeAiService();
