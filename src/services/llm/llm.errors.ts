import { AppError } from '../../utils/app-error';

// Internal LLM layer errors. They are always surfaced to users as an AppError with a FIXED Arabic message that never names a
// model provider and never echoes upstream text.

export enum LlmErrorCode {
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  BUSY = 'BUSY',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  UNGROUNDED_OUTPUT = 'UNGROUNDED_OUTPUT',
  UNKNOWN = 'UNKNOWN',
}

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** True only for genuinely transient upstream failures (HTTP 502/503, network). */
  readonly retryable: boolean;
  constructor(code: LlmErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = options.retryable === true;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export const LLM_NOT_CONFIGURED_MESSAGE = 'هذه الميزة الذكية غير مفعّلة حالياً. يمكنك المتابعة يدوياً.';
export const LLM_UNAVAILABLE_MESSAGE = 'تعذر إكمال التحليل الذكي حالياً. لم يتم تغيير أي شيء، يمكنك المتابعة يدوياً.';
export const LLM_RATE_LIMITED_MESSAGE = 'تجاوزت الحد المسموح لاستخدام هذه الميزة الذكية. حاول لاحقاً.';

export const LLM_AI_ERROR_CODE = 'AI_FEATURE_UNAVAILABLE';

/** The ONLY way an LlmError reaches a caller/user: a fixed message, no provider name, no upstream text. */
export function llmErrorToAppError(error: unknown): AppError {
  const e = error instanceof LlmError ? error : new LlmError(LlmErrorCode.UNKNOWN, 'unknown');
  if (e.code === LlmErrorCode.NOT_CONFIGURED) return Object.assign(new AppError(LLM_NOT_CONFIGURED_MESSAGE, 503), { code: LlmErrorCode.NOT_CONFIGURED });
  if (e.code === LlmErrorCode.RATE_LIMITED || e.code === LlmErrorCode.BUSY) return Object.assign(new AppError(LLM_RATE_LIMITED_MESSAGE, 429), { code: e.code });
  return Object.assign(new AppError(LLM_UNAVAILABLE_MESSAGE, 503), { code: e.code });
}
