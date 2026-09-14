import { Prisma } from '@prisma/client';
import { logger } from '../../config/logger';
import { prisma } from '../../config/db';
import {
  AiExecutionAuditEvent,
  AiExecutionAuditSink,
} from './ai-execution-audit.types';
import {
  AI_AUDIT_REDACTION_VERSION,
  sanitizeAiExecutionAuditContext,
} from './ai-audit-privacy';

export class NoopAiExecutionAuditSink implements AiExecutionAuditSink {
  async record(_event: AiExecutionAuditEvent): Promise<void> {
    return undefined;
  }
}

export class PrismaAiExecutionAuditSink implements AiExecutionAuditSink {
  async record(event: AiExecutionAuditEvent): Promise<void> {
    const auditContext = sanitizeAiExecutionAuditContext(event.auditContext);
    const relatedEntityRefs =
      auditContext?.relatedEntities && auditContext.relatedEntities.length > 0
        ? (auditContext.relatedEntities as unknown as Prisma.InputJsonValue)
        : undefined;

    await prisma.aiExecutionAuditLog.create({
      data: {
        executionId: event.executionId,
        capability: event.capability,
        operation: event.operation,
        provider: event.provider,
        model: event.model,
        modelPurpose: event.modelPurpose,
        promptId: event.promptId,
        promptVersion: event.promptVersion,
        schemaId: event.schemaId,
        schemaVersion: event.schemaVersion,
        success: event.success,
        attempts: event.attempts,
        latencyMs: event.latencyMs,
        promptTokens: event.tokenUsage?.promptTokens,
        completionTokens: event.tokenUsage?.completionTokens,
        totalTokens: event.tokenUsage?.totalTokens,
        errorCode: event.errorCode,
        providerStatusCode: event.providerStatusCode,
        failurePolicy: event.failurePolicy,
        fallbackType: event.fallbackType,
        actorUserId: auditContext?.actorUserId,
        primaryEntityType: auditContext?.primaryEntity?.type,
        primaryEntityId: auditContext?.primaryEntity?.id,
        relatedEntityRefs,
        redactionVersion: event.redactionVersion || AI_AUDIT_REDACTION_VERSION,
      },
    });
  }
}

export const logAiAuditFailure = (
  event: AiExecutionAuditEvent,
  error: unknown
): void => {
  const reason = error instanceof Error ? error.message : String(error);

  logger.warn(
    `[AiExecutionAuditSink] executionId=${event.executionId} capability=${event.capability} operation=${event.operation} audit_persistence_failed=${reason}`
  );
};
