export interface LlmProviderRequest {
  system: string;
  /** JSON text of the (already redacted) input. */
  user: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  userId?: string;
  feature?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  model?: string;
}

export interface LlmProviderResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  usageMeasured?: boolean;
  model?: string;
}

/** One implementation per model provider. Implementations must never log keys/prompts and must throw LlmError only. */
export interface LlmProvider {
  generate(request: LlmProviderRequest): Promise<LlmProviderResponse>;
}
