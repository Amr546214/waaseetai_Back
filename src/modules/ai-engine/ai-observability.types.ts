import {
  AiCapability,
  AiErrorCode,
  AiExecutionMetadata,
  AiModelPurpose,
  AiProvider,
  AiTokenUsage,
} from './ai-engine.types';
import {
  AiExecutionFallbackType,
  AiFailurePolicy,
} from './ai-failure-policy.types';

export interface AiExecutionObservation {
  metadata: AiExecutionMetadata;
  modelPurpose: AiModelPurpose;
  promptId?: string;
  promptVersion?: string;
  schemaId?: string;
  schemaVersion?: string;
  failurePolicy?: AiFailurePolicy;
  fallbackType?: AiExecutionFallbackType;
  errorCode?: AiErrorCode;
  providerStatusCode?: number;
}

export interface AiTokenUsageObservation {
  provider: AiProvider;
  model: string;
  modelPurpose: AiModelPurpose;
  capability: AiCapability;
  operation: string;
  tokenUsage?: AiTokenUsage;
}
