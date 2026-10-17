import type { ClientRateLimitInfo, Store } from 'express-rate-limit';

/**
 * In-memory counter store for the pre-authentication tiers (login, OTP verify). Differences from express-rate-limit's MemoryStore:
 *  - bounded: at most `maxKeys` live keys. Identifier keys come from the request body, so without a cap a caller could grow the map
 *    without limit. When full, expired keys go first, then the least-recently-used key that is NOT locked out (a locked key is evicted
 *    only if every key is locked), so flooding fresh identifiers cannot wash away an active lockout;
 *  - progressive lockout: the first time a key goes over `limit` inside a window that is a "strike". Strike 1 locks until the window ends
 *    (normal behaviour); strike 2 extends the lock to 2 windows, strike 3 to 4, ... up to `maxMultiplier` windows. Strikes are forgotten
 *    after `strikeMemoryMs` without a new strike. Retry-After (taken from the returned resetTime) tells the truth about the longer wait.
 * Counters are per process and reset on restart, exactly like the default store (one api container today).
 */
export interface BoundedStoreOptions {
  limit: number;
  maxKeys?: number;
  /** Progressive lockout cap, in windows (1 = no escalation). */
  maxMultiplier?: number;
  strikeMemoryMs?: number;
  now?: () => number;
}

interface Entry { hits: number; resetAt: number; strikes: number; strikeUntil: number; locked: boolean }

export class BoundedRateLimitStore implements Store {
  private windowMs = 60_000;
  private readonly map = new Map<string, Entry>();
  private readonly maxKeys: number;
  private readonly maxMultiplier: number;
  private readonly strikeMemoryMs: number;
  private readonly now: () => number;
  private sweeper?: NodeJS.Timeout;
  readonly localKeys = true;

  constructor(private readonly opts: BoundedStoreOptions) {
    this.maxKeys = Math.max(1, opts.maxKeys ?? 20_000);
    this.maxMultiplier = Math.max(1, opts.maxMultiplier ?? 1);
    this.strikeMemoryMs = opts.strikeMemoryMs ?? 24 * 3600_000;
    this.now = opts.now ?? Date.now;
  }

  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), Math.min(this.windowMs, 5 * 60_000));
      this.sweeper.unref?.();
    }
  }

  /** number of live keys (tests / diagnostics) */
  get size(): number { return this.map.size; }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.map) if (e.resetAt <= t && e.strikeUntil <= t) this.map.delete(k);
  }

  private makeRoom(): void {
    if (this.map.size < this.maxKeys) return;
    this.sweep();
    if (this.map.size < this.maxKeys) return;
    const t = this.now();
    let oldestLocked: string | undefined;
    for (const [k, e] of this.map) { // Map iterates in recency order (touched keys are re-inserted last)
      if (!(e.locked && e.resetAt > t)) { this.map.delete(k); return; }
      oldestLocked ??= k;
    }
    if (oldestLocked !== undefined) this.map.delete(oldestLocked);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const t = this.now();
    let e = this.map.get(key);
    if (e) this.map.delete(key); // re-inserted below: LRU order
    if (!e || e.resetAt <= t) {
      const strikes = e && e.strikeUntil > t ? e.strikes : 0;
      const strikeUntil = e && e.strikeUntil > t ? e.strikeUntil : 0;
      if (!e) this.makeRoom();
      e = { hits: 0, resetAt: t + this.windowMs, strikes, strikeUntil, locked: false };
    }
    e.hits += 1;
    if (e.hits > this.opts.limit && !e.locked) {
      e.locked = true;
      e.strikes += 1;
      e.strikeUntil = t + this.strikeMemoryMs;
      const multiplier = Math.min(2 ** (e.strikes - 1), this.maxMultiplier);
      if (multiplier > 1) e.resetAt = t + this.windowMs * multiplier;
    }
    this.map.set(key, e);
    return { totalHits: e.hits, resetTime: new Date(e.resetAt) };
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const e = this.map.get(key);
    return e && e.resetAt > this.now() ? { totalHits: e.hits, resetTime: new Date(e.resetAt) } : undefined;
  }

  async decrement(key: string): Promise<void> {
    const e = this.map.get(key);
    if (e && !e.locked && e.hits > 0) e.hits -= 1; // a locked key stays locked
  }

  async resetKey(key: string): Promise<void> { this.map.delete(key); }
  async resetAll(): Promise<void> { this.map.clear(); }
  shutdown(): void { if (this.sweeper) clearInterval(this.sweeper); }
}
