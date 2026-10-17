import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WaseetAiConfig } from '../../../config/ai/waseet-ai.config';
import { WaseetAiError, WaseetAiErrorCode, errorFromHttpStatus } from './waseet-ai.errors';

export interface WaseetActor {
  userId: string;
  role: 'client' | 'provider' | 'marketer' | 'admin' | 'system';
}

const actorContext = new AsyncLocalStorage<WaseetActor>();
export const runWithWaseetActor = <T>(actor: WaseetActor, work: () => T): T => actorContext.run(actor, work);
export const currentWaseetActor = (): WaseetActor | undefined => actorContext.getStore();
export function waseetActorRole(activeRole?: string | null, accountType?: string | null): WaseetActor['role'] {
  if (accountType === 'ADMIN' || accountType === 'SUPER_ADMIN') return 'admin';
  if (activeRole === 'CLIENT') return 'client';
  if (activeRole === 'PROVIDER') return 'provider';
  if (activeRole === 'AFFILIATE' || activeRole === 'MARKETER') return 'marketer';
  if (accountType?.startsWith('PROVIDER')) return 'provider';
  if (accountType === 'MARKETING_BROKER') return 'marketer';
  return 'client';
}

/** Tokens are bound to an authenticated actor and environment. Never logged or returned to the browser. */
export class WaseetServiceTokenBroker {
  private readonly tokens = new Map<string, { token: string; expires: number }>();
  constructor(private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>, private readonly now = Date.now) {}

  async token(config: WaseetAiConfig, actor: WaseetActor, signal: AbortSignal, requestId: string): Promise<string> {
    if (config.authMode !== 'signed') {
      if (!config.bearerToken) throw new WaseetAiError(WaseetAiErrorCode.NOT_CONFIGURED, 'AI authentication is not configured');
      return config.bearerToken;
    }
    if (!config.clientSecret || config.clientSecret.length < 32) throw new WaseetAiError(WaseetAiErrorCode.NOT_CONFIGURED, 'AI signing credentials are not configured');
    const key = createHash('sha256').update(JSON.stringify([config.baseUrl, config.clientId, config.clientSecret, config.environment, actor])).digest('hex');
    for (const [k, v] of this.tokens) if (v.expires <= this.now()) this.tokens.delete(k);
    const cached = this.tokens.get(key);
    if (cached && cached.expires > this.now() + 30_000) return cached.token;
    // Exchanges own the caller's signal. Do not share an in-flight exchange: cancelling
    // one request must not cancel another request for the same actor.
    return this.exchange(config, actor, signal, requestId).then((result) => {
      this.tokens.set(key, { token: result.token, expires: this.now() + result.expiresIn * 1000 });
      while (this.tokens.size > 128) this.tokens.delete(this.tokens.keys().next().value as string);
      return result.token;
    });
  }

  private async exchange(config: WaseetAiConfig, actor: WaseetActor, signal: AbortSignal, requestId: string): Promise<{ token: string; expiresIn: number }> {
    const response = await this.fetchImpl(`${config.baseUrl}/v1/auth/token`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'X-Request-Id': requestId },
      body: JSON.stringify({ clientId: config.clientId || 'waseet_core_backend', clientSecret: config.clientSecret, environment: config.environment || 'dev', actor }),
    });
    if (!response.ok) throw errorFromHttpStatus(response.status, requestId);
    const raw = await response.json() as Record<string, unknown>;
    const data = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : raw;
    if (raw.success !== true || typeof data.token !== 'string' || !data.token || typeof data.expiresIn !== 'number' || data.expiresIn < 1 || data.expiresIn > 900) {
      throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'Invalid AI token exchange', { requestId });
    }
    return { token: data.token, expiresIn: data.expiresIn };
  }
}
