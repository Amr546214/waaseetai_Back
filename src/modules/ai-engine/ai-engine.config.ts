import {
  AiEngineConfig,
  AiErrorCode,
  AiModelPurpose,
  AiProvider,
  AiRetryPolicy,
} from './ai-engine.types';

export const AI_PROVIDER_OPENAI: AiProvider = 'openai';

export const AI_ENGINE_MODEL_CATALOG: Record<AiModelPurpose, string> = {
  fast_text: 'gpt-4o-mini',
  standard_json: 'gpt-4o-mini',
  complex_reasoning: 'gpt-4o',
  vision_audit: 'gpt-4o-2024-08-06',
  structured_assessment: 'gpt-4o-2024-08-06',
  audio_tts: 'tts-1-hd',
};

export const AI_ENGINE_DEFAULT_TIMEOUT_MS = 30 * 1000;

export const AI_ENGINE_TIMEOUT_BY_PURPOSE_MS: Record<AiModelPurpose, number> = {
  fast_text: 15 * 1000,
  standard_json: 25 * 1000,
  complex_reasoning: 30 * 1000,
  vision_audit: 60 * 1000,
  structured_assessment: 60 * 1000,
  audio_tts: 30 * 1000,
};

export const AI_ENGINE_RETRY_POLICY: AiRetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 250,
  maxDelayMs: 1500,
  retryableErrorCodes: [
    'AI_PROVIDER_TIMEOUT',
    'AI_PROVIDER_RATE_LIMITED',
    'AI_PROVIDER_UNAVAILABLE',
  ],
};

const DUMMY_OPENAI_API_KEYS = new Set([
  'dummy_key',
  'dummy_key_for_build',
  'replace_me',
  'sk-proj-insert_openai_api_key_here',
  'insert_openai_api_key_here',
]);

export const isConfiguredOpenAiKey = (apiKey: string | undefined): apiKey is string => {
  if (!apiKey || apiKey.trim() === '') return false;

  return !DUMMY_OPENAI_API_KEYS.has(apiKey.trim().toLowerCase());
};

export const validateAiEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): Pick<AiEngineConfig, 'apiKey' | 'isAvailable' | 'unavailableReason'> => {
  const apiKey = env.OPENAI_API_KEY?.trim();

  if (!isConfiguredOpenAiKey(apiKey)) {
    return {
      isAvailable: false,
      unavailableReason: 'AI_CONFIG_MISSING',
    };
  }

  return {
    apiKey,
    isAvailable: true,
  };
};
export const getAiEngineConfig = (
  env: NodeJS.ProcessEnv = process.env
): AiEngineConfig => {
  const environment = validateAiEnvironment(env);
  const invalidModelPurpose = Object.entries(AI_ENGINE_MODEL_CATALOG).find(
    ([, model]) => model.trim() === ''
  )?.[0] as AiModelPurpose | undefined;

  if (invalidModelPurpose) {
    return {
      provider: AI_PROVIDER_OPENAI,
      ...environment,
      isAvailable: false,
      unavailableReason: 'AI_CONFIG_INVALID' satisfies AiErrorCode,
      defaultTimeoutMs: AI_ENGINE_DEFAULT_TIMEOUT_MS,
      timeoutByPurposeMs: AI_ENGINE_TIMEOUT_BY_PURPOSE_MS,
      retryPolicy: AI_ENGINE_RETRY_POLICY,
      modelCatalog: AI_ENGINE_MODEL_CATALOG,
    };
  }

  return {
    provider: AI_PROVIDER_OPENAI,
    ...environment,
    defaultTimeoutMs: AI_ENGINE_DEFAULT_TIMEOUT_MS,
    timeoutByPurposeMs: AI_ENGINE_TIMEOUT_BY_PURPOSE_MS,
    retryPolicy: AI_ENGINE_RETRY_POLICY,
    modelCatalog: AI_ENGINE_MODEL_CATALOG,
  };
};
