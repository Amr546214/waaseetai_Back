import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { Pool } from 'pg';
import { LlmError, LlmErrorCode } from './llm.errors';

export interface DurableLlmReservation {
  userId: string;
  feature: string;
  ratePerHour: number;
  monthlyBudgetUsd: number | null;
  priceInputPerMillionUsd: number | null;
  priceOutputPerMillionUsd: number | null;
  /** Upper bounds for ALL provider calls, including retries and JSON repair. */
  maxTokensIn: number;
  maxTokensOut: number;
  leaseMs: number;
}

export interface DurableLlmUsage {
  tokensIn: number;
  tokensOut: number;
  measured: boolean;
  attempted: boolean;
}

export interface DurableLlmGuard {
  reserve(request: DurableLlmReservation): Promise<{ id: string }>;
  settle(id: string, usage: DurableLlmUsage): Promise<void>;
  close(): Promise<void>;
}

type Row = Record<string, unknown>;
interface Transaction { query(sql: string, params?: Array<string | number | null>): Promise<Row[]> }
interface GuardDatabase { transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>; close(): Promise<void> }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS waseet_llm_reservations (
  id TEXT PRIMARY KEY,
  actor_hash TEXT NOT NULL,
  feature TEXT NOT NULL,
  month_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  lease_expires_at BIGINT NOT NULL,
  status TEXT NOT NULL,
  reserved_tokens_in BIGINT NOT NULL,
  reserved_tokens_out BIGINT NOT NULL,
  tokens_in BIGINT NOT NULL,
  tokens_out BIGINT NOT NULL,
  price_in DOUBLE PRECISION,
  price_out DOUBLE PRECISION,
  cost_micros BIGINT NOT NULL,
  measured INTEGER NOT NULL DEFAULT 0,
  attempted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS waseet_llm_actor_rate ON waseet_llm_reservations(actor_hash,feature,created_at);
CREATE INDEX IF NOT EXISTS waseet_llm_month_budget ON waseet_llm_reservations(month_key);
`;

/** Serialize local connections to avoid an async callback holding SQLite's lock
 * while another connection blocks the same Node event loop. Separate processes
 * share SQLite's normal BEGIN IMMEDIATE lock and busy timeout. */
const sqliteQueues = new Map<string, Promise<unknown>>();
class SqliteGuardDatabase implements GuardDatabase {
  private readonly database: SqliteDatabase;
  constructor(private readonly filename: string) {
    // Production PostgreSQL does not require the optional local SQLite runtime.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    mkdirSync(dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.database.exec(SCHEMA);
  }
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const previous = sqliteQueues.get(this.filename) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = await work({ query: async (sql, params = []) => {
          const values: Array<string | number | null> = [];
          const sqliteSql = sql.replace(/\$(\d+)/g, (_, index) => { values.push(params[Number(index) - 1]); return '?'; });
          const statement = this.database.prepare(sqliteSql);
          if (/^\s*SELECT\b/i.test(sqliteSql)) return statement.all(...values) as Row[];
          statement.run(...values); return [];
        } });
        this.database.exec('COMMIT'); return result;
      } catch (error) { try { this.database.exec('ROLLBACK'); } catch {} throw error; }
    });
    sqliteQueues.set(this.filename, running);
    try { return await running; } finally { if (sqliteQueues.get(this.filename) === running) sqliteQueues.delete(this.filename); }
  }
  async close(): Promise<void> { await sqliteQueues.get(this.filename)?.catch(() => {}); this.database.close(); }
}

class PostgresGuardDatabase implements GuardDatabase {
  private readonly pool: Pool;
  private initialized = false;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 }); }
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SET LOCAL lock_timeout = '5s'");
      await connection.query("SET LOCAL statement_timeout = '10s'");
      // All replicas use one brief database transaction for the global cap.
      await connection.query('SELECT pg_advisory_xact_lock(1463899717, 1279872333)');
      if (!this.initialized) await connection.query(SCHEMA);
      const result = await work({ query: async (sql, params = []) => (await connection.query(sql, params)).rows });
      await connection.query('COMMIT'); this.initialized = true; return result;
    } catch (error) { try { await connection.query('ROLLBACK'); } catch {} throw error; }
    finally { connection.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export type DurableLlmGuardOptions =
  | { driver: 'sqlite'; filename: string; now?: () => number }
  | { driver: 'postgres'; connectionString: string; now?: () => number };

const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validTokens = (value: unknown): value is number => finiteNonnegative(value) && Number.isSafeInteger(value) && value <= 100_000_000;
const integer = (value: unknown): number => Number(value) || 0;
const costMicros = (tokensIn: number, tokensOut: number, priceIn: number | null, priceOut: number | null): number =>
  Math.ceil(tokensIn * (priceIn ?? 0) + tokensOut * (priceOut ?? 0));

/** Durable metadata only: actor hashes, limits and usage. Never prompts, outputs or credentials. */
export class DurableLlmLimits implements DurableLlmGuard {
  private readonly database: GuardDatabase;
  private readonly now: () => number;
  constructor(options: DurableLlmGuardOptions) {
    this.now = options.now ?? Date.now;
    try {
      this.database = options.driver === 'sqlite'
        ? new SqliteGuardDatabase(resolve(options.filename))
        : new PostgresGuardDatabase(options.connectionString);
    } catch { throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'durable guard unavailable'); }
  }

  async reserve(request: DurableLlmReservation): Promise<{ id: string }> {
    const pricesValid = [request.priceInputPerMillionUsd, request.priceOutputPerMillionUsd].every(value => value === null || finiteNonnegative(value));
    if (!request.userId || !request.feature || request.feature.length > 160 || !Number.isSafeInteger(request.ratePerHour) || request.ratePerHour < 0 ||
      !validTokens(request.maxTokensIn) || !validTokens(request.maxTokensOut) || !finiteNonnegative(request.leaseMs) || request.leaseMs < 1000 || request.leaseMs > 300_000 || !pricesValid ||
      (request.monthlyBudgetUsd !== null && (!finiteNonnegative(request.monthlyBudgetUsd) || request.priceInputPerMillionUsd === null || request.priceOutputPerMillionUsd === null))) {
      throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'invalid durable guard policy');
    }
    const now = this.now(), month = new Date(now).toISOString().slice(0, 7);
    const actor = createHash('sha256').update(`waseet-llm:${request.userId}`).digest('hex');
    const reservedCost = costMicros(request.maxTokensIn, request.maxTokensOut, request.priceInputPerMillionUsd, request.priceOutputPerMillionUsd);
    if (!Number.isSafeInteger(reservedCost)) throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'invalid budget bound');
    return this.protected(async () => this.database.transaction(async tx => {
      // A crashed or interrupted process may have spent its entire reservation.
      // Expired leases unlock concurrency but retain their conservative charge.
      await tx.query("UPDATE waseet_llm_reservations SET status='expired',attempted=1 WHERE status='pending' AND lease_expires_at <= $1", [now]);
      const active = await tx.query("SELECT COUNT(*) AS count FROM waseet_llm_reservations WHERE actor_hash=$1 AND feature=$2 AND status='pending' AND lease_expires_at > $3", [actor, request.feature, now]);
      if (integer(active[0]?.count)) throw new LlmError(LlmErrorCode.BUSY, 'concurrent feature call');
      const hits = await tx.query('SELECT COUNT(*) AS count FROM waseet_llm_reservations WHERE actor_hash=$1 AND feature=$2 AND created_at > $3', [actor, request.feature, now - 3_600_000]);
      if (integer(hits[0]?.count) >= request.ratePerHour) throw new LlmError(LlmErrorCode.RATE_LIMITED, 'durable user rate limit');
      if (request.monthlyBudgetUsd !== null) {
        const spent = await tx.query('SELECT COALESCE(SUM(cost_micros),0) AS cost FROM waseet_llm_reservations WHERE month_key=$1', [month]);
        if (integer(spent[0]?.cost) + reservedCost > Math.floor(request.monthlyBudgetUsd * 1_000_000)) throw new LlmError(LlmErrorCode.BUDGET_EXCEEDED, 'monthly reservation cap');
      }
      const id = randomUUID();
      await tx.query(`INSERT INTO waseet_llm_reservations(id,actor_hash,feature,month_key,created_at,lease_expires_at,status,reserved_tokens_in,reserved_tokens_out,tokens_in,tokens_out,price_in,price_out,cost_micros,measured,attempted)
        VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,0,0,$9,$10,$11,0,0)`, [id, actor, request.feature, month, now, now + request.leaseMs, request.maxTokensIn, request.maxTokensOut, request.priceInputPerMillionUsd, request.priceOutputPerMillionUsd, reservedCost]);
      return { id };
    }));
  }

  async settle(id: string, usage: DurableLlmUsage): Promise<void> {
    if (!validTokens(usage.tokensIn) || !validTokens(usage.tokensOut) || typeof usage.measured !== 'boolean' || typeof usage.attempted !== 'boolean') throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'invalid usage settlement');
    await this.protected(async () => this.database.transaction(async tx => {
      const rows = await tx.query('SELECT * FROM waseet_llm_reservations WHERE id=$1', [id]);
      const row = rows[0]; if (!row || row.status === 'settled') return;
      const input = !usage.attempted ? 0 : usage.measured ? usage.tokensIn : Math.max(usage.tokensIn, integer(row.reserved_tokens_in));
      const output = !usage.attempted ? 0 : usage.measured ? usage.tokensOut : Math.max(usage.tokensOut, integer(row.reserved_tokens_out));
      const priceIn = row.price_in === null ? null : Number(row.price_in), priceOut = row.price_out === null ? null : Number(row.price_out);
      const cost = costMicros(input, output, priceIn, priceOut);
      if (!Number.isSafeInteger(cost)) throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'invalid measured cost');
      await tx.query("UPDATE waseet_llm_reservations SET status='settled',tokens_in=$1,tokens_out=$2,cost_micros=$3,measured=$4,attempted=$5 WHERE id=$6 AND status <> 'settled'", [input, output, cost, usage.measured ? 1 : 0, usage.attempted ? 1 : 0, id]);
    }));
  }

  async close(): Promise<void> { await this.database.close(); }
  private async protected<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) { if (error instanceof LlmError) throw error; throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'durable guard transaction failed'); }
  }
}

const guards = new Map<string, DurableLlmGuard>();
export function getDurableLlmGuard(env: NodeJS.ProcessEnv = process.env): DurableLlmGuard {
  const driver = env.WASEET_AI_DURABLE_GUARDS || (env.NODE_ENV === 'production' ? 'postgres' : 'sqlite');
  if (driver !== 'sqlite' && driver !== 'postgres') throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'durable guards not configured');
  if (env.NODE_ENV === 'production' && driver === 'sqlite') throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'shared production guards required');
  const location = driver === 'sqlite' ? join(resolve(env.WASEET_AI_STATE_DIR || join(process.cwd(),'work','state')), 'llm-guards.sqlite') : env.DATABASE_URL || '';
  if (!location) throw new LlmError(LlmErrorCode.PROVIDER_UNAVAILABLE, 'shared guard database missing');
  const key = createHash('sha256').update(`${driver}:${location}`).digest('hex');
  let guard = guards.get(key);
  if (!guard) { guard = new DurableLlmLimits(driver === 'sqlite' ? {driver,filename:location} : {driver,connectionString:location}); guards.set(key,guard); }
  return guard;
}
