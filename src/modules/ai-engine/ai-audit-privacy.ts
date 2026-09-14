import {
  AiAuditEntityRef,
  AiExecutionAuditContext,
} from './ai-execution-audit.types';

export const AI_AUDIT_REDACTION_VERSION = 'v1';

const MAX_ACTOR_ID_LENGTH = 120;
const MAX_ENTITY_ID_LENGTH = 120;
const MAX_ENTITY_TYPE_LENGTH = 80;
const MAX_RELATED_ENTITIES = 20;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

const cleanEntityType = (value: string): string | undefined => {
  const cleaned = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, '_')
    .slice(0, MAX_ENTITY_TYPE_LENGTH);

  return cleaned || undefined;
};

const cleanSafeReferenceId = (
  value: string | undefined,
  maxLength: number
): string | undefined => {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  if (!SAFE_REFERENCE_PATTERN.test(trimmed)) return undefined;

  return trimmed;
};

const sanitizeEntityRef = (
  value: AiAuditEntityRef | undefined
): AiAuditEntityRef | undefined => {
  if (!value) return undefined;

  const type = cleanEntityType(value.type);
  const id = cleanSafeReferenceId(value.id, MAX_ENTITY_ID_LENGTH);

  if (!type || !id) return undefined;

  return { type, id };
};

export const sanitizeAiExecutionAuditContext = (
  context: AiExecutionAuditContext | undefined
): AiExecutionAuditContext | undefined => {
  if (!context) return undefined;

  const actorUserId = cleanSafeReferenceId(
    context.actorUserId,
    MAX_ACTOR_ID_LENGTH
  );
  const primaryEntity = sanitizeEntityRef(context.primaryEntity);
  const relatedEntities = (context.relatedEntities ?? [])
    .slice(0, MAX_RELATED_ENTITIES)
    .map(sanitizeEntityRef)
    .filter((value): value is AiAuditEntityRef => Boolean(value));

  const sanitized: AiExecutionAuditContext = {};
  if (actorUserId) sanitized.actorUserId = actorUserId;
  if (primaryEntity) sanitized.primaryEntity = primaryEntity;
  if (relatedEntities.length > 0) sanitized.relatedEntities = relatedEntities;

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};
