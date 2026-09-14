import { AI_PROVIDER_OPENAI } from './ai-engine.config';
import { createAiEngineError } from './ai-engine.errors';
import {
  AiPromptDefinition,
  AiPromptId,
  AiPromptLocale,
  AiPromptRegistry,
  AiPromptVersion,
  AiRenderedPrompt,
} from './prompt-registry.types';

const getPromptKey = (id: AiPromptId, version: AiPromptVersion): string => {
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

const assertSupportedLocale = (
  locale: AiPromptLocale,
  supportedLocales: AiPromptLocale[],
  promptKey: string
): void => {
  if (!supportedLocales.includes(locale)) {
    throw createAiEngineError(
      AI_PROVIDER_OPENAI,
      'AI_CONFIG_INVALID',
      `Prompt ${promptKey} does not support locale ${locale}.`
    );
  }
};

export class InMemoryAiPromptRegistry implements AiPromptRegistry {
  private readonly prompts = new Map<string, AiPromptDefinition<unknown>>();

  register<TInput>(definition: AiPromptDefinition<TInput>): void {
    assertNonEmpty(definition.id, 'prompt id');
    assertNonEmpty(definition.version, 'prompt version');
    assertNonEmpty(definition.operation, 'prompt operation');

    const promptKey = getPromptKey(definition.id, definition.version);

    if (this.prompts.has(promptKey)) {
      throw createAiEngineError(
        AI_PROVIDER_OPENAI,
        'AI_CONFIG_INVALID',
        `Prompt registration already exists for ${promptKey}.`
      );
    }

    if (definition.supportedLocales.length === 0) {
      throw createAiEngineError(
        AI_PROVIDER_OPENAI,
        'AI_CONFIG_INVALID',
        `Prompt ${promptKey} must support at least one locale.`
      );
    }

    assertSupportedLocale(
      definition.defaultLocale,
      definition.supportedLocales,
      promptKey
    );

    this.prompts.set(promptKey, definition as AiPromptDefinition<unknown>);
  }

  get<TInput>(id: AiPromptId, version: AiPromptVersion): AiPromptDefinition<TInput> {
    assertNonEmpty(id, 'prompt id');
    assertNonEmpty(version, 'prompt version');

    const promptKey = getPromptKey(id, version);
    const definition = this.prompts.get(promptKey);

    if (!definition) {
      throw createAiEngineError(
        AI_PROVIDER_OPENAI,
        'AI_CONFIG_INVALID',
        `Prompt registration was not found for ${promptKey}.`
      );
    }

    return definition as AiPromptDefinition<TInput>;
  }

  render<TInput>(
    id: AiPromptId,
    version: AiPromptVersion,
    input: TInput,
    options: { locale?: AiPromptLocale } = {}
  ): AiRenderedPrompt {
    const definition = this.get<TInput>(id, version);
    const promptKey = getPromptKey(id, version);
    const locale = options.locale ?? definition.defaultLocale;

    assertSupportedLocale(locale, definition.supportedLocales, promptKey);

    return {
      promptId: definition.id,
      promptVersion: definition.version,
      capability: definition.capability,
      operation: definition.operation,
      locale,
      system: definition.buildSystemPrompt(input, { locale }),
      user: definition.buildUserPrompt(input, { locale }),
    };
  }
}

export const aiPromptRegistry = new InMemoryAiPromptRegistry();
