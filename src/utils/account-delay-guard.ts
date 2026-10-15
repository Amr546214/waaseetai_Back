/**
 * Progressive DELAY (tarpit) for the per-account, all-addresses layer of password login. It never locks: it only spaces out attempts that
 * come from origins the account does not recognise. Per account (key = normalised email) inside a 24 h window:
 *  - the first `free` attempts are admitted back to back (the address-level buckets still apply);
 *  - after that every attempt must wait for a gap after the previous admitted one: `base`, repeated `stepEvery` times, then doubled, ... up to `ceiling`;
 *  - an attempt that arrives inside the gap is REJECTED WITHOUT changing anything (rejected requests never extend the wait, so an attacker
 *    hammering the endpoint cannot push the owner's wait further out than the schedule itself);
 *  - an admitted attempt that ends in success is handed back (`refund`).
 * Worst case with defaults (free 10, base 30 s, step 3, ceiling 900 s): about 10 + 15 + 92 = ~117 (computed in the tests) admitted attempts per 24 h for the whole
 * account, from any number of addresses. State is per process and lost on restart (back to the same slow default, never to "open").
 * Bounded: at most `maxKeys` accounts; when full, expired entries go first, then the least-recently-used one that is not currently in a gap.
 */
export interface AccountDelayOptions {
  free: number;
  baseMs: number;
  ceilingMs: number;
  stepEvery?: number;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
}

interface DelayState { fails: number; windowStart: number; nextAt: number }

export type AdmitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

export class AccountDelayGuard {
  private readonly map = new Map<string, DelayState>();
  private readonly stepEvery: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(private readonly o: AccountDelayOptions) {
    this.stepEvery = Math.max(1, o.stepEvery ?? 3);
    this.windowMs = o.windowMs ?? 24 * 3600_000;
    this.maxKeys = Math.max(1, o.maxKeys ?? 20_000);
    this.now = o.now ?? Date.now;
  }

  get size(): number { return this.map.size; }

  private makeRoom(): void {
    if (this.map.size < this.maxKeys) return;
    const t = this.now();
    for (const [k, s] of this.map) if (t - s.windowStart >= this.windowMs) this.map.delete(k);
    if (this.map.size < this.maxKeys) return;
    for (const k of this.map.keys()) { // recency order
      if ((this.map.get(k) as DelayState).nextAt <= t) { this.map.delete(k); return; }
    }
    const oldest = this.map.keys().next().value;
    if (oldest !== undefined) this.map.delete(oldest);
  }

  /** Gap that follows the n-th admitted attempt of the window (n counts from 1; none before the `free`-th, which opens the first gap). */
  gapAfter(n: number): number {
    if (n < this.o.free) return 0;
    const k = Math.floor((n - this.o.free) / this.stepEvery);
    return Math.min(this.o.baseMs * 2 ** Math.min(k, 30), this.o.ceilingMs);
  }

  admit(key: string): AdmitResult {
    const t = this.now();
    let s = this.map.get(key);
    if (s && t - s.windowStart >= this.windowMs) { this.map.delete(key); s = undefined; }
    if (s && t < s.nextAt) return { allowed: false, retryAfterMs: s.nextAt - t };
    if (s) this.map.delete(key); // re-insert: LRU order
    else { this.makeRoom(); s = { fails: 0, windowStart: t, nextAt: 0 }; }
    s.fails += 1;
    s.nextAt = t + this.gapAfter(s.fails);
    this.map.set(key, s);
    return { allowed: true };
  }

  /** The admitted attempt succeeded: it does not count. */
  refund(key: string): void {
    const s = this.map.get(key);
    if (!s || s.fails <= 0) return;
    s.fails -= 1;
    s.nextAt = Math.min(s.nextAt, this.now());
  }

  reset(): void { this.map.clear(); }
}
