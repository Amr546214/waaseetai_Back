import type { GoogleGenAI } from '@google/genai' with { 'resolution-mode': 'import' };
import { logger } from '../../../config/logger';
import { GeminiErrorCode, GeminiProviderError, normalizeGeminiError } from './gemini.errors';

// Backend-only Gemini API key pool: deterministic round-robin distribution
// across configured keys, with cooldown-based failover when a key hits a
// provider quota/rate-limit condition. This is an internal implementation
// detail owned exclusively by GeminiClient (see gemini.client.ts) — nothing
// else in the codebase should ever import this module, preserving the rule
// that all Gemini execution goes through the one centralized client.
//
// SECURITY: no code path here ever logs a raw API key, a prefix/suffix, or
// the full GEMINI_API_KEYS/GEMINI_API_KEY value — only the non-sensitive
// 1-based slot identifier ("gemini-key-slot-N").

const DEFAULT_COOLDOWN_MS = 60_000;

function resolveCooldownMs(): number {
  const raw = Number(process.env.GEMINI_KEY_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLDOWN_MS;
}

/** Splits on commas, trims whitespace, drops empty entries, de-dupes while
 *  preserving order. Returns [] for an unset/blank value. */
function parseMultiKeyEnv(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const raw of value.split(',')) {
    const key = raw.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** GEMINI_API_KEYS (multi-key) takes priority over the legacy single
 *  GEMINI_API_KEY when both are present. Falls back to the single key alone
 *  when GEMINI_API_KEYS is absent/blank. Returns [] when neither is set. */
function resolveConfiguredKeys(): string[] {
  const multi = parseMultiKeyEnv(process.env.GEMINI_API_KEYS);
  if (multi.length > 0) return multi;
  const single = process.env.GEMINI_API_KEY?.trim();
  return single ? [single] : [];
}

interface KeySlot {
  /** 1-based, for logging/identification only — never the key itself. */
  readonly id: number;
  readonly apiKey: string;
  /** Epoch ms until which this slot is skipped for new attempts; null = healthy. */
  unavailableUntil: number | null;
  /** Lazily-created SDK client bound to this specific key. */
  sdkClient: GoogleGenAI | null;
}

// A firm ceiling on how many distinct keys a single request will ever try,
// independent of pool size — defense in depth against a misconfigured,
// unexpectedly large key list. Never infinite, never unbounded.
const MAX_KEY_ATTEMPTS_CEILING = 10;

export class GeminiKeyPool {
  private slots: KeySlot[] | null = null;
  private cursor = 0;
  private readonly cooldownMs = resolveCooldownMs();

  private load(): KeySlot[] {
    if (this.slots) return this.slots;
    this.slots = resolveConfiguredKeys().map((apiKey, index) => ({
      id: index + 1,
      apiKey,
      unavailableUntil: null,
      sdkClient: null,
    }));
    return this.slots;
  }

  size(): number {
    return this.load().length;
  }

  isConfigured(): boolean {
    return this.size() > 0;
  }

  private slotLabel(slot: KeySlot): string {
    return `gemini-key-slot-${slot.id}`;
  }

  private isHealthy(slot: KeySlot, now: number): boolean {
    return !slot.unavailableUntil || slot.unavailableUntil <= now;
  }

  private markRateLimited(slot: KeySlot): void {
    slot.unavailableUntil = Date.now() + this.cooldownMs;
    logger.warn(`[GeminiKeyPool] ${this.slotLabel(slot)} hit a provider quota/rate-limit error; cooling down for ${this.cooldownMs}ms`);
  }

  private async getSdkClientForSlot(slot: KeySlot): Promise<GoogleGenAI> {
    if (!slot.sdkClient) {
      const { GoogleGenAI } = await import('@google/genai');
      slot.sdkClient = new GoogleGenAI({ apiKey: slot.apiKey });
    }
    return slot.sdkClient;
  }

  /**
   * Runs `operation` against one healthy key. Applies deterministic
   * round-robin selection across separate calls (each call to execute()
   * advances the shared cursor exactly once, before any await, so
   * concurrent calls still get distinct sequential starting slots) and
   * quota/rate-limit failover within a single call.
   *
   * Only a normalized GeminiErrorCode.RATE_LIMITED failure moves on to the
   * next key. Every other error (invalid input, WaseetAI auth, malformed
   * structured output, timeouts, unrelated provider errors) propagates
   * immediately without rotating — those are not per-key problems.
   *
   * Bounded to at most one attempt per configured key (a slot already tried
   * this cycle is never retried) and never more than
   * MAX_KEY_ATTEMPTS_CEILING attempts overall, so this can never loop
   * indefinitely. If every key is exhausted/cooling down, throws the last
   * real provider error honestly — never fabricates a response.
   */
  async execute<R>(operation: (client: GoogleGenAI) => Promise<R>): Promise<R> {
    const slots = this.load();
    if (slots.length === 0) {
      throw new GeminiProviderError(GeminiErrorCode.NOT_CONFIGURED, 'No Gemini API key is configured');
    }

    const startIndex = this.cursor;
    this.cursor = (this.cursor + 1) % slots.length;

    const maxAttempts = Math.min(slots.length, MAX_KEY_ATTEMPTS_CEILING);
    let lastError: GeminiProviderError | null = null;

    for (let offset = 0; offset < maxAttempts; offset++) {
      const slot = slots[(startIndex + offset) % slots.length];
      if (!this.isHealthy(slot, Date.now())) continue; // cooling down — skip, no SDK call spent

      try {
        const client = await this.getSdkClientForSlot(slot);
        return await operation(client);
      } catch (error) {
        const normalized = normalizeGeminiError(error);
        if (normalized.code !== GeminiErrorCode.RATE_LIMITED) {
          throw normalized;
        }
        this.markRateLimited(slot);
        lastError = normalized;
      }
    }

    throw lastError ?? new GeminiProviderError(
      GeminiErrorCode.PROVIDER_UNAVAILABLE,
      'All configured Gemini API keys are currently rate-limited or unavailable'
    );
  }
}
