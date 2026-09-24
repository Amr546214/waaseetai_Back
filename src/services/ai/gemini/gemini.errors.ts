// Normalized, application-owned error taxonomy for the Gemini provider.
// Feature services must only ever see these codes, never a raw Gemini SDK
// exception — this keeps provider internals (and anything sensitive in
// them) out of anything that might bubble up to an API response.

export enum GeminiErrorCode {
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  UNKNOWN_PROVIDER_ERROR = 'UNKNOWN_PROVIDER_ERROR',
}

export class GeminiProviderError extends Error {
  readonly code: GeminiErrorCode;
  /** The original thrown value, kept only for internal logging/debugging —
   *  callers must never serialize this into an HTTP/socket response. */
  readonly cause?: unknown;

  constructor(code: GeminiErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'GeminiProviderError';
    this.code = code;
    this.cause = cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

const isAbortError = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';

const extractHttpStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
};

/**
 * Converts any thrown value from the Gemini SDK (or our own client code)
 * into a GeminiProviderError with a best-effort, non-sensitive classification.
 * Never throws itself, and never re-exposes secret/internal provider detail
 * in the resulting `.message`.
 */
export function normalizeGeminiError(error: unknown): GeminiProviderError {
  if (error instanceof GeminiProviderError) return error;

  if (isAbortError(error)) {
    return new GeminiProviderError(GeminiErrorCode.TIMEOUT, 'Gemini request timed out or was cancelled', error);
  }

  const status = extractHttpStatus(error);
  if (status === 401 || status === 403) {
    return new GeminiProviderError(GeminiErrorCode.AUTHENTICATION_ERROR, 'Gemini authentication failed', error);
  }
  if (status === 429) {
    return new GeminiProviderError(GeminiErrorCode.RATE_LIMITED, 'Gemini rate limit exceeded', error);
  }
  if (typeof status === 'number' && status >= 500) {
    return new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'Gemini service is currently unavailable', error);
  }

  return new GeminiProviderError(GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'Unexpected Gemini provider error', error);
}
