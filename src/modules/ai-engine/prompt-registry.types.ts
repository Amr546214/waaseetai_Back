import { AiCapability } from './ai-engine.types';

export type AiPromptId = string;
export type AiPromptVersion = string;
export type AiPromptLocale = 'ar' | 'en' | 'ar-en';

export type AiPromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; detail?: 'low' | 'high' | 'auto' };

export type AiPromptContent = string | AiPromptPart[];

export interface AiPromptRenderContext {
  locale: AiPromptLocale;
}

export interface AiRenderedPrompt {
  promptId: AiPromptId;
  promptVersion: AiPromptVersion;
  capability: AiCapability;
  operation: string;
  locale: AiPromptLocale;
  system: string;
  user: AiPromptContent;
}

export interface AiPromptDefinition<TInput = unknown> {
  id: AiPromptId;
  version: AiPromptVersion;
  capability: AiCapability;
  operation: string;
  defaultLocale: AiPromptLocale;
  supportedLocales: AiPromptLocale[];
  buildSystemPrompt: (input: TInput, context: AiPromptRenderContext) => string;
  buildUserPrompt: (input: TInput, context: AiPromptRenderContext) => AiPromptContent;
}

export interface AiPromptRegistry {
  register<TInput>(definition: AiPromptDefinition<TInput>): void;
  get<TInput>(id: AiPromptId, version: AiPromptVersion): AiPromptDefinition<TInput>;
  render<TInput>(
    id: AiPromptId,
    version: AiPromptVersion,
    input: TInput,
    options?: { locale?: AiPromptLocale }
  ): AiRenderedPrompt;
}
