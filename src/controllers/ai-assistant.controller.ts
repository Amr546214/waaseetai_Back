import { Request, Response } from 'express';
import { aiFeatureUnavailablePayload } from '../services/ai/ai-feature-unavailable';

// Deep project-fit analysis for providers is switched off: all AI must run
// exclusively through the WaseetAI service, and this operation is not wired to
// it. No direct-model call, no fallback, no fabricated analysis, and no
// database access/caching happens here; previously cached project analyses
// stay as they are.

export const PROJECT_FIT_ANALYSIS_UNAVAILABLE_MESSAGE =
  'التحليل الذكي لملاءمة المشروع متوقف مؤقتاً حتى يكتمل ربطه بخدمة WaseetAI. يمكنك متابعة استعراض المشاريع وتقديم عروضك بشكل طبيعي.';

export const analyzeProjectForProvider = async (_req: Request, res: Response): Promise<void> => {
  res.status(503).json({
    success: false,
    ...aiFeatureUnavailablePayload(PROJECT_FIT_ANALYSIS_UNAVAILABLE_MESSAGE),
  });
};
