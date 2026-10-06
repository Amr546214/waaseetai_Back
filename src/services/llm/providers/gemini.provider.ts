import { LlmError, LlmErrorCode } from '../llm.errors';
import type { LlmProvider, LlmProviderRequest, LlmProviderResponse } from './llm-provider';

// Thin REST adapter (no SDK). The API key travels only in a request header and is never logged; upstream response bodies are
// never copied into errors.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export class GeminiProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        signal: request.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: request.maxOutputTokens, temperature: 0.2 },
        }),
      });
    } catch (error) {
      if (request.signal.aborted || (error as { name?: string })?.name === 'AbortError') throw new LlmError(LlmErrorCode.TIMEOUT, 'request timed out');
      throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'network error', { retryable: true });
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new LlmError(LlmErrorCode.AUTHENTICATION_ERROR, `status ${res.status}`);
      if (res.status === 429) throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'provider rate limited');
      if (res.status === 502 || res.status === 503) throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, `status ${res.status}`, { retryable: true });
      throw new LlmError(LlmErrorCode.UNKNOWN, `status ${res.status}`);
    }

    let body: any;
    try { body = await res.json(); } catch { throw new LlmError(LlmErrorCode.INVALID_RESPONSE, 'unreadable response'); }
    const candidate = body?.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') throw new LlmError(LlmErrorCode.INVALID_RESPONSE, 'output truncated');
    const text = candidate?.content?.parts?.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') ?? '';
    if (!text.trim()) throw new LlmError(LlmErrorCode.INVALID_RESPONSE, 'empty response');
    return {
      text,
      tokensIn: Number(body?.usageMetadata?.promptTokenCount) || 0,
      tokensOut: Number(body?.usageMetadata?.candidatesTokenCount) || 0,
    };
  }
}
