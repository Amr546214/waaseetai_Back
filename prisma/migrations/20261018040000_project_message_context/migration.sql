-- NOT EXECUTED. Requires the owner's approval (see docs/proposals/project-message-context-migration-preview.md).
-- Additive and idempotent: nothing is moved, rewritten or deleted. Every existing conversation becomes kind = 'GENERAL' with a NULL contract_id,
-- i.e. it stays exactly where it is today; no message row is touched. The BE works correctly before and after any (separately approved) backfill.
DO $$ BEGIN
  CREATE TYPE "ConversationKind" AS ENUM ('GENERAL', 'PROJECT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "kind" "ConversationKind" NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "contract_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_contract_id_key" ON "conversations"("contract_id");
CREATE INDEX IF NOT EXISTS "conversations_client_id_kind_idx" ON "conversations"("client_id", "kind");
CREATE INDEX IF NOT EXISTS "conversations_provider_id_kind_idx" ON "conversations"("provider_id", "kind");
DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Project event messages (amendment created / accepted / rejected / cancelled / funding authorised / applied): one row per deterministic event key.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "event_key" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "messages_event_key_key" ON "messages"("event_key");
CREATE INDEX IF NOT EXISTS "messages_conversation_id_created_at_id_idx" ON "messages"("conversation_id", "created_at", "id");
