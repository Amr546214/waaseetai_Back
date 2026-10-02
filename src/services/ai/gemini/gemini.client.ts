import type { GoogleGenAI } from '@google/genai' with { 'resolution-mode': 'import' };
import { logger } from '../../../config/logger';
import { geminiModelConfig } from '../../../config/ai/gemini.config';
import { GeminiErrorCode, GeminiProviderError, normalizeGeminiError } from './gemini.errors';
import { GeminiKeyPool } from './gemini-key-pool';

// Shared Gemini integration foundation. This module owns SDK
// initialization, config detection, model selection, and the three generic
// generation primitives (text / structured JSON / streaming) that every
// future Gemini-backed feature will build on.
//
// It intentionally contains NO product/feature logic — no prompts, no
// feature-specific schemas, no fallback text. Feature services own that;
// this layer only talks to Gemini and hands back clean, typed, already-
// normalized results or a GeminiProviderError.

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Bounded retry policy for genuinely transient upstream failures only
 * (GeminiProviderError.retryable: HTTP 502/503 and transient network
 * errors). Never applied to 429 (owned exclusively by GeminiKeyPool's
 * per-key failover, unchanged), auth/config failures, other 4xx, other 5xx,
 * timeouts/cancellation, or malformed/truncated/invalid responses.
 *
 * All attempts share the caller's single timeout signal, so the documented
 * per-feature timeout (20s default, 25s/30s/45s overrides) still bounds the
 * WHOLE operation including retries and backoff — a retry is only started
 * when the backoff plus `minAttemptWindowMs` still fits in what remains.
 */
export interface GeminiRetryPolicy {
  /** Total attempts including the first (so 3 = at most 2 retries). */
  maxAttempts: number;
  /** Fixed backoff before retry N (index 0 = before the 2nd attempt); the
   *  last entry is reused if there are more retries than entries. */
  backoffMs: number[];
  /** A retry is skipped when less than this would remain for the attempt itself. */
  minAttemptWindowMs: number;
  /** Upper bound on a server-provided retryDelay hint we are willing to honor. */
  maxRetryAfterMs: number;
}

export const DEFAULT_GEMINI_RETRY_POLICY: GeminiRetryPolicy = Object.freeze({
  maxAttempts: 3,
  backoffMs: [750, 1500],
  minAttemptWindowMs: 2_000,
  maxRetryAfterMs: 5_000,
}) as GeminiRetryPolicy;

export interface GeminiClientOptions {
  retryPolicy?: Partial<GeminiRetryPolicy>;
}

export interface GeminiUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

const EMPTY_USAGE: GeminiUsage = { promptTokens: null, completionTokens: null, totalTokens: null };

export interface GeminiTextResult {
  text: string;
  usage: GeminiUsage;
}

export interface GeminiStructuredResult<T> {
  data: T;
  usage: GeminiUsage;
}

export interface GenerateTextOptions {
  /** Overrides the centralized default text model for this call only. */
  model?: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Defaults to DEFAULT_TIMEOUT_MS when omitted. */
  timeoutMs?: number;
  /** Caller-provided cancellation, composed with the internal timeout. */
  signal?: AbortSignal;
}

export interface GenerateStructuredOptions<T> extends GenerateTextOptions {
  /** JSON-schema-like object (OpenAPI 3.0 schema subset) Gemini will constrain its output to. */
  responseSchema: Record<string, unknown>;
  /** Optional caller-owned validation, run after JSON parsing succeeds. Throwing
   *  or returning false both surface as GeminiErrorCode.INVALID_RESPONSE. */
  validate?: (value: unknown) => boolean;
}

/** A single image to attach to a Vision request. `data` is raw bytes — this
 *  layer owns the base64 encoding so callers never have to think about the
 *  wire format Gemini expects. Callers own fetching/validating the image
 *  itself (see src/utils/remote-image-fetch.ts) — this layer only accepts
 *  already-prepared bytes, never a URL, so it never performs its own
 *  outbound fetch. */
export interface GeminiImageInput {
  mimeType: string;
  data: Buffer;
}

export interface GenerateStructuredWithImageOptions<T> extends GenerateStructuredOptions<T> {
  /** One or more images to attach alongside the text prompt. */
  images: GeminiImageInput[];
}

export type GenerateStreamOptions = GenerateTextOptions;

/**
 * Async generator yielding text chunks as they stream in, and resolving
 * (via the generator's return value) to the final usage metadata once the
 * stream completes. Callers never see the underlying Gemini SDK stream
 * object — only plain string chunks — so socket relays can stay unaware of
 * SDK internals when this is wired into F1b/F2 in a later batch.
 */
export type GeminiTextStream = AsyncGenerator<string, GeminiUsage, void>;

function extractUsage(usageMetadata: unknown): GeminiUsage {
  if (!usageMetadata || typeof usageMetadata !== 'object') return EMPTY_USAGE;
  const meta = usageMetadata as Record<string, unknown>;
  const asNumberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  return {
    promptTokens: asNumberOrNull(meta.promptTokenCount),
    completionTokens: asNumberOrNull(meta.candidatesTokenCount),
    totalTokens: asNumberOrNull(meta.totalTokenCount),
  };
}

function buildTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; clear: () => void; deadline: number } {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer), deadline };
}

/** Sleeps `ms`, rejecting with an AbortError (→ TIMEOUT) if `signal` aborts first. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error('aborted during retry backoff'), { name: 'AbortError' });
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Finish reasons that mean the model completed its answer normally.
const COMPLETE_FINISH_REASONS = new Set(['STOP', 'FINISH_REASON_UNSPECIFIED']);

interface GeminiResponseLike {
  text?: string;
  usageMetadata?: unknown;
  candidates?: Array<{ finishReason?: unknown }>;
}

function finishReasonOf(response: GeminiResponseLike): string | undefined {
  const reason = response?.candidates?.[0]?.finishReason;
  // Enum-shaped values only — never echo arbitrary provider text into a message/log.
  return typeof reason === 'string' && /^[A-Z_]{1,64}$/.test(reason) ? reason : undefined;
}

function numberOrNull(meta: unknown, key: string): number | null {
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

export class GeminiClient {
  // Owns key selection, round-robin distribution, and quota/rate-limit
  // failover across one or more configured Gemini API keys (GEMINI_API_KEYS,
  // falling back to the legacy single GEMINI_API_KEY). See
  // gemini-key-pool.ts. This remains the ONLY place in the codebase that
  // talks to the pool — every feature service still only ever sees
  // GeminiClient's public methods below, unchanged.
  private keyPool = new GeminiKeyPool();
  private readonly retryPolicy: GeminiRetryPolicy;

  constructor(options: GeminiClientOptions = {}) {
    this.retryPolicy = { ...DEFAULT_GEMINI_RETRY_POLICY, ...options.retryPolicy };
  }

  /**
   * Runs `operation` (one full key-pool execution) with bounded retry for
   * transient upstream failures only. See GeminiRetryPolicy. On exhaustion,
   * or for any non-retryable failure, throws the real normalized error —
   * never a fabricated result.
   */
  private async withTransientRetry<R>(label: string, signal: AbortSignal, deadline: number, operation: () => Promise<R>): Promise<R> {
    const { maxAttempts, backoffMs, minAttemptWindowMs, maxRetryAfterMs } = this.retryPolicy;
    const attemptsAllowed = Math.max(1, Math.floor(maxAttempts));

    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const normalized = normalizeGeminiError(error);
        if (!normalized.retryable || attempt >= attemptsAllowed || signal.aborted) throw normalized;

        const fallbackDelay = backoffMs.length ? backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] : 0;
        if (normalized.retryAfterMs !== undefined && normalized.retryAfterMs > maxRetryAfterMs) {
          // The provider itself says "not for a while" — honor that by not
          // retrying inside this request rather than inventing a shorter wait.
          throw normalized;
        }
        const delayMs = Math.max(fallbackDelay, normalized.retryAfterMs ?? 0);
        if (Date.now() + delayMs + minAttemptWindowMs > deadline) throw normalized;

        logger.warn(`[GeminiClient] ${label}: transient ${normalized.code}/${normalized.detail}${normalized.httpStatus ? ` (HTTP ${normalized.httpStatus})` : ''} on attempt ${attempt}/${attemptsAllowed}; retrying in ${delayMs}ms`);
        await abortableDelay(delayMs, signal);
      }
    }
  }

  /** True only when at least one Gemini API key is configured — never throws. */
  isConfigured(): boolean {
    return this.keyPool.isConfigured();
  }

  async generateText(prompt: string, options: GenerateTextOptions = {}): Promise<GeminiTextResult> {
    const { signal, clear, deadline } = buildTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);

    try {
      const model = options.model || geminiModelConfig.textModel;

      return await this.withTransientRetry('generateText', signal, deadline, () => this.keyPool.execute(async (client) => {
        const response = await client.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: options.systemInstruction,
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
            abortSignal: signal,
          },
        });

        const text = response.text;
        if (!text || !text.trim()) {
          throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini returned an empty response', undefined, { detail: 'EMPTY_RESPONSE' });
        }

        return { text, usage: extractUsage(response.usageMetadata) };
      }));
    } catch (error) {
      logger.debug(`[GeminiClient] generateText failed: ${(error as Error)?.message}`);
      throw normalizeGeminiError(error);
    } finally {
      clear();
    }
  }

  async generateStructured<T>(prompt: string, options: GenerateStructuredOptions<T>): Promise<GeminiStructuredResult<T>> {
    const { signal, clear, deadline } = buildTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);

    try {
      const model = options.model || geminiModelConfig.textModel;

      return await this.withTransientRetry('generateStructured', signal, deadline, () => this.keyPool.execute(async (client) => {
        const response = await client.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: options.systemInstruction,
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: options.responseSchema as never,
            abortSignal: signal,
          },
        });

        const parsed = this.parseAndValidateStructuredResponse<T>(response, options.validate, options.maxOutputTokens);
        return { data: parsed, usage: extractUsage(response.usageMetadata) };
      }));
    } catch (error) {
      logger.debug(`[GeminiClient] generateStructured failed: ${(error as Error)?.message}`);
      throw normalizeGeminiError(error);
    } finally {
      clear();
    }
  }

  /**
   * Vision variant of generateStructured(): attaches one or more images
   * alongside the text prompt. The image bytes must already be fetched and
   * validated by the caller (see src/utils/remote-image-fetch.ts) — this
   * method never fetches a URL itself, so it carries no SSRF surface of its
   * own. Everything else (model selection, JSON parsing, validation, error
   * normalization, usage extraction) is identical to generateStructured().
   */
  async generateStructuredWithImage<T>(prompt: string, options: GenerateStructuredWithImageOptions<T>): Promise<GeminiStructuredResult<T>> {
    const { signal, clear, deadline } = buildTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);

    try {
      if (!options.images || options.images.length === 0) {
        throw new GeminiProviderError(GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'generateStructuredWithImage requires at least one image');
      }

      const model = options.model || geminiModelConfig.visionModel;
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt }];
      for (const image of options.images) {
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } });
      }

      return await this.withTransientRetry('generateStructuredWithImage', signal, deadline, () => this.keyPool.execute(async (client) => {
        const response = await client.models.generateContent({
          model,
          contents: parts as never,
          config: {
            systemInstruction: options.systemInstruction,
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: options.responseSchema as never,
            abortSignal: signal,
          },
        });

        const parsed = this.parseAndValidateStructuredResponse<T>(response, options.validate, options.maxOutputTokens);
        return { data: parsed, usage: extractUsage(response.usageMetadata) };
      }));
    } catch (error) {
      logger.debug(`[GeminiClient] generateStructuredWithImage failed: ${(error as Error)?.message}`);
      throw normalizeGeminiError(error);
    } finally {
      clear();
    }
  }

  /**
   * Every structured call already uses responseMimeType 'application/json'
   * + responseSchema (constrained decoding), so Gemini does not wrap output
   * in markdown fences; a plain JSON.parse is correct and no fence-stripping
   * is attempted. Under constrained decoding, malformed JSON in practice
   * means the output was cut off — so finishReason is checked FIRST, and a
   * truncated (MAX_TOKENS) or otherwise early-stopped response is rejected
   * explicitly instead of being reported as generic "malformed JSON" (or,
   * worse, ever partially accepted). None of these are retried: an
   * identical request would hit the same token limit / safety stop.
   */
  private parseAndValidateStructuredResponse<T>(
    response: GeminiResponseLike,
    validate?: (value: unknown) => boolean,
    maxOutputTokens?: number
  ): T {
    const finishReason = finishReasonOf(response);
    if (finishReason === 'MAX_TOKENS') {
      const meta = response.usageMetadata;
      logger.warn(
        `[GeminiClient] structured response truncated at maxOutputTokens=${maxOutputTokens ?? 'default'} ` +
        `(thoughtsTokens=${numberOrNull(meta, 'thoughtsTokenCount') ?? 'n/a'}, candidatesTokens=${numberOrNull(meta, 'candidatesTokenCount') ?? 'n/a'})`
      );
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini structured response was truncated at the output token limit', undefined, { detail: 'TRUNCATED' });
    }
    if (finishReason && !COMPLETE_FINISH_REASONS.has(finishReason)) {
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, `Gemini structured response ended early (finishReason=${finishReason})`, undefined, { detail: 'INCOMPLETE' });
    }

    const rawText = response.text;
    if (!rawText || !rawText.trim()) {
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini returned an empty structured response', undefined, { detail: 'EMPTY_RESPONSE' });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseError) {
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini returned malformed JSON', parseError, { detail: 'MALFORMED_JSON' });
    }

    if (validate) {
      let isValid: boolean;
      try {
        isValid = validate(parsed);
      } catch (validationError) {
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini response failed application validation', validationError, { detail: 'SCHEMA_INVALID' });
      }
      if (!isValid) {
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini response failed application validation', undefined, { detail: 'SCHEMA_INVALID' });
      }
    }

    return parsed as T;
  }

  async *generateStream(prompt: string, options: GenerateStreamOptions = {}): GeminiTextStream {
    const { signal, clear, deadline } = buildTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
    let lastUsage: GeminiUsage = EMPTY_USAGE;

    try {
      const model = options.model || geminiModelConfig.streamingModel;

      // Key rotation only covers establishing the stream itself. Once
      // chunks have started flowing, a mid-stream failure is propagated
      // as-is (never silently retried on another key) — restarting a
      // partially-consumed stream on a different key could duplicate or
      // corrupt output the caller may have already relayed onward (e.g. to
      // a live socket). The same rule applies to the bounded transient
      // retry: it only wraps stream ESTABLISHMENT (the SDK throws HTTP
      // errors before returning the iterator, so nothing has been yielded
      // yet) — never a partially-consumed stream.
      const stream = await this.withTransientRetry('generateStream', signal, deadline, () => this.keyPool.execute((client) =>
        client.models.generateContentStream({
          model,
          contents: prompt,
          config: {
            systemInstruction: options.systemInstruction,
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
            abortSignal: signal,
          },
        })
      ));

      for await (const chunk of stream) {
        if (chunk.usageMetadata) lastUsage = extractUsage(chunk.usageMetadata);
        if (chunk.text) yield chunk.text;
      }

      return lastUsage;
    } catch (error) {
      logger.debug(`[GeminiClient] generateStream failed: ${(error as Error)?.message}`);
      throw normalizeGeminiError(error);
    } finally {
      clear();
    }
  }
}

export const geminiClient = new GeminiClient();
