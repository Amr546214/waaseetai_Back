import { createHash } from 'node:crypto';

/**
 * "Recognised origins" of an account: where it COMPLETED a login (password + e-mail code) within the last `ttlMs`. An origin is the
 * client network (IPv4 /24, IPv6 /56 — from the trusted `req.ip` only) plus a short hash of the coarse user-agent class (digits stripped,
 * so browser updates do not forget it). A recognised origin is never slowed by the per-account global layer of password login; it still
 * obeys its own per-(account, address) bucket and the OTP step.
 *
 * Why only after the second step: a correct password alone proves nothing (the e-mail code is still required), so an attacker who guesses
 * the password does not become "recognised". The password step only leaves a short-lived pending link (userId -> account + origin); the
 * verify-otp step turns it into recognition when it succeeds from the same origin.
 *
 * Keyed by account, so one account's success never whitelists another. Bounded: `maxAccounts` accounts (LRU) x `perAccount` origins
 * (oldest dropped), `maxPending` pending links. Per process, lost on restart (back to the slower default for every origin).
 */
export interface RecognisedOptions {
  ttlMs: number;
  maxAccounts?: number;
  perAccount?: number;
  maxPending?: number;
  pendingTtlMs?: number;
  now?: () => number;
}

export const originNet = (ip: string): string => {
  const v4 = /^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(ip);
  return v4 ? `${v4[1]}.0/24` : ip; // IPv6 arrives already collapsed to its /56 (ipKeyGenerator)
};

export const userAgentClass = (ua: string | undefined): string =>
  createHash('sha256').update((ua ?? '').toLowerCase().replace(/[\d._]+/g, '').slice(0, 160)).digest('hex').slice(0, 8);

export const originKey = (ip: string, ua: string | undefined): string => `${originNet(ip)}|${userAgentClass(ua)}`;

export class RecognisedOrigins {
  private readonly accounts = new Map<string, Map<string, number>>();
  private readonly pending = new Map<string, { account: string; origin: string; until: number }>();
  private readonly maxAccounts: number;
  private readonly perAccount: number;
  private readonly maxPending: number;
  private readonly pendingTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly o: RecognisedOptions) {
    this.maxAccounts = Math.max(1, o.maxAccounts ?? 20_000);
    this.perAccount = Math.max(1, o.perAccount ?? 8);
    this.maxPending = Math.max(1, o.maxPending ?? 20_000);
    this.pendingTtlMs = o.pendingTtlMs ?? 15 * 60_000;
    this.now = o.now ?? Date.now;
  }

  get size(): number { return this.accounts.size; }
  get pendingSize(): number { return this.pending.size; }

  has(account: string, origin: string): boolean {
    const origins = this.accounts.get(account);
    const until = origins?.get(origin);
    return until !== undefined && until > this.now();
  }

  remember(account: string, origin: string): void {
    let origins = this.accounts.get(account);
    if (origins) this.accounts.delete(account); // LRU re-insert
    else {
      if (this.accounts.size >= this.maxAccounts) this.accounts.delete(this.accounts.keys().next().value as string);
      origins = new Map();
    }
    const t = this.now();
    for (const [k, until] of origins) if (until <= t) origins.delete(k);
    origins.delete(origin);
    origins.set(origin, t + this.o.ttlMs);
    while (origins.size > this.perAccount) origins.delete(origins.keys().next().value as string);
    this.accounts.set(account, origins);
  }

  /** Password step succeeded for `account` from `origin`; the challenge is identified by the user id the response carries. */
  noteChallenge(userId: string, account: string, origin: string): void {
    this.pending.delete(userId);
    if (this.pending.size >= this.maxPending) {
      const t = this.now();
      for (const [k, p] of this.pending) if (p.until <= t) this.pending.delete(k);
      if (this.pending.size >= this.maxPending) this.pending.delete(this.pending.keys().next().value as string);
    }
    this.pending.set(userId, { account, origin, until: this.now() + this.pendingTtlMs });
  }

  /** The second step succeeded for `userId` from `origin`: recognise it for the account that started the challenge from that same origin. */
  confirm(userId: string, origin: string): boolean {
    const p = this.pending.get(userId);
    if (!p || p.until <= this.now() || p.origin !== origin) return false;
    this.pending.delete(userId);
    this.remember(p.account, origin);
    return true;
  }

  reset(): void { this.accounts.clear(); this.pending.clear(); }
}
