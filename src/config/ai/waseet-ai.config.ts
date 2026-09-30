// Centralized WaseetAI microservice configuration.
//
// WaseetAI is Waseet's own AI microservice (Cloud Run). It owns the Gemini
// key pool, model selection, and privacy routing (SENSITIVE/PERSONAL/DISPUTE
// payloads go to a dedicated paid project) internally. Waseet's backend only
// needs a base URL and ONE bearer token to talk to it.
//
// Rules:
//  - The bearer token is read from the environment ONLY. It is never
//    hardcoded, never defaulted, never logged, and never sent to Angular.
//  - The base URL is not a secret; it has a documented default so only the
//    token is strictly required for the client to be "configured".
//  - Config is read lazily (per call) rather than captured at import time so
//    a missing/rotated env value is detected accurately at runtime and in
//    tests.

export const WASEET_AI_DEFAULT_BASE_URL = 'https://waseet-ai-api-1041761245251.us-central1.run.app';
export const WASEET_AI_CLIENT_ID = 'waseet_core_backend';

export interface WaseetAiConfig {
  baseUrl: string;
  /** Present only when WASEET_AI_BEARER_TOKEN is set to a non-empty value. */
  bearerToken: string | undefined;
  /** Default timeout for non-streaming REST calls. */
  restTimeoutMs: number;
  /** Default overall timeout for SSE streaming calls. */
  streamTimeoutMs: number;
}

const PLACEHOLDER_TOKENS = new Set(['', '<set-me>', 'changeme', 'dummy_key']);

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWaseetAiConfig(env: NodeJS.ProcessEnv = process.env): WaseetAiConfig {
  const rawToken = (env.WASEET_AI_BEARER_TOKEN ?? '').trim();
  const rawBase = (env.WASEET_AI_BASE_URL ?? '').trim();
  return {
    baseUrl: (rawBase || WASEET_AI_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    bearerToken: PLACEHOLDER_TOKENS.has(rawToken) ? undefined : rawToken,
    restTimeoutMs: readPositiveInt(env.WASEET_AI_TIMEOUT_MS, 30_000),
    streamTimeoutMs: readPositiveInt(env.WASEET_AI_STREAM_TIMEOUT_MS, 90_000),
  };
}
