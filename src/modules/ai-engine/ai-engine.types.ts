import type OpenAI from 'openai';

export type AiProvider = 'openai';

export type AiCapability =
  | 'project_intelligence'
  | 'matching'
  | 'proposals'
  | 'project_operations'
  | 'amendments'
  | 'finance'
  | 'disputes'
  | 'profile_intelligence'
  | 'provider_qualification'
  | 'assistant';

export type AiModelPurpose =
  | 'fast_text'
  | 'standard_json'
  | 'complex_reasoning'
  | 'vision_audit'
  | 'structured_assessment'
  | 'audio_tts';

export type AiErrorCode =
  | 'AI_CONFIG_MISSING'
  | 'AI_CONFIG_INVALID'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_PROVIDER_AUTHENTICATION'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_PROVIDER_BAD_RESPONSE'
  | 'AI_RESPONSE_VALIDATION_FAILED'
  | 'AI_UNKNOWN_ERROR';

export interface AiTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrorCodes: AiErrorCode[];
}

export interface AiEngineConfig {
  provider: AiProvider;
  apiKey?: string;
  isAvailable: boolean;
  unavailableReason?: AiErrorCode;
  defaultTimeoutMs: number;
  timeoutByPurposeMs: Record<AiModelPurpose, number>;
  retryPolicy: AiRetryPolicy;
  modelCatalog: Record<AiModelPurpose, string>;
}

export interface AiModelPolicyInput {
  capability: AiCapability;
  operation: string;
  purpose?: AiModelPurpose;
  timeoutMs?: number;
  retryPolicy?: Partial<AiRetryPolicy>;
}

export interface AiResolvedModelPolicy {
  capability: AiCapability;
  operation: string;
  purpose: AiModelPurpose;
  model: string;
  timeoutMs: number;
  retryPolicy: AiRetryPolicy;
}

export interface AiExecutionMetadata {
  executionId: string;
  provider: AiProvider;
  capability: AiCapability;
  operation: string;
  model: string;
  latencyMs: number;
  success: boolean;
  attempts: number;
  tokenUsage?: AiTokenUsage;
}

export interface AiEngineErrorPayload {
  code: AiErrorCode;
  message: string;
  provider: AiProvider;
  retryable: boolean;
  statusCode?: number;
  details?: unknown;
}

export interface AiProviderExecutionContext {
  executionId: string;
  provider: AiProvider;
  client: OpenAI;
  capability: AiCapability;
  operation: string;
  purpose: AiModelPurpose;
  model: string;
  timeoutMs: number;
  attempt: number;
}

export interface AiProviderResult<TData> {
  data: TData;
  rawResponse?: unknown;
  tokenUsage?: AiTokenUsage;
}

export interface AiExecutionRequest<TData> extends AiModelPolicyInput {
  execute: (context: AiProviderExecutionContext) => Promise<AiProviderResult<TData>>;
}

export interface AiExecutionSuccess<TData> {
  success: true;
  data: TData;
  metadata: AiExecutionMetadata;
}

export interface AiExecutionFailure {
  success: false;
  error: AiEngineErrorPayload;
  metadata: AiExecutionMetadata;
}

export type AiExecutionResult<TData> = AiExecutionSuccess<TData> | AiExecutionFailure;
