import {
  AiCapability,
  AiErrorCode,
  AiModelPurpose,
  AiProvider,
  AiTokenUsage,
} from './ai-engine.types';
import {
  AiExecutionFallbackType,
  AiFailurePolicy,
} from './ai-failure-policy.types';
import {
  AiPromptId,
  AiPromptVersion,
} from './prompt-registry.types';
import {
  AiSchemaId,
  AiSchemaVersion,
} from './schema-registry.types';

export interface AiAuditEntityRef {
  type: string;
  id: string;
}

export interface AiExecutionAuditContext {
  actorUserId?: string;
  primaryEntity?: AiAuditEntityRef;
  relatedEntities?: AiAuditEntityRef[];
}

export interface AiExecutionAuditEvent {
  executionId: string;
  capability: AiCapability;
  operation: string;
  provider: AiProvider;
  model: string;
  modelPurpose: AiModelPurpose;
  promptId?: AiPromptId;
  promptVersion?: AiPromptVersion;
  schemaId?: AiSchemaId;
  schemaVersion?: AiSchemaVersion;
  success: boolean;
  attempts: number;
  latencyMs: number;
  tokenUsage?: AiTokenUsage;
  errorCode?: AiErrorCode;
  providerStatusCode?: number;
  failurePolicy?: AiFailurePolicy;
  fallbackType?: AiExecutionFallbackType;
  auditContext?: AiExecutionAuditContext;
  redactionVersion: string;
}

export interface AiExecutionAuditSink {
  record(event: AiExecutionAuditEvent): Promise<void>;
}
