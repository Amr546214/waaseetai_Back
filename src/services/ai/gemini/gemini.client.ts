import type { GoogleGenAI } from '@google/genai' with { 'resolution-mode': 'import' };
import { logger } from '../../../config/logger';
import { geminiModelConfig } from '../../../config/ai/gemini.config';
import { GeminiErrorCode, GeminiProviderError, normalizeGeminiError } from './gemini.errors';

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

function buildTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export class GeminiClient {
  private sdkClient: GoogleGenAI | null = null;

  /** True only when GEMINI_API_KEY is present — never throws. */
  isConfigured(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  // Loaded lazily via dynamic import (never a static top-level import of
  // '@google/genai') so: (1) app startup never touches the SDK at all when
  // no Gemini feature is active yet, and (2) this resolves the package's
  // ESM build consistently, matching how Node's module-mocking test hooks
  // resolve it — the package ships separate CJS and ESM builds behind
  // conditional exports, and a statically-imported (require()-compiled)
  // reference would silently resolve to the *other*, unmocked build in
  // tests.
  private async getSdkClient(): Promise<GoogleGenAI> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new GeminiProviderError(GeminiErrorCode.NOT_CONFIGURED, 'GEMINI_API_KEY is not configured');
    }
    if (!this.sdkClient) {
      const { GoogleGenAI } = await import('@google/genai');
      this.sdkClient = new GoogleGenAI({ apiKey });
    }
    return this.sdkClient;
  }

  async generateText(prompt: string, options: GenerateTextOptions = {}): Promise<GeminiTextResult> {
    const { signal, clear } = buildTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);

    try {
      const client = await this.getSdkClient();
      const model = options.model || geminiModelConfig.textModel;

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
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini returned an empty response');
      }

      return { text, usage: extractUsage(response.usageMetadata) };
    } catch (error) {
      logger.debug(`[GeminiClient] generateText failed: ${(error as Error)?.message}`);
      throw normalizeGeminiError(error);
    } finally {
      clear();
    }
  }

  async generateStructured<T>(prompt: string, options: GenerateStructuredOptions<T>): Promise<GeminiStructuredResult<T>> {
    const { signal, clear } = buildTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);

    try {
      const client = await this.getSdkClient();
      const model = options.model || geminiModelConfig.textModel;

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

      const parsed = this.parseAndValidateStructuredResponse<T>(response.text, options.validate);
      return { data: parsed, usage: extractUsage(response.usageMetadata) };
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
    const { signal, clear } = buildTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);

    try {
      if (!options.images || options.images.length === 0) {
        throw new GeminiProviderError(GeminiErrorCode.UNKNOWN_PROVIDER_ERROR, 'generateStructuredWithImage requires at least one image');
      }

      const client = await this.getSdkClient();
      const model = options.model || geminiModelConfig.visionModel;

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt }];
      for (const image of options.images) {
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } });
      }

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

      const parsed = this.parseAndValidateStructuredResponse<T>(response.text, options.validate);
      return { data: parsed, usage: extractUsage(response.usageMetadata) };
    } catch (error) {
      logger.debug(`[GeminiClient] generateStructuredWithImage failed: ${(error as Error)?.message}`);
      throw normalizeGeminiError(error);
    } finally {
      clear();
    }
  }

  private parseAndValidateStructuredResponse<T>(rawText: string | undefined, validate?: (value: unknown) => boolean): T {
    if (!rawText || !rawText.trim()) {
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini returned an empty structured response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseError) {
      throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini returned malformed JSON', parseError);
    }

    if (validate) {
      let isValid: boolean;
      try {
        isValid = validate(parsed);
      } catch (validationError) {
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini response failed application validation', validationError);
      }
      if (!isValid) {
        throw new GeminiProviderError(GeminiErrorCode.INVALID_RESPONSE, 'Gemini response failed application validation');
      }
    }

    return parsed as T;
  }

  async *generateStream(prompt: string, options: GenerateStreamOptions = {}): GeminiTextStream {
    const { signal, clear } = buildTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
    let lastUsage: GeminiUsage = EMPTY_USAGE;

    try {
      const client = await this.getSdkClient();
      const model = options.model || geminiModelConfig.streamingModel;

      const stream = await client.models.generateContentStream({
        model,
        contents: prompt,
        config: {
          systemInstruction: options.systemInstruction,
          temperature: options.temperature,
          maxOutputTokens: options.maxOutputTokens,
          abortSignal: signal,
        },
      });

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
