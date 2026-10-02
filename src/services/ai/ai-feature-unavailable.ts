import { AppError } from '../../utils/app-error';

// Single source of truth for AI operations that are switched off because
// WaseetAI has no documented contract for them yet. All AI runs exclusively
// through the WaseetAI service; there is no direct-Gemini path and no
// fallback. Only the AI operation is disabled — the surrounding normal
// workflow, data and previous AI results are untouched.

export const AI_FEATURE_UNAVAILABLE_CODE = 'AI_FEATURE_UNAVAILABLE';

export const AI_FEATURE_UNAVAILABLE_MESSAGE =
  'هذه الميزة الذكية متوقفة مؤقتاً حتى يكتمل ربطها بخدمة WaseetAI. يمكنك متابعة عملك بشكل طبيعي دون الاعتماد عليها.';

export interface AiFeatureUnavailablePayload {
  code: typeof AI_FEATURE_UNAVAILABLE_CODE;
  message: string;
}

/** Payload for socket `*_error` events. */
export function aiFeatureUnavailablePayload(message: string = AI_FEATURE_UNAVAILABLE_MESSAGE): AiFeatureUnavailablePayload {
  return { code: AI_FEATURE_UNAVAILABLE_CODE, message };
}

/** HTTP 503 error carrying the fixed code, for services/controllers. */
export function aiFeatureUnavailableError(message: string = AI_FEATURE_UNAVAILABLE_MESSAGE): AppError {
  return Object.assign(new AppError(message, 503), { code: AI_FEATURE_UNAVAILABLE_CODE });
}

export function isAiFeatureUnavailableError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === AI_FEATURE_UNAVAILABLE_CODE;
}
