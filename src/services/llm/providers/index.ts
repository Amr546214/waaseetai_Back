import type { LlmConfig } from '../llm.config';
import { GeminiProvider } from './gemini.provider';
import type { LlmProvider } from './llm-provider';

/** Add a new provider here (and to SUPPORTED_LLM_PROVIDERS). Only `gemini` is implemented. */
export function createProvider(config: LlmConfig): LlmProvider {
  switch (config.provider) {
    case 'gemini':
      return new GeminiProvider({ apiKey: config.apiKey, model: config.model });
  }
}
