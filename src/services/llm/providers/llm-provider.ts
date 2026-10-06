export interface LlmProviderRequest {
  system: string;
  /** JSON text of the (already redacted) input. */
  user: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface LlmProviderResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** One implementation per model provider. Implementations must never log keys/prompts and must throw LlmError only. */
export interface LlmProvider {
  generate(request: LlmProviderRequest): Promise<LlmProviderResponse>;
}
