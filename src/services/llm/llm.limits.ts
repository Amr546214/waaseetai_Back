import { createHash } from 'node:crypto';

// In-memory guards: per user+feature rate limit, in-flight lock, monthly token/cost breaker, short-lived LRU cache.
// Everything here lives in process memory only (lost on restart); nothing is written to the database.

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Records a call and returns true when allowed. */
  tryAcquire(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

export class InFlightLock {
  private active = new Set<string>();
  acquire(key: string): boolean { if (this.active.has(key)) return false; this.active.add(key); return true; }
  release(key: string): void { this.active.delete(key); }
}

export class MonthlyBudget {
  private month = '';
  private spentUsd = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  constructor(
    private readonly limitUsd: number | null,
    private readonly priceIn: number | null,
    private readonly priceOut: number | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private roll(): void {
    const d = this.now();
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (key !== this.month) { this.month = key; this.spentUsd = 0; this.tokensIn = 0; this.tokensOut = 0; }
  }

  /** True while the breaker is still closed. Disabled (always true) when no limit is configured. */
  allows(): boolean { this.roll(); return this.limitUsd === null || this.spentUsd < this.limitUsd; }

  record(tokensIn: number, tokensOut: number): void {
    this.roll();
    this.tokensIn += tokensIn; this.tokensOut += tokensOut;
    if (this.priceIn !== null && this.priceOut !== null) this.spentUsd += (tokensIn * this.priceIn + tokensOut * this.priceOut) / 1_000_000;
  }

  snapshot() { this.roll(); return { spentUsd: this.spentUsd, tokensIn: this.tokensIn, tokensOut: this.tokensOut }; }
}

/** Small LRU with TTL. Keys are hashes; values are the already-validated, already-grounded results. */
export class TtlLru<V> {
  private map = new Map<string, { value: V; expires: number }>();
  constructor(private readonly max = 200, private readonly now: () => number = Date.now) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) { this.map.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e); // refresh recency
    return e.value;
  }
  set(key: string, value: V, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size(): number { return this.map.size; }
}

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');
export const userHash = (userId: string): string => hashOf(`u:${userId}`).slice(0, 12);

/** Stable JSON (sorted keys) for cache keys. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
