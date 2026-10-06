import { LlmClient } from '../llm/llm.client';
import type { LlmConfig } from '../llm/llm.config';
import type { LlmProvider, LlmProviderRequest } from '../llm/providers/llm-provider';

// Test helper: a REAL LlmClient (so zod, grounding, limits all run) wired to a fake provider. No network, no provider call.

export const TEST_LLM_CONFIG: LlmConfig = {
  provider: 'gemini', apiKey: 'test-key-not-real', model: 'test-model', monthlyBudgetUsd: null,
  priceInputPerMillionUsd: null, priceOutputPerMillionUsd: null, ratePerHour: 1000, cacheTtlMs: 600_000,
};

export function clientWith(respond: (input: any, req: LlmProviderRequest) => unknown, calls: LlmProviderRequest[] = [], config: LlmConfig | null = TEST_LLM_CONFIG) {
  const provider: LlmProvider = {
    async generate(req) {
      calls.push(req);
      const out = respond(JSON.parse(req.user), req);
      if (out instanceof Error) throw out;
      return { text: typeof out === 'string' ? out : JSON.stringify(out), tokensIn: 10, tokensOut: 10 };
    },
  };
  return new LlmClient({ getConfig: () => config, createProvider: () => provider, logger: { info() {}, warn() {} }, sleep: async () => {} });
}
