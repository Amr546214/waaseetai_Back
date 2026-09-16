import { randomUUID } from 'crypto';
import { logger } from '../../config/logger';
import { getAiEngineConfig } from './ai-engine.config';
import {
  createAiEngineError,
  normalizeAiError,
} from './ai-engine.errors';
import { resolveAiModelPolicy } from './ai-model-policy';
import { getSharedOpenAiClient } from './openai-client.provider';
import {
  AiExecutionMetadata,
  AiExecutionRequest,
  AiExecutionResult,
  AiProviderResult,
  AiResolvedModelPolicy,
  AiTokenUsage,
} from './ai-engine.types';

const nowMs = (): number => Date.now();

const sleep = (delayMs: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, delayMs));
};

const getBackoffDelayMs = (
  attempt: number,
  policy: AiResolvedModelPolicy['retryPolicy']
): number => {
  const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(exponentialDelay, policy.maxDelayMs);
};

const normalizeTokenUsage = (usage: unknown): AiTokenUsage | undefined => {
  if (!usage || typeof usage !== 'object') return undefined;

  const candidate = usage as {
    promptTokens?: unknown;
    completionTokens?: unknown;
    totalTokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };

  const promptTokens = candidate.promptTokens ?? candidate.prompt_tokens;
  const completionTokens = candidate.completionTokens ?? candidate.completion_tokens;
  const totalTokens = candidate.totalTokens ?? candidate.total_tokens;

  const normalized: AiTokenUsage = {};
  if (typeof promptTokens === 'number') normalized.promptTokens = promptTokens;
  if (typeof completionTokens === 'number') normalized.completionTokens = completionTokens;
  if (typeof totalTokens === 'number') normalized.totalTokens = totalTokens;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const extractTokenUsage = <TData>(
  result: AiProviderResult<TData>
): AiTokenUsage | undefined => {
  return result.tokenUsage ?? normalizeTokenUsage(
    typeof result.rawResponse === 'object' && result.rawResponse !== null
      ? (result.rawResponse as { usage?: unknown }).usage
      : undefined
  );
};

const withTimeout = async <TData>(
  run: (signal: AbortSignal) => Promise<TData>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<TData> => {
  const abortController = new AbortController();
  const timeoutError = new Error(timeoutMessage);
  timeoutError.name = 'AiProviderTimeoutError';
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => run(abortController.signal)),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

const createMetadata = (
  executionId: string,
  policy: AiResolvedModelPolicy,
  startedAtMs: number,
  success: boolean,
  attempts: number,
  tokenUsage?: AiTokenUsage
): AiExecutionMetadata => {
  return {
    executionId,
    provider: 'openai',
    capability: policy.capability,
    operation: policy.operation,
    model: policy.model,
    latencyMs: nowMs() - startedAtMs,
    success,
    attempts,
    ...(tokenUsage && { tokenUsage }),
  };
};

export class AiExecutionService {
  async execute<TData>(
    request: AiExecutionRequest<TData>
  ): Promise<AiExecutionResult<TData>> {
    const executionId = randomUUID();
    const startedAtMs = nowMs();
    const policy = resolveAiModelPolicy(request);
    const config = getAiEngineConfig();

    if (!config.isAvailable || !config.apiKey) {
      const error = createAiEngineError(
        config.provider,
        config.unavailableReason ?? 'AI_CONFIG_MISSING',
        'OPENAI_API_KEY is not configured. AI execution was not attempted.'
      );

      return {
        success: false,
        error: error.toPayload(),
        metadata: createMetadata(executionId, policy, startedAtMs, false, 0),
      };
    }

    const openai = getSharedOpenAiClient(config);
    if (!openai) {
      const error = createAiEngineError(
        config.provider,
        'AI_CONFIG_MISSING',
        'OpenAI client is unavailable. AI execution was not attempted.'
      );

      return {
        success: false,
        error: error.toPayload(),
        metadata: createMetadata(executionId, policy, startedAtMs, false, 0),
      };
    }

    let attempts = 0;
    let lastError = createAiEngineError(
      config.provider,
      'AI_UNKNOWN_ERROR',
      'AI execution did not complete.'
    );

    for (let attempt = 1; attempt <= policy.retryPolicy.maxAttempts; attempt += 1) {
      attempts = attempt;

      try {
        const providerResult = await withTimeout(
          signal =>
            request.execute({
              executionId,
              provider: config.provider,
              client: openai,
              signal,
              capability: policy.capability,
              operation: policy.operation,
              purpose: policy.purpose,
              model: policy.model,
              timeoutMs: policy.timeoutMs,
              attempt,
            }),
          policy.timeoutMs,
          `AI provider timed out after ${policy.timeoutMs}ms`
        );

        const tokenUsage = extractTokenUsage(providerResult);

        return {
          success: true,
          data: providerResult.data,
          metadata: createMetadata(
            executionId,
            policy,
            startedAtMs,
            true,
            attempts,
            tokenUsage
          ),
        };
      } catch (error) {
        lastError = normalizeAiError(error, config.provider);

        const canRetry =
          attempt < policy.retryPolicy.maxAttempts &&
          lastError.retryable &&
          policy.retryPolicy.retryableErrorCodes.includes(lastError.code);

        logger.warn(
          `[AiExecutionService] executionId=${executionId} operation=${policy.operation} attempt=${attempt} failed code=${lastError.code} retryable=${canRetry}`
        );

        if (!canRetry) break;

        await sleep(getBackoffDelayMs(attempt, policy.retryPolicy));
      }
    }

    return {
      success: false,
      error: lastError.toPayload(),
      metadata: createMetadata(executionId, policy, startedAtMs, false, attempts),
    };
  }
}

export const aiExecutionService = new AiExecutionService();
