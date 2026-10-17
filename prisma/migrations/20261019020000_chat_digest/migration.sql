-- NOT EXECUTED. Requires the owner's authorization. Chat e-mail digest bookkeeping (CHAT_DIGEST_EMAIL_ENABLED stays off until the flag is set).
-- Additive and idempotent: two new tables, no change to any existing table or row.
CREATE TABLE IF NOT EXISTS "chat_digest_state" (
  "user_id"         TEXT        NOT NULL,
  "conversation_id" TEXT        NOT NULL,
  "last_digest_at"  TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "chat_digest_state_pkey" PRIMARY KEY ("user_id", "conversation_id")
);
CREATE INDEX IF NOT EXISTS "chat_digest_state_user_id_last_digest_at_idx" ON "chat_digest_state" ("user_id", "last_digest_at");
CREATE TABLE IF NOT EXISTS "chat_digest_activation" (
  "id"         TEXT        NOT NULL DEFAULT 'default',
  "enabled_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "chat_digest_activation_pkey" PRIMARY KEY ("id")
);
