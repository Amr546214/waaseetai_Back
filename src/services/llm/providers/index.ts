import type { LlmConfig } from '../llm.config';
import { GeminiProvider } from './gemini.provider';
import type { LlmProvider } from './llm-provider';
import { WaseetProvider } from './waseet.provider';

const providers = new Map<string, LlmProvider>();

/** Add a new provider here (and to SUPPORTED_LLM_PROVIDERS). Only `gemini` is implemented. */
export function createProvider(config: LlmConfig): LlmProvider {
  if (config.provider === 'waseet') return new WaseetProvider(config.model);
  const key = JSON.stringify([config.provider, config.model, config.apiKeys || [config.apiKey]]);
  const cached = providers.get(key);
  if (cached) return cached;
  switch (config.provider) {
    case 'gemini':
      const provider = new GeminiProvider({ apiKey: config.apiKey, apiKeys: config.apiKeys, model: config.model });
      providers.clear();
      providers.set(key, provider);
      return provider;
  }
}
