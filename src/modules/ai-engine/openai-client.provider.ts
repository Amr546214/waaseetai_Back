import OpenAI from 'openai';
import { getAiEngineConfig } from './ai-engine.config';
import { AiEngineConfig } from './ai-engine.types';

let sharedOpenAiClient: OpenAI | null = null;
let sharedOpenAiApiKey: string | null = null;

export const getSharedOpenAiClient = (
  config: AiEngineConfig = getAiEngineConfig()
): OpenAI | null => {
  if (!config.isAvailable || !config.apiKey) return null;

  if (sharedOpenAiClient && sharedOpenAiApiKey === config.apiKey) {
    return sharedOpenAiClient;
  }

  sharedOpenAiClient = new OpenAI({
    apiKey: config.apiKey,
    maxRetries: 0,
  });
  sharedOpenAiApiKey = config.apiKey;

  return sharedOpenAiClient;
};
