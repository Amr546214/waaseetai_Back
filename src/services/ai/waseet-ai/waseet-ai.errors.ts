// Normalized, application-owned error taxonomy for the WaseetAI microservice.
// Mirrors gemini.errors.ts: feature services only ever see these codes and
// fixed, non-sensitive messages. Nothing here ever includes request headers
// (and therefore never the bearer token), and upstream response bodies are
// never copied into `.message`.

export enum WaseetAiErrorCode {
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** Endpoint exists in the WaseetAI feature matrix but its request/response
   *  contract has not been verified against the live service yet. */
  CONTRACT_UNVERIFIED = 'CONTRACT_UNVERIFIED',
  BAD_REQUEST = 'BAD_REQUEST',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  TIMEOUT = 'TIMEOUT',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  /** The upstream stream itself emitted an error event (e.g. AI-21's
   *  `help:error` when no approved knowledge-base policy answers the
   *  question). The upstream message text is never copied. */
  STREAM_ERROR = 'STREAM_ERROR',
  UNKNOWN_PROVIDER_ERROR = 'UNKNOWN_PROVIDER_ERROR',
}

export class WaseetAiError extends Error {
  readonly code: WaseetAiErrorCode;
  /** Upstream HTTP status, when the failure came from an HTTP response. */
  readonly status?: number;
  /** X-Request-Id sent with the failing call, for cross-service tracing. */
  readonly requestId?: string;
  /** Original thrown value for internal debugging only — never serialize
   *  this into an HTTP/socket response. */
  readonly cause?: unknown;
  /** Only for STREAM_ERROR: the upstream flagged that a human-support
   *  handoff is appropriate (`human_support_fallback: true`). */
  readonly humanSupportFallback?: boolean;

  constructor(
    code: WaseetAiErrorCode,
    message: string,
    extra: { status?: number; requestId?: string; cause?: unknown; humanSupportFallback?: boolean } = {},
  ) {
    super(message);
    this.name = 'WaseetAiError';
    this.code = code;
    this.status = extra.status;
    this.requestId = extra.requestId;
    this.cause = extra.cause;
    this.humanSupportFallback = extra.humanSupportFallback;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export function errorFromHttpStatus(status: number, requestId?: string): WaseetAiError {
  const extra = { status, requestId };
  if (status === 400 || status === 422) return new WaseetAiError(WaseetAiErrorCode.BAD_REQUEST, 'WaseetAI rejected the request payload', extra);
  if (status === 401 || status === 403) return new WaseetAiError(WaseetAiErrorCode.AUTHENTICATION_ERROR, 'WaseetAI authentication failed', extra);
  if (status === 404) return new WaseetAiError(WaseetAiErrorCode.NOT_FOUND, 'WaseetAI endpoint or resource not found', extra);
  if (status === 408) return new WaseetAiError(WaseetAiErrorCode.TIMEOUT, 'WaseetAI request timed out', extra);
  if (status === 429) return new WaseetAiError(WaseetAiErrorCode.RATE_LIMITED, 'WaseetAI rate limit exceeded', extra);
  if (status >= 500) return new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, 'WaseetAI service is currently unavailable', extra);
  return new WaseetAiError(WaseetAiErrorCode.UNKNOWN_PROVIDER_ERROR, 'Unexpected WaseetAI response status', extra);
}

const isAbortError = (error: unknown): boolean =>
  !!error && typeof error === 'object' && ((error as { name?: unknown }).name === 'AbortError' || (error as { name?: unknown }).name === 'TimeoutError');

/** Converts any thrown value into a WaseetAiError. Never throws itself. */
export function normalizeWaseetAiError(error: unknown, requestId?: string): WaseetAiError {
  if (error instanceof WaseetAiError) return error;
  if (isAbortError(error)) {
    return new WaseetAiError(WaseetAiErrorCode.TIMEOUT, 'WaseetAI request timed out or was cancelled', { requestId, cause: error });
  }
  if (error instanceof TypeError) {
    // undici/fetch surfaces DNS/connection failures as TypeError("fetch failed").
    return new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, 'WaseetAI service is unreachable', { requestId, cause: error });
  }
  return new WaseetAiError(WaseetAiErrorCode.UNKNOWN_PROVIDER_ERROR, 'Unexpected WaseetAI client error', { requestId, cause: error });
}
