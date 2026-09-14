import { aiExecutionService } from './ai-execution.service';
import { createAiEngineError } from './ai-engine.errors';
import {
  AiCapability,
  AiExecutionMetadata,
  AiExecutionResult,
  AiProvider,
} from './ai-engine.types';
import {
  AiPromptContent,
  AiPromptLocale,
  AiRenderedPrompt,
} from './prompt-registry.types';
import { aiPromptRegistry } from './prompt-registry';
import { aiSchemaRegistry } from './schema-registry';
import { AiSchemaDefinition } from './schema-registry.types';
import { aiCapabilityRegistry } from './capability-registry';
import { AiCapabilityRegistration } from './capability-registry.types';
import { validateAiResponse } from './ai-response-validator';

export interface AiStructuredExecutionRequest<TInput = unknown> {
  capability: AiCapability;
  operation: string;
  input: TInput;
  locale?: AiPromptLocale;
}

export type AiStructuredExecutionResult<TData> = AiExecutionResult<TData>;

interface AiStructuredRawResponseEvent {
  executionId: string;
  provider: AiProvider;
  capability: AiCapability;
  operation: string;
  promptId: string;
  promptVersion: string;
  schemaId: string;
  schemaVersion: string;
  rawContent: string;
  rawResponse: unknown;
  metadata?: AiExecutionMetadata;
}

interface AiStructuredExecutionInternalOptions {
  onRawResponse?: (
    event: AiStructuredRawResponseEvent
  ) => void | Promise<void>;
}

const textContentFromPrompt = (
  content: AiPromptContent,
  provider: AiProvider
): string => {
  if (typeof content === 'string') return content;

  const textParts: string[] = [];

  for (const part of content) {
    if (part.type === 'image') {
      throw createAiEngineError(
        provider,
        'AI_CONFIG_INVALID',
        'Structured AI execution supports text prompt parts only on Day 2.'
      );
    }

    textParts.push(part.text);
  }

  return textParts.join('\n');
};

export class StructuredAiExecutionService {
  async execute<TInput, TData>(
    request: AiStructuredExecutionRequest<TInput>
  ): Promise<AiStructuredExecutionResult<TData>> {
    return this.executeWithInternalHooks<TInput, TData>(request);
  }

  protected async executeWithInternalHooks<TInput, TData>(
    request: AiStructuredExecutionRequest<TInput>,
    internalOptions: AiStructuredExecutionInternalOptions = {}
  ): Promise<AiStructuredExecutionResult<TData>> {
    const registration = aiCapabilityRegistry.get(
      request.capability,
      request.operation
    );

    return aiExecutionService.execute<TData>({
      capability: registration.capability,
      operation: registration.operation,
      purpose: registration.purpose,
      timeoutMs: registration.timeoutMs,
      retryPolicy: registration.retryPolicy,
      execute: async context => {
        const renderedPrompt = aiPromptRegistry.render<TInput>(
          registration.promptId,
          registration.promptVersion,
          request.input,
          { locale: request.locale }
        );
        const schema = aiSchemaRegistry.get<TData>(
          registration.schemaId,
          registration.schemaVersion
        );

        this.assertRegistrationMatchesRenderedPrompt(registration, renderedPrompt);

        const rawResponse = await context.client.chat.completions.create({
          model: context.model,
          messages: [
            { role: 'system', content: renderedPrompt.system },
            {
              role: 'user',
              content: textContentFromPrompt(renderedPrompt.user, context.provider),
            },
          ],
          response_format: { type: 'json_object' },
          ...(registration.temperature !== undefined && {
            temperature: registration.temperature,
          }),
          ...(registration.maxTokens !== undefined && {
            max_tokens: registration.maxTokens,
          }),
        });

        const rawContent = rawResponse.choices[0]?.message?.content ?? '';

        await internalOptions.onRawResponse?.({
          executionId: context.executionId,
          provider: context.provider,
          capability: context.capability,
          operation: context.operation,
          promptId: renderedPrompt.promptId,
          promptVersion: renderedPrompt.promptVersion,
          schemaId: schema.id,
          schemaVersion: schema.version,
          rawContent,
          rawResponse,
        });

        return {
          data: validateAiResponse<TData>({
            rawContent,
            provider: context.provider,
            schema,
          }),
          rawResponse,
        };
      },
    });
  }

  private assertRegistrationMatchesRenderedPrompt(
    registration: AiCapabilityRegistration,
    renderedPrompt: AiRenderedPrompt
  ): void {
    if (
      registration.capability !== renderedPrompt.capability ||
      registration.operation !== renderedPrompt.operation
    ) {
      throw createAiEngineError(
        'openai',
        'AI_CONFIG_INVALID',
        `Capability registration ${registration.capability}:${registration.operation} references prompt ${renderedPrompt.promptId}@${renderedPrompt.promptVersion} with mismatched capability or operation.`
      );
    }
  }
}

export const structuredAiExecutionService = new StructuredAiExecutionService();
