import {
  AiCapability,
  AiModelPurpose,
  AiRetryPolicy,
} from './ai-engine.types';
import {
  AiPromptId,
  AiPromptVersion,
} from './prompt-registry.types';
import {
  AiSchemaId,
  AiSchemaVersion,
} from './schema-registry.types';
import { AiFailurePolicy } from './ai-failure-policy.types';

export interface AiCapabilityRegistration {
  capability: AiCapability;
  operation: string;
  promptId: AiPromptId;
  promptVersion: AiPromptVersion;
  schemaId: AiSchemaId;
  schemaVersion: AiSchemaVersion;
  purpose: AiModelPurpose;
  failurePolicy: AiFailurePolicy;
  timeoutMs?: number;
  retryPolicy?: Partial<AiRetryPolicy>;
  temperature?: number;
  maxTokens?: number;
}

export interface AiCapabilityRegistry {
  register(registration: AiCapabilityRegistration): void;
  get(capability: AiCapability, operation: string): AiCapabilityRegistration;
}
