// LLM layer configuration, read lazily from env (never hardcoded, never logged). The model name is REQUIRED from env: no model
// name exists in code. Only the `gemini` provider is implemented; the providers/ folder lets another be added later.

export const SUPPORTED_LLM_PROVIDERS = ['gemini', 'waseet'] as const;
export type LlmProviderName = (typeof SUPPORTED_LLM_PROVIDERS)[number];

export interface LlmConfig {
  provider: LlmProviderName;
  apiKey: string;
  apiKeys?: string[];
  model: string;
  /** Secondary in-memory circuit breaker (the primary budget is set in the provider console). null = disabled. */
  monthlyBudgetUsd: number | null;
  priceInputPerMillionUsd: number | null;
  priceOutputPerMillionUsd: number | null;
  ratePerHour: number;
  cacheTtlMs: number;
  /** Route policy version participates in cached result identity. */
  policyVersion?: string;
}

const num = (v: string | undefined): number | null => {
  const n = Number((v ?? '').trim());
  return (v ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};

/** Returns null when ANY required variable is missing/blank (→ NOT_CONFIGURED, never a runtime crash). */
export function getLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const provider = env.WASEET_AI_GATEWAY_ENABLED === 'true' ? 'waseet' : (env.LLM_PROVIDER ?? '').trim().toLowerCase();
  const apiKey = (env.LLM_API_KEY ?? env.GEMINI_API_KEY ?? '').trim();
  const model = (env.LLM_MODEL ?? '').trim();
  if (!(SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (provider === 'gemini' && (!apiKey || !model)) return null;
  if (provider === 'waseet' && !(env.WASEET_AI_CLIENT_SECRET || env.WASEET_AI_BEARER_TOKEN)) return null;

  const rawKeys = (env.LLM_API_KEYS ?? '').trim();
  const apiKeys = rawKeys
    ? rawKeys.split(',').map((k) => k.trim()).filter(Boolean)
    : [apiKey];

  const monthlyBudgetUsd = num(env.LLM_MONTHLY_BUDGET_USD);
  const priceIn = num(env.LLM_PRICE_INPUT_PER_MILLION_USD);
  const priceOut = num(env.LLM_PRICE_OUTPUT_PER_MILLION_USD);
  // a budget breaker without prices could never trip: fail closed instead of silently running unbounded
  if (monthlyBudgetUsd !== null && (priceIn === null || priceOut === null)) return null;

  const rate = num(env.LLM_RATE_PER_HOUR);
  const ttl = num(env.LLM_CACHE_TTL_MINUTES);
  return {
    provider: provider as LlmProviderName,
    apiKey: provider === 'waseet' ? 'service-gateway' : apiKey,
    apiKeys,
    model: provider === 'waseet' ? (env.WASEET_AI_MODEL_PIN || 'auto').trim() : model,
    monthlyBudgetUsd,
    priceInputPerMillionUsd: priceIn,
    priceOutputPerMillionUsd: priceOut,
    ratePerHour: rate !== null && rate > 0 ? Math.floor(rate) : 10,
    cacheTtlMs: Math.min(30, Math.max(10, ttl ?? 15)) * 60_000,
    policyVersion: 'multiagents-fixed-v1',
  };
}
