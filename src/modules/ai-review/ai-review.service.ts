import { logger } from '../../config/logger';
import { AppError } from '../../utils/app-error';
import { waseetAiClient, type WaseetAiClient } from '../../services/ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError } from '../../services/ai/waseet-ai/waseet-ai.errors';
import {
  buildMilestonesRequest,
  buildProjectAnalysisRequest,
  mapMilestonesResponse,
  mapProjectAnalysisResponse,
} from '../../services/ai/waseet-ai/waseet-ai.adapters';
import { CompleteProjectDataDto, AiReviewResponse, SuggestMilestonesDto, SuggestedMilestone } from './ai-review.dto';

// AI-03 (milestones) and AI-04 (project analysis) for the provider "New
// Project" wizard — backed by the WaseetAI microservice (documented v1.0.0
// contracts /v1/ai/milestones and /v1/ai/project-analysis) through the shared
// WaseetAiClient. The HTTP contract Angular sees (/api/ai-review/*) is
// unchanged; request/response mapping lives in waseet-ai.adapters.ts.
//
// Failure behavior is unchanged from the Gemini era: any WaseetAI failure
// (HTTP error, timeout, malformed/incomplete response, not configured) is an
// honest AppError(503) — never canned milestones, never fabricated scores.
// A documented required input Waseet doesn't have (budget / timeline) is a
// 400, never a defaulted value.

const MILESTONES_UNAVAILABLE = 'تعذر اقتراح مراحل المشروع عبر الذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.';
const ANALYSIS_UNAVAILABLE = 'تعذر تقييم نموذج المشروع عبر الذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.';

function logFailure(op: string, error: unknown): void {
  // Code/status/requestId only — never upstream bodies, never the token.
  const e = normalizeWaseetAiError(error);
  logger.error(`[AiReviewService] WaseetAI ${op} failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
}

export class AiReviewService {
  constructor(private readonly client: WaseetAiClient = waseetAiClient) {}

  /** AI-03 — WaseetAI POST /v1/ai/milestones → SuggestedMilestone[]. */
  async suggestMilestones(dto: SuggestMilestonesDto): Promise<SuggestedMilestone[]> {
    const request = buildMilestonesRequest(dto);
    if (!request) {
      throw new AppError('اسم المشروع والقيمة الإجمالية مطلوبان لاقتراح المراحل.', 400);
    }
    try {
      const data = await this.client.suggestMilestones(request);
      return mapMilestonesResponse(data);
    } catch (error) {
      logFailure('milestones', error);
      throw new AppError(MILESTONES_UNAVAILABLE, 503);
    }
  }

  /**
   * AI-04 — WaseetAI POST /v1/ai/project-analysis, plus the documented
   * /v1/ai/milestones call for the `suggestedMilestones` part of the existing
   * response (project-analysis itself does not return milestones). The two
   * run in parallel; only the analysis is required — if the milestones call
   * fails, suggestedMilestones is honestly [] rather than invented.
   */
  async analyzeProjectModel(data: CompleteProjectDataDto): Promise<AiReviewResponse> {
    const analysisRequest = buildProjectAnalysisRequest(data);
    if (!analysisRequest) {
      throw new AppError('اسم المشروع والقيمة الإجمالية ومدة المراحل مطلوبة لتحليل نموذج المشروع.', 400);
    }
    const milestonesRequest = buildMilestonesRequest({
      title: analysisRequest.title,
      description: analysisRequest.description,
      totalAmount: analysisRequest.budget,
    });

    const [analysis, milestones] = await Promise.allSettled([
      this.client.analyzeProject(analysisRequest),
      milestonesRequest ? this.client.suggestMilestones(milestonesRequest).then(mapMilestonesResponse) : Promise.resolve(null),
    ]);

    if (milestones.status === 'rejected') logFailure('milestones (analysis companion)', milestones.reason);

    if (analysis.status === 'rejected') {
      logFailure('project-analysis', analysis.reason);
      throw new AppError(ANALYSIS_UNAVAILABLE, 503);
    }
    try {
      return mapProjectAnalysisResponse(analysis.value, milestones.status === 'fulfilled' ? milestones.value : null);
    } catch (error) {
      logFailure('project-analysis', error);
      throw new AppError(ANALYSIS_UNAVAILABLE, 503);
    }
  }
}
