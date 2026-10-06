import { Request, Response } from 'express';
import { aiFeatureUnavailablePayload } from '../services/ai/ai-feature-unavailable';

// AI evaluation of a provider specialty is switched off: WaseetAI has no
// documented contract for it. It is not wired to the internal LlmClient yet (planned
// separately) and never fabricates scores.
//
// This handler deliberately performs NO database access at all: it never moves
// a specialty into UNDER_AI_REVIEW / TEST_REQUIRED / REJECTED / PENDING_PROOF,
// never writes scores or feedback, and never writes an AI audit log. The
// human/admin verification workflow and any previously stored results are
// therefore untouched.

export const SPECIALTY_AI_EVALUATION_UNAVAILABLE_MESSAGE =
  'التقييم الذكي للتخصص متوقف مؤقتاً حتى يكتمل ربطه بخدمة WaseetAI. يمكنك متابعة رفع النماذج وإكمال مراجعة التخصص بشكل طبيعي.';

export async function evaluateSpecialtyWithAI(_req: Request, res: Response): Promise<void> {
  res.status(503).json({
    success: false,
    ...aiFeatureUnavailablePayload(SPECIALTY_AI_EVALUATION_UNAVAILABLE_MESSAGE),
  });
}
