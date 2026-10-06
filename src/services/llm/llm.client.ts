import type { ZodType } from 'zod';
import { logger as defaultLogger } from '../../config/logger';
import { getLlmConfig, type LlmConfig } from './llm.config';
import { LlmError, LlmErrorCode } from './llm.errors';
import { GroundingError, verifyGrounding, type GroundingSpec } from './llm.truth';
import { InFlightLock, MonthlyBudget, RateLimiter, TtlLru, canonicalJson, hashOf, userHash } from './llm.limits';
import { createProvider } from './providers';
import type { LlmProvider } from './providers/llm-provider';

export type LlmFeature = 'project-fit' | 'project-health' | 'delivery-review' | (string & {});

export interface GenerateJsonOptions<T> {
  feature: LlmFeature;
  userId: string;
  schema: ZodType<T>;
  system: string;
  /** Already redacted payload (see llm.payload.ts). Sent as JSON text. */
  input: unknown;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Honesty checks applied after zod validation; a violation rejects the output. */
  grounding?: GroundingSpec;
  /** Short in-memory cache, ONLY for read-only features whose result does not depend on anything not in `input`. */
  cache?: boolean;
}

export interface GenerateJsonResult<T> {
  data: T;
  usage: { tokensIn: number; tokensOut: number };
  /** Internal marker; the UI shows the "AI" label only when this is 'LLM'. Never a provider name. */
  source: 'LLM';
}

export interface LlmLogger { info(message: string): void; warn(message: string): void }

export interface LlmClientDeps {
  getConfig?: () => LlmConfig | null;
  createProvider?: (config: LlmConfig) => LlmProvider;
  logger?: LlmLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1500;
const MAX_OUTPUT_TOKENS_CAP = 3000;
const RETRY_BACKOFF_MS = 400;

export class LlmClient {
  private readonly getConfig: () => LlmConfig | null;
  private readonly makeProvider: (config: LlmConfig) => LlmProvider;
  private readonly log: LlmLogger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private limiter?: RateLimiter;
  private limiterRate = 0;
  private readonly lock = new InFlightLock();
  private budget?: MonthlyBudget;
  private budgetKey = '';
  private readonly cache = new TtlLru<unknown>(200);

  constructor(deps: LlmClientDeps = {}) {
    this.getConfig = deps.getConfig ?? (() => getLlmConfig());
    this.makeProvider = deps.createProvider ?? createProvider;
    this.log = deps.logger ?? defaultLogger;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  isConfigured(): boolean { return this.getConfig() !== null; }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<GenerateJsonResult<T>> {
    const started = this.now();
    const uh = userHash(opts.userId);
    let tokensIn = 0;
    let tokensOut = 0;
    let lockKey: string | null = null;
    try {
      const config = this.getConfig();
      if (!config) throw new LlmError(LlmErrorCode.NOT_CONFIGURED, 'not configured');

      const budget = this.budgetFor(config);
      if (!budget.allows()) throw new LlmError(LlmErrorCode.BUDGET_EXCEEDED, 'monthly budget reached');

      // cache first (read-only features): a hit costs nothing and is not rate limited
      const cacheKey = opts.cache ? hashOf(`${opts.feature}|${opts.userId}|${canonicalJson(opts.input)}`) : null;
      if (cacheKey) {
        const hit = this.cache.get(cacheKey) as GenerateJsonResult<T> | undefined;
        if (hit) {
          this.log.info(this.line({ feature: opts.feature, user: uh, ms: this.now() - started, tokensIn: 0, tokensOut: 0, outcome: 'cache_hit' }));
          return hit;
        }
      }

      if (!this.limiterFor(config).tryAcquire(`${opts.feature}:${opts.userId}`)) throw new LlmError(LlmErrorCode.RATE_LIMITED, 'user rate limit');
      lockKey = `${opts.feature}:${opts.userId}`;
      if (!this.lock.acquire(lockKey)) { lockKey = null; throw new LlmError(LlmErrorCode.BUSY, 'concurrent call'); }

      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      const maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS_CAP, Math.max(100, opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const deadline = this.now() + timeoutMs;
      const provider = this.makeProvider(config);
      const userText = JSON.stringify(opts.input ?? null);

      const call = async (user: string) => {
        let attempt = 0;
        for (;;) {
          try {
            const res = await provider.generate({ system: opts.system, user, maxOutputTokens, signal: controller.signal });
            tokensIn += res.tokensIn; tokensOut += res.tokensOut;
            return res;
          } catch (error) {
            const e = error instanceof LlmError ? error : new LlmError(LlmErrorCode.UNKNOWN, 'unexpected');
            if (controller.signal.aborted) throw new LlmError(LlmErrorCode.TIMEOUT, 'timeout');
            // one retry, transient upstream failures only, and only if time remains for it
            if (e.retryable && attempt === 0 && deadline - this.now() > RETRY_BACKOFF_MS + 2000) { attempt++; await this.sleep(RETRY_BACKOFF_MS); continue; }
            throw e;
          }
        }
      };

      try {
        let res = await call(userText);
        let parsed = this.parse(opts.schema, res.text);
        if (!parsed.ok) {
          // ONE repair attempt: issue paths only (never values) + the model's own previous text
          const repairInput = JSON.stringify({ input: opts.input ?? null, previousOutput: res.text.slice(0, 6000), problems: parsed.problems });
          res = await call(repairInput);
          parsed = this.parse(opts.schema, res.text);
          if (!parsed.ok) throw new LlmError(LlmErrorCode.INVALID_RESPONSE, 'invalid after repair');
        }
        if (opts.grounding) {
          try { verifyGrounding(parsed.data, opts.input, opts.grounding); }
          catch (error) {
            if (error instanceof GroundingError) throw new LlmError(LlmErrorCode.UNGROUNDED_OUTPUT, error.reason);
            throw error;
          }
        }
        budget.record(tokensIn, tokensOut);
        const result: GenerateJsonResult<T> = { data: parsed.data as T, usage: { tokensIn, tokensOut }, source: 'LLM' };
        if (cacheKey) this.cache.set(cacheKey, result, config.cacheTtlMs);
        this.log.info(this.line({ feature: opts.feature, user: uh, ms: this.now() - started, tokensIn, tokensOut, outcome: 'ok' }));
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const e = error instanceof LlmError ? error : new LlmError(LlmErrorCode.UNKNOWN, 'unexpected');
      // tokens spent on a failed call still count against the budget
      if ((tokensIn || tokensOut) && this.budget) this.budget.record(tokensIn, tokensOut);
      this.log.warn(this.line({ feature: opts.feature, user: uh, ms: this.now() - started, tokensIn, tokensOut, outcome: 'error', errorCode: e.code }));
      throw e;
    } finally {
      if (lockKey) this.lock.release(lockKey);
    }
  }

  private parse<T>(schema: ZodType<T>, text: string): { ok: true; data: T } | { ok: false; problems: string[] } {
    let json: unknown;
    try { json = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); }
    catch { return { ok: false, problems: ['output is not valid JSON'] }; }
    const r = schema.safeParse(json);
    if (r.success) return { ok: true, data: r.data };
    return { ok: false, problems: r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`) };
  }

  private limiterFor(config: LlmConfig): RateLimiter {
    if (!this.limiter || this.limiterRate !== config.ratePerHour) { this.limiter = new RateLimiter(config.ratePerHour, 3_600_000, this.now); this.limiterRate = config.ratePerHour; }
    return this.limiter;
  }

  private budgetFor(config: LlmConfig): MonthlyBudget {
    const key = `${config.monthlyBudgetUsd}|${config.priceInputPerMillionUsd}|${config.priceOutputPerMillionUsd}`;
    if (!this.budget || this.budgetKey !== key) {
      this.budget = new MonthlyBudget(config.monthlyBudgetUsd, config.priceInputPerMillionUsd, config.priceOutputPerMillionUsd, () => new Date(this.now()));
      this.budgetKey = key;
    }
    return this.budget;
  }

  /** Log line: feature, hashed user, latency, tokens, outcome, error code. NEVER a prompt, an output or a personal value. */
  private line(fields: { feature: string; user: string; ms: number; tokensIn: number; tokensOut: number; outcome: string; errorCode?: string }): string {
    return `[LLM] feature=${fields.feature} user=${fields.user} ms=${fields.ms} tokensIn=${fields.tokensIn} tokensOut=${fields.tokensOut} outcome=${fields.outcome}${fields.errorCode ? ` errorCode=${fields.errorCode}` : ''}`;
  }
}

export const llmClient = new LlmClient();
