import { z } from 'zod';

export type AiSchemaId = string;
export type AiSchemaVersion = string;

export interface AiSchemaDefinition<TData = unknown> {
  id: AiSchemaId;
  version: AiSchemaVersion;
  schema: z.ZodType<TData>;
  description?: string;
}

export interface AiSchemaRegistry {
  register<TData>(definition: AiSchemaDefinition<TData>): void;
  get<TData>(id: AiSchemaId, version: AiSchemaVersion): AiSchemaDefinition<TData>;
}
