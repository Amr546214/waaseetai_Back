-- Additive and idempotent: one new LOGGED table (durable), no change to any existing table or row. The e-mail address is stored only as a hash.
CREATE TABLE IF NOT EXISTS "registration_email_proofs" (
  "nonce"         TEXT         NOT NULL PRIMARY KEY,
  "email_hash"    TEXT         NOT NULL,
  "wrong_attempts" INTEGER     NOT NULL DEFAULT 0,
  "data_tries"    INTEGER      NOT NULL DEFAULT 0,
  "consumed_at"   TIMESTAMPTZ(3),
  "expires_at"    TIMESTAMPTZ(3) NOT NULL,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "registration_email_proofs_expires_at_idx" ON "registration_email_proofs" ("expires_at");
