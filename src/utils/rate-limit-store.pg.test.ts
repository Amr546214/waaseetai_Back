import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

/**
 * REAL PostgreSQL test of the optional shared counter store (RATE_LIMIT_STORE=postgres) and its NOT EXECUTED migration.
 * Runs ONLY against the isolated local database (QA_ISOLATED_PG_URL must equal DATABASE_URL and point at :55432), else it is skipped.
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_t6 npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL node --import tsx --experimental-test-module-mocks --test src/utils/rate-limit-store.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

async function withStore<T>(fn: (store: any, prisma: any) => Promise<T>): Promise<T> {
  const { prisma } = await import('../config/db');
  const { PostgresRateLimitStore } = await import('./rate-limit-store');
  const store = new PostgresRateLimitStore(`t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, prisma as any, 0);
  store.init({ windowMs: 60000 });
  try { return await fn(store, prisma); } finally { await (prisma as any).$disconnect?.(); }
}

test('increment is atomic across concurrent callers (two "processes" share one counter)', opts, async () => {
  await withStore(async (store) => {
    const results = await Promise.all(Array.from({ length: 25 }, () => store.increment('k')));
    assert.deepEqual(results.map((r: any) => r.totalHits).sort((a: number, b: number) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.ok(results[0].resetTime.getTime() > Date.now());
  });
});

test('the window expires and restarts at 1; decrement and resetKey work; keys are isolated by prefix', opts, async () => {
  await withStore(async (store) => {
    store.init({ windowMs: 300 });
    assert.equal((await store.increment('a')).totalHits, 1);
    assert.equal((await store.increment('a')).totalHits, 2);
    await store.decrement('a');
    assert.equal((await store.get('a')).totalHits, 1);
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(await store.get('a'), undefined, 'expired');
    assert.equal((await store.increment('a')).totalHits, 1, 'fresh window');
    await store.resetKey('a');
    assert.equal(await store.get('a'), undefined);
    assert.equal((await store.increment('b')).totalHits, 1);
  });
});

test('migration: idempotent, additive; rollback refuses while live counters exist and drops the table when empty', opts, async () => {
  const c = new Client({ connectionString: URL }); await c.connect();
  try {
    const mig = readFileSync('prisma/migrations/20261018060000_rate_limit_counter/migration.sql', 'utf8');
    const rb = readFileSync('prisma/migrations/20261018060000_rate_limit_counter/rollback.sql', 'utf8');
    await c.query('DROP TABLE IF EXISTS "rate_limit_counters"');
    await c.query(mig); await c.query(mig); // twice: harmless
    assert.equal((await c.query(`SELECT to_regclass('public.rate_limit_counters') AS t`)).rows[0].t, 'rate_limit_counters');
    await c.query(`INSERT INTO rate_limit_counters VALUES ('live', 3, now() + interval '1 hour')`);
    await assert.rejects(c.query(rb), /ROLLBACK REFUSED: 1 live/);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM rate_limit_counters')).rows[0].n, 1, 'nothing dropped');
    await c.query('DELETE FROM rate_limit_counters');
    await c.query(rb);
    assert.equal((await c.query(`SELECT to_regclass('public.rate_limit_counters') AS t`)).rows[0].t, null);
    await c.query(mig); // leave the table for the other tests
  } finally { await c.end(); }
});

test('two limiter instances ("two containers") on one shared store enforce ONE limit', opts, async () => {
  const { prisma } = await import('../config/db');
  const { PostgresRateLimitStore } = await import('./rate-limit-store');
  const { default: rateLimit } = await import('express-rate-limit');
  const prefix = `shared${Date.now()}`;
  const make = () => rateLimit({ windowMs: 60000, limit: 3, store: new PostgresRateLimitStore(prefix, prisma as any, 0), keyGenerator: () => 'same', validate: false, handler: (_q, _r, next) => next(new Error('limited')) });
  const a = make(); const b = make();
  const run = (l: any) => new Promise<string>((resolve) => l({ ip: '1.1.1.1', headers: {}, app: { get: () => false } }, { setHeader() {}, getHeader() {}, locals: {} }, (e?: Error) => resolve(e ? 'blocked' : 'ok')));
  assert.deepEqual([await run(a), await run(b), await run(a), await run(b), await run(a)], ['ok', 'ok', 'ok', 'blocked', 'blocked']);
});
