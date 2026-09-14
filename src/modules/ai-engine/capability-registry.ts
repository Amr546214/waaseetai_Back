import { AI_PROVIDER_OPENAI } from './ai-engine.config';
import { createAiEngineError } from './ai-engine.errors';
import { AiCapability } from './ai-engine.types';
import {
  AiCapabilityRegistration,
  AiCapabilityRegistry,
} from './capability-registry.types';
import { isAiFailurePolicy } from './ai-failure-policy.types';

const getCapabilityKey = (capability: AiCapability, operation: string): string => {
  return `${capability}:${operation}`;
};

const assertNonEmpty = (value: string, fieldName: string): void => {
  if (value.trim() === '') {
    throw createAiEngineError(
      AI_PROVIDER_OPENAI,
      'AI_CONFIG_INVALID',
      `${fieldName} must be a non-empty string.`
    );
  }
};

const assertPositiveInteger = (
  value: number | undefined,
  fieldName: string
): void => {
  if (value === undefined) return;

  if (!Number.isInteger(value) || value <= 0) {
    throw createAiEngineError(
      AI_PROVIDER_OPENAI,
      'AI_CONFIG_INVALID',
      `${fieldName} must be a positive integer.`
    );
  }
};

export class InMemoryAiCapabilityRegistry implements AiCapabilityRegistry {
  private readonly registrations = new Map<string, AiCapabilityRegistration>();

  register(registration: AiCapabilityRegistration): void {
    assertNonEmpty(registration.operation, 'capability operation');
    assertNonEmpty(registration.promptId, 'prompt id');
    assertNonEmpty(registration.promptVersion, 'prompt version');
    assertNonEmpty(registration.schemaId, 'schema id');
    assertNonEmpty(registration.schemaVersion, 'schema version');
    assertNonEmpty(registration.failurePolicy, 'failure policy');
    assertPositiveInteger(registration.timeoutMs, 'timeoutMs');
    assertPositiveInteger(registration.maxTokens, 'maxTokens');

    if (!isAiFailurePolicy(registration.failurePolicy)) {
      throw createAiEngineError(
        AI_PROVIDER_OPENAI,
        'AI_CONFIG_INVALID',
        `Invalid failure policy ${String(registration.failurePolicy)}.`
      );
    }

    const capabilityKey = getCapabilityKey(
      registration.capability,
      registration.operation
    );

    if (this.registrations.has(capabilityKey)) {
      throw createAiEngineError(
        AI_PROVIDER_OPENAI,
        'AI_CONFIG_INVALID',
        `Capability registration already exists for ${capabilityKey}.`
      );
    }

    this.registrations.set(capabilityKey, { ...registration });
  }

  get(capability: AiCapability, operation: string): AiCapabilityRegistration {
    assertNonEmpty(operation, 'capability operation');

    const capabilityKey = getCapabilityKey(capability, operation);
    const registration = this.registrations.get(capabilityKey);

    if (!registration) {
      throw createAiEngineError(
        AI_PROVIDER_OPENAI,
        'AI_CONFIG_INVALID',
        `Capability registration was not found for ${capabilityKey}.`
      );
    }

    return { ...registration };
  }
}

export const aiCapabilityRegistry = new InMemoryAiCapabilityRegistry();
