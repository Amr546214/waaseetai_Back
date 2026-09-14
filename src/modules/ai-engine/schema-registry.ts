import { AI_PROVIDER_OPENAI } from './ai-engine.config';
import { createAiEngineError } from './ai-engine.errors';
import {
  AiSchemaDefinition,
  AiSchemaId,
  AiSchemaRegistry,
  AiSchemaVersion,
} from './schema-registry.types';

const getSchemaKey = (id: AiSchemaId, version: AiSchemaVersion): string => {
  return `${id}@${version}`;
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

export class InMemoryAiSchemaRegistry implements AiSchemaRegistry {
  private readonly schemas = new Map<string, AiSchemaDefinition<unknown>>();

  register<TData>(definition: AiSchemaDefinition<TData>): void {
    assertNonEmpty(definition.id, 'schema id');
    assertNonEmpty(definition.version, 'schema version');

    const schemaKey = getSchemaKey(definition.id, definition.version);

    if (this.schemas.has(schemaKey)) {
      throw createAiEngineError(
        AI_PROVIDER_OPENAI,
        'AI_CONFIG_INVALID',
        `Schema registration already exists for ${schemaKey}.`
      );
    }

    this.schemas.set(schemaKey, definition as AiSchemaDefinition<unknown>);
  }

  get<TData>(id: AiSchemaId, version: AiSchemaVersion): AiSchemaDefinition<TData> {
    assertNonEmpty(id, 'schema id');
    assertNonEmpty(version, 'schema version');

    const schemaKey = getSchemaKey(id, version);
    const definition = this.schemas.get(schemaKey);

    if (!definition) {
      throw createAiEngineError(
        AI_PROVIDER_OPENAI,
        'AI_CONFIG_INVALID',
        `Schema registration was not found for ${schemaKey}.`
      );
    }

    return definition as AiSchemaDefinition<TData>;
  }
}

export const aiSchemaRegistry = new InMemoryAiSchemaRegistry();
