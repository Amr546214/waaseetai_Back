-- NOT EXECUTED. Requires the lead's authorization. Optional shared counter table for the strict rate-limit tiers (RATE_LIMIT_STORE=postgres).
-- Additive and idempotent: one new table, no change to any existing table or row. The backend does not read it unless the flag is set.
-- UNLOGGED: counters are disposable (a crash may empty them, which only resets a window), and it avoids WAL traffic on every hit.
CREATE UNLOGGED TABLE IF NOT EXISTS "rate_limit_counters" (
  "key"      TEXT        NOT NULL PRIMARY KEY,
  "hits"     INTEGER     NOT NULL,
  "reset_at" TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS "rate_limit_counters_reset_at_idx" ON "rate_limit_counters" ("reset_at");
