import type { ClientRateLimitInfo, Store } from 'express-rate-limit';
import { logger } from '../config/logger';

/**
 * Counter store behind the strict rate-limit tiers.
 *
 * Default = express-rate-limit's built-in MemoryStore (one per limiter, per process). That is exact for the current deployment (one API
 * container, see compose.yaml) and resets on restart. With several processes / containers the effective limit becomes N x the configured
 * one: set RATE_LIMIT_STORE=postgres (after the optional migration 20261018060000_rate_limit_counter is applied) to share the strict tiers
 * through the database. The high-volume browse/write tiers always stay in memory (a database write per page view would cost more than it
 * protects). A shared Redis store is the other option; any object implementing express-rate-limit's `Store` plugs in the same way
 * (see `createStrictStore`).
 */
export interface SqlRunner {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export class PostgresRateLimitStore implements Store {
  private windowMs = 60_000;
  private sweeper?: NodeJS.Timeout;
  readonly localKeys = false;

  constructor(readonly prefix: string, private readonly db: SqlRunner, private readonly sweepEveryMs = 10 * 60_000) {}

  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
    if (this.sweepEveryMs > 0 && !this.sweeper) {
      this.sweeper = setInterval(() => {
        this.db.$executeRawUnsafe('DELETE FROM "rate_limit_counters" WHERE "reset_at" < now() - interval \'1 minute\'').catch(() => undefined);
      }, this.sweepEveryMs);
      this.sweeper.unref?.();
    }
  }

  private k(key: string): string { return `${this.prefix}:${key}`; }

  /** One atomic statement: a fresh window when the row expired, else hits + 1. */
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const rows = await this.db.$queryRawUnsafe<Array<{ hits: number; reset_at: Date }>>(
      `INSERT INTO "rate_limit_counters" ("key","hits","reset_at") VALUES ($1, 1, now() + ($2::int * interval '1 millisecond'))
       ON CONFLICT ("key") DO UPDATE SET
         "hits" = CASE WHEN "rate_limit_counters"."reset_at" <= now() THEN 1 ELSE "rate_limit_counters"."hits" + 1 END,
         "reset_at" = CASE WHEN "rate_limit_counters"."reset_at" <= now() THEN EXCLUDED."reset_at" ELSE "rate_limit_counters"."reset_at" END
       RETURNING "hits", "reset_at"`,
      this.k(key), this.windowMs
    );
    return { totalHits: Number(rows[0].hits), resetTime: new Date(rows[0].reset_at) };
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const rows = await this.db.$queryRawUnsafe<Array<{ hits: number; reset_at: Date }>>(
      'SELECT "hits","reset_at" FROM "rate_limit_counters" WHERE "key" = $1 AND "reset_at" > now()', this.k(key));
    return rows[0] ? { totalHits: Number(rows[0].hits), resetTime: new Date(rows[0].reset_at) } : undefined;
  }

  async decrement(key: string): Promise<void> {
    await this.db.$executeRawUnsafe('UPDATE "rate_limit_counters" SET "hits" = GREATEST("hits" - 1, 0) WHERE "key" = $1', this.k(key));
  }

  async resetKey(key: string): Promise<void> {
    await this.db.$executeRawUnsafe('DELETE FROM "rate_limit_counters" WHERE "key" = $1', this.k(key));
  }

  shutdown(): void { if (this.sweeper) clearInterval(this.sweeper); }
}

/** `undefined` = the limiter keeps its own in-memory store. */
export function createStrictStore(tier: string, env: NodeJS.ProcessEnv = process.env): Store | undefined {
  if ((env.RATE_LIMIT_STORE || 'memory').toLowerCase() !== 'postgres') return undefined;
  try {
    // required lazily: the memory default must not open a database pool just by loading the limiter module
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prisma } = require('../config/db') as { prisma: SqlRunner };
    return new PostgresRateLimitStore(tier, prisma);
  } catch (e) {
    logger.error(`[rate-limit] RATE_LIMIT_STORE=postgres could not be initialised for "${tier}", using memory: ${(e as Error).message}`);
    return undefined;
  }
}
