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

/**
 * Finer-grained, internal-only classification layered under GeminiErrorCode.
 * Used for logging/debugging and for GeminiClient's bounded transient-retry
 * decision. It never changes which GeminiErrorCode a caller sees (feature
 * services and their HTTP/socket contracts keep switching on `.code` only),
 * and it never carries raw provider text.
 */
export type GeminiFailureDetail =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTHENTICATION'
  /** HTTP 502/503 — upstream temporarily overloaded/unavailable. Retryable. */
  | 'UPSTREAM_UNAVAILABLE'
  /** Any other HTTP 5xx (500 INTERNAL, 504 DEADLINE_EXCEEDED, …). Not retried:
   *  Google documents these as frequently caused by the request itself
   *  (e.g. an oversized context), so an identical retry is not expected to help. */
  | 'UPSTREAM_ERROR'
  /** Transient transport failure (connection reset, DNS EAI_AGAIN, socket
   *  timeout) before any HTTP status was received. Retryable. */
  | 'NETWORK'
  /** Any other HTTP 4xx — permanent request/configuration problem. Never retried. */
  | 'INVALID_REQUEST'
  | 'EMPTY_RESPONSE'
  | 'MALFORMED_JSON'
  /** finishReason=MAX_TOKENS — output cut off at maxOutputTokens. */
  | 'TRUNCATED'
  /** Any other non-STOP finishReason (SAFETY, RECITATION, OTHER, …). */
  | 'INCOMPLETE'
  | 'SCHEMA_INVALID'
  | 'UNKNOWN';

export interface GeminiProviderErrorOptions {
  detail?: GeminiFailureDetail;
  /** True only for failures GeminiClient may safely retry (bounded). */
  retryable?: boolean;
  /** Server-provided retry hint (google.rpc.RetryInfo.retryDelay), if any. */
  retryAfterMs?: number;
  httpStatus?: number;
}

export class GeminiProviderError extends Error {
  readonly code: GeminiErrorCode;
  /** The original thrown value, kept only for internal logging/debugging —
   *  callers must never serialize this into an HTTP/socket response. */
  readonly cause?: unknown;
  readonly detail: GeminiFailureDetail;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;

  constructor(code: GeminiErrorCode, message: string, cause?: unknown, options: GeminiProviderErrorOptions = {}) {
    super(message);
    this.name = 'GeminiProviderError';
    this.code = code;
    this.cause = cause;
    this.detail = options.detail ?? defaultDetailFor(code);
    this.retryable = options.retryable === true;
    this.retryAfterMs = options.retryAfterMs;
    this.httpStatus = options.httpStatus;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

function defaultDetailFor(code: GeminiErrorCode): GeminiFailureDetail {
  switch (code) {
    case GeminiErrorCode.NOT_CONFIGURED: return 'NOT_CONFIGURED';
    case GeminiErrorCode.TIMEOUT: return 'TIMEOUT';
    case GeminiErrorCode.RATE_LIMITED: return 'RATE_LIMITED';
    case GeminiErrorCode.AUTHENTICATION_ERROR: return 'AUTHENTICATION';
    case GeminiErrorCode.PROVIDER_UNAVAILABLE: return 'UPSTREAM_ERROR';
    case GeminiErrorCode.INVALID_RESPONSE: return 'SCHEMA_INVALID';
    default: return 'UNKNOWN';
  }
}

const isAbortError = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';

const extractHttpStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
};

const rawMessageOf = (error: unknown): string => {
  if (!error || typeof error !== 'object') return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
};

// Node/undici transport error codes that indicate a transient network
// failure (the request may never have reached Gemini, or the connection
// dropped). Deliberately excludes ENOTFOUND/ECONNREFUSED/certificate errors,
// which point to a persistent environment/configuration problem.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const codeOf = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  };
  const direct = codeOf(error);
  if (direct && TRANSIENT_NETWORK_CODES.has(direct)) return true;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = codeOf(cause);
  return !!causeCode && TRANSIENT_NETWORK_CODES.has(causeCode);
}

// The SDK's ApiError only exposes `status` and `message` (the JSON-stringified
// upstream error body) — no response headers, so an HTTP Retry-After header
// is not reachable. The body may however carry google.rpc.RetryInfo
// (`"retryDelay": "12s"`), which is the API's own retry guidance. Parsed
// defensively; only the number is kept, never the raw text.
const RETRY_DELAY_PATTERN = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/;

export function extractRetryAfterMs(error: unknown): number | undefined {
  const match = RETRY_DELAY_PATTERN.exec(rawMessageOf(error));
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

// Gemini returns HTTP 400 INVALID_ARGUMENT (not 401/403) with reason
// API_KEY_INVALID for a bad/revoked key. That is a configuration failure,
// not a request-shape bug, and must be classified (and never retried) as such.
const API_KEY_INVALID_PATTERN = /API_KEY_INVALID|API key not valid/i;

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
  if (status === 401 || status === 403 || (status === 400 && API_KEY_INVALID_PATTERN.test(rawMessageOf(error)))) {
    return new GeminiProviderError(GeminiErrorCode.AUTHENTICATION_ERROR, 'Gemini authentication failed', error, { httpStatus: status });
  }
  if (status === 429) {
    // Retried only by GeminiKeyPool's per-key failover (unchanged), never by
    // GeminiClient's transient-retry loop.
    return new GeminiProviderError(GeminiErrorCode.RATE_LIMITED, 'Gemini rate limit exceeded', error, { httpStatus: status });
  }
  if (status === 502 || status === 503) {
    return new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'Gemini service is currently unavailable', error, {
      detail: 'UPSTREAM_UNAVAILABLE', retryable: true, retryAfterMs: extractRetryAfterMs(error), httpStatus: status,
    });
  }
  if (typeof status === 'number' && status >= 500) {
    return new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'Gemini service is currently unavailable', error, {
      detail: 'UPSTREAM_ERROR', httpStatus: status,
    });
  }
  if (typeof status === 'number' && status >= 400) {
    return new GeminiProviderError(GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'Unexpected Gemini provider error', error, {
      detail: 'INVALID_REQUEST', httpStatus: status,
    });
  }
  if (status === undefined && isTransientNetworkError(error)) {
    return new GeminiProviderError(GeminiErrorCode.PROVIDER_UNAVAILABLE, 'Gemini service could not be reached', error, {
      detail: 'NETWORK', retryable: true,
    });
  }

  return new GeminiProviderError(GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'Unexpected Gemini provider error', error);
}
