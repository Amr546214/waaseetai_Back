import {
  AiEngineErrorPayload,
  AiErrorCode,
  AiProvider,
} from './ai-engine.types';

export class AiEngineError extends Error {
  public readonly code: AiErrorCode;
  public readonly provider: AiProvider;
  public readonly retryable: boolean;
  public readonly statusCode?: number;
  public readonly details?: unknown;
  public readonly originalError?: unknown;

  constructor(payload: AiEngineErrorPayload, originalError?: unknown) {
    super(payload.message);
    this.name = 'AiEngineError';
    this.code = payload.code;
    this.provider = payload.provider;
    this.retryable = payload.retryable;
    this.statusCode = payload.statusCode;
    this.details = payload.details;
    this.originalError = originalError;

    Error.captureStackTrace(this, this.constructor);
  }

  toPayload(): AiEngineErrorPayload {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      retryable: this.retryable,
      ...(this.statusCode !== undefined && { statusCode: this.statusCode }),
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}

export const isAiEngineError = (error: unknown): error is AiEngineError => {
  return error instanceof AiEngineError;
};

const getErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  return typeof status === 'number' ? status : undefined;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown AI provider error';
};

const getErrorNameOrCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return '';
  const candidate = error as { name?: unknown; code?: unknown; type?: unknown };
  return [candidate.name, candidate.code, candidate.type]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
};

export const createAiEngineError = (
  provider: AiProvider,
  code: AiErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    statusCode?: number;
    details?: unknown;
    originalError?: unknown;
  } = {}
): AiEngineError => {
  return new AiEngineError(
    {
      code,
      message,
      provider,
      retryable: options.retryable ?? false,
      ...(options.statusCode !== undefined && { statusCode: options.statusCode }),
      ...(options.details !== undefined && { details: options.details }),
    },
    options.originalError
  );
};

export const normalizeAiError = (
  error: unknown,
  provider: AiProvider
): AiEngineError => {
  if (isAiEngineError(error)) return error;

  const statusCode = getErrorStatus(error);
  const errorNameOrCode = getErrorNameOrCode(error);
  const message = getErrorMessage(error);

  if (
    statusCode === 408 ||
    statusCode === 504 ||
    errorNameOrCode.includes('timeout') ||
    errorNameOrCode.includes('aborted') ||
    errorNameOrCode.includes('etimedout')
  ) {
    return createAiEngineError(provider, 'AI_PROVIDER_TIMEOUT', message, {
      retryable: true,
      statusCode,
      originalError: error,
    });
  }

  if (statusCode === 401 || statusCode === 403) {
    return createAiEngineError(provider, 'AI_PROVIDER_AUTHENTICATION', message, {
      statusCode,
      originalError: error,
    });
  }

  if (statusCode === 429) {
    return createAiEngineError(provider, 'AI_PROVIDER_RATE_LIMITED', message, {
      retryable: true,
      statusCode,
      originalError: error,
    });
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return createAiEngineError(provider, 'AI_PROVIDER_UNAVAILABLE', message, {
      retryable: true,
      statusCode,
      originalError: error,
    });
  }

  if (error instanceof SyntaxError) {
    return createAiEngineError(provider, 'AI_PROVIDER_BAD_RESPONSE', message, {
      originalError: error,
    });
  }

  return createAiEngineError(provider, 'AI_UNKNOWN_ERROR', message, {
    originalError: error,
  });
};
