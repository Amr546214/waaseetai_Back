-- NOT EXECUTED. Requires the lead's authorization. Additive and idempotent: one new table, no change to any existing table or row.
-- Shared state of the configurable login protection (failed credential attempts per address+account pair and per address, and the temporary blocks they cause).
-- LOGGED on purpose: an active block must survive a database restart. The backend fails OPEN (logs, lets the request reach the normal checks) while the table is missing.
CREATE TABLE IF NOT EXISTS "login_guard_state" (
  "key"           TEXT        NOT NULL PRIMARY KEY,           -- 'p:<ip>|<sha256(email)>' (address + account) or 'i:<ip>' (address, all accounts)
  "scope"         TEXT        NOT NULL CHECK ("scope" IN ('PAIR', 'IP')),
  "ip"            TEXT        NOT NULL,
  "subject_hint"  TEXT,                                       -- masked e-mail for the admin list only (never the full address, never a password)
  "fails"         INTEGER     NOT NULL DEFAULT 0,
  "window_start"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_fail_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "blocked_until" TIMESTAMPTZ,
  "unblocked_by"  TEXT,
  "unblocked_at"  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "login_guard_state_blocked_idx" ON "login_guard_state" ("blocked_until") WHERE "blocked_until" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "login_guard_state_ip_idx" ON "login_guard_state" ("ip");
