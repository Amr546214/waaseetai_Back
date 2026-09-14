import { AiProvider } from './ai-engine.types';
import { createAiEngineError } from './ai-engine.errors';
import { AiSchemaDefinition } from './schema-registry.types';

const JSON_FENCE_PATTERN = /^```json[ \t]*\r?\n([\s\S]*)\r?\n```[ \t]*$/i;

export interface AiResponseValidationInput<TData> {
  rawContent: string;
  provider: AiProvider;
  schema: AiSchemaDefinition<TData>;
}

const unwrapCompleteJsonFence = (rawContent: string): string => {
  const trimmed = rawContent.trim();
  const match = JSON_FENCE_PATTERN.exec(trimmed);
  return match ? match[1].trim() : trimmed;
};

const sanitizeZodIssues = (
  issues: Array<{ path: PropertyKey[]; code: string; message: string }>
): Array<{ path: string; code: string; message: string }> => {
  return issues.map(issue => ({
    path: issue.path.map(part => String(part)).join('.'),
    code: issue.code,
    message: issue.message,
  }));
};

export const parseAiJsonResponse = (
  rawContent: string,
  provider: AiProvider,
  schema: Pick<AiSchemaDefinition, 'id' | 'version'>
): unknown => {
  const jsonText = unwrapCompleteJsonFence(rawContent);

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw createAiEngineError(
      provider,
      'AI_RESPONSE_VALIDATION_FAILED',
      'AI response was not valid JSON.',
      {
        details: {
          schemaId: schema.id,
          schemaVersion: schema.version,
          reason: 'JSON_PARSE_FAILED',
        },
        originalError: error,
      }
    );
  }
};

export const validateAiResponse = <TData>(
  input: AiResponseValidationInput<TData>
): TData => {
  const parsed = parseAiJsonResponse(input.rawContent, input.provider, input.schema);
  const result = input.schema.schema.safeParse(parsed);

  if (!result.success) {
    throw createAiEngineError(
      input.provider,
      'AI_RESPONSE_VALIDATION_FAILED',
      'AI response failed schema validation.',
      {
        details: {
          schemaId: input.schema.id,
          schemaVersion: input.schema.version,
          reason: 'ZOD_VALIDATION_FAILED',
          issues: sanitizeZodIssues(result.error.issues),
        },
        originalError: result.error,
      }
    );
  }

  return result.data;
};
