import { AmendmentAnalysisDto } from '../dtos/amendment-analysis.dto';
import {
  amendmentAnalysisContextService,
  AmendmentImpactFacts,
} from './amendment-analysis-context.service';
import { AppError } from '../utils/app-error';
import { structuredAiExecutionService } from '../modules/ai-engine';
import type {
  AiEngineErrorPayload,
  AmendmentAnalysisContext,
  AmendmentImpactAnalysisAiOutput,
} from '../modules/ai-engine';

export interface AmendmentImpactAnalysisResponse {
  facts: AmendmentImpactFacts;
  analysis: AmendmentImpactAnalysisAiOutput;
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

export class AmendmentAiService {
  async analyzeAmendmentImpact(
    userId: string,
    projectId: string,
    dto: AmendmentAnalysisDto
  ): Promise<AmendmentImpactAnalysisResponse> {
    const { context, facts } = await amendmentAnalysisContextService.build(
      userId,
      projectId,
      dto
    );

    const result = await structuredAiExecutionService.execute<
      AmendmentAnalysisContext,
      AmendmentImpactAnalysisAiOutput
    >({
      capability: 'amendments',
      operation: 'amendment_impact_analysis',
      input: context,
      locale: 'ar',
      auditContext: {
        actorUserId: userId,
        primaryEntity: { type: 'PROJECT', id: facts.project.id },
        relatedEntities: [{ type: 'CONTRACT', id: facts.contract.id }],
      },
    });

    if (!result.success) {
      throw createAiFailureAppError(
        'AI amendment impact analysis failed. No simulated amendment analysis was returned.',
        result.error
      );
    }

    return {
      facts,
      analysis: result.data,
    };
  }
}

export const amendmentAiService = new AmendmentAiService();
