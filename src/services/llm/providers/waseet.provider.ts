import { waseetAiClient, type WaseetAiClient } from '../../ai/waseet-ai/waseet-ai.client';
import { currentWaseetActor } from '../../ai/waseet-ai/waseet-ai.auth';
import { WaseetAiErrorCode, normalizeWaseetAiError } from '../../ai/waseet-ai/waseet-ai.errors';
import { LlmError, LlmErrorCode } from '../llm.errors';
import type { LlmProvider, LlmProviderRequest, LlmProviderResponse } from './llm-provider';

/** All production JSON features share the AI service's route, privacy, quota and cancellation policy. */
export class WaseetProvider implements LlmProvider {
  constructor(private readonly model = 'auto', private readonly client: Pick<WaseetAiClient, 'generate'> = waseetAiClient) {}
  async generate(req: LlmProviderRequest): Promise<LlmProviderResponse> {
    try {
      const actor = currentWaseetActor();
      const system = [
        req.system,
        req.schemaJson ? `يجب أن يطابق JSON المُعاد هذا المخطط (JSON Schema) حرفياً بأسماء الحقول وأنواعها:\n${req.schemaJson}` : '',
        req.groundingHint || '',
      ].filter(Boolean).join('\n\n');
      const result = await this.client.generate({
        system, user: req.user, maxOutputTokens: req.maxOutputTokens,
        effort: req.effort || (/delivery|audit|portfolio/.test(req.feature || '') ? 'medium' : 'low'),
        profile: 'analyst', feature: req.feature || 'structured-analysis', responseFormat: 'json',
        classification: 'PERSONAL',
        ...((req.model || this.model) !== 'auto' ? { model: req.model || this.model } : {}),
      }, { signal: req.signal, actor: actor || (req.userId ? { userId: req.userId, role: 'client' } : { userId: 'service-reader', role: 'system' }) });
      const measured = result.tokensIn !== null && result.tokensOut !== null;
      // Missing vendor counters are conservative estimates explicitly labelled as such, never fabricated measurements.
      return { text: result.text, tokensIn: result.tokensIn ?? Math.ceil((req.system.length + req.user.length) / 3),
        tokensOut: result.tokensOut ?? req.maxOutputTokens, usageMeasured: measured, model: result.model };
    } catch (error) {
      const e = normalizeWaseetAiError(error);
      const code = e.code === WaseetAiErrorCode.NOT_CONFIGURED ? LlmErrorCode.NOT_CONFIGURED
        : e.code === WaseetAiErrorCode.TIMEOUT ? LlmErrorCode.TIMEOUT
        : e.code === WaseetAiErrorCode.RATE_LIMITED ? LlmErrorCode.RATE_LIMITED
        : e.code === WaseetAiErrorCode.AUTHENTICATION_ERROR ? LlmErrorCode.AUTHENTICATION_ERROR
        : e.code === WaseetAiErrorCode.INVALID_RESPONSE ? LlmErrorCode.INVALID_RESPONSE : LlmErrorCode.PROVIDER_UNAVAILABLE;
      throw new LlmError(code, 'AI gateway request failed');
    }
  }
}
