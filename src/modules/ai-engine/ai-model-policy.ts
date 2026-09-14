import {
  AI_ENGINE_MODEL_CATALOG,
  AI_ENGINE_RETRY_POLICY,
  AI_ENGINE_TIMEOUT_BY_PURPOSE_MS,
} from './ai-engine.config';
import {
  AiCapability,
  AiModelPolicyInput,
  AiModelPurpose,
  AiResolvedModelPolicy,
  AiRetryPolicy,
} from './ai-engine.types';

const DEFAULT_PURPOSE_BY_CAPABILITY: Record<AiCapability, AiModelPurpose> = {
  project_intelligence: 'complex_reasoning',
  matching: 'standard_json',
  proposals: 'standard_json',
  project_operations: 'complex_reasoning',
  amendments: 'complex_reasoning',
  finance: 'complex_reasoning',
  disputes: 'complex_reasoning',
  profile_intelligence: 'standard_json',
  provider_qualification: 'structured_assessment',
  assistant: 'fast_text',
};

const OPERATION_PURPOSE_OVERRIDES: Partial<
  Record<AiCapability, Record<string, AiModelPurpose>>
> = {};

const mergeRetryPolicy = (override?: Partial<AiRetryPolicy>): AiRetryPolicy => {
  return {
    ...AI_ENGINE_RETRY_POLICY,
    ...override,
    retryableErrorCodes:
      override?.retryableErrorCodes ?? AI_ENGINE_RETRY_POLICY.retryableErrorCodes,
  };
};

export const resolveAiModelPurpose = (
  capability: AiCapability,
  operation: string,
  explicitPurpose?: AiModelPurpose
): AiModelPurpose => {
  if (explicitPurpose) return explicitPurpose;

  return (
    OPERATION_PURPOSE_OVERRIDES[capability]?.[operation] ??
    DEFAULT_PURPOSE_BY_CAPABILITY[capability]
  );
};

export const resolveAiModelPolicy = (
  input: AiModelPolicyInput
): AiResolvedModelPolicy => {
  const purpose = resolveAiModelPurpose(
    input.capability,
    input.operation,
    input.purpose
  );

  return {
    capability: input.capability,
    operation: input.operation,
    purpose,
    model: AI_ENGINE_MODEL_CATALOG[purpose],
    timeoutMs: input.timeoutMs ?? AI_ENGINE_TIMEOUT_BY_PURPOSE_MS[purpose],
    retryPolicy: mergeRetryPolicy(input.retryPolicy),
  };
};
