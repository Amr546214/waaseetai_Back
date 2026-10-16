-- NOT EXECUTED. Self-protecting rollback of 20261018040000_project_message_context.
-- Refuses (RAISE EXCEPTION, nothing changed) while any data would be lost: a PROJECT-kind conversation, a conversation linked to a contract,
-- or an event message that exists only because of the event key. Run inside a transaction.
BEGIN;
DO $$
DECLARE n_proj int; n_link int; n_evt int;
BEGIN
  SELECT count(*) INTO n_proj FROM "conversations" WHERE "kind" = 'PROJECT';
  SELECT count(*) INTO n_link FROM "conversations" WHERE "contract_id" IS NOT NULL;
  SELECT count(*) INTO n_evt FROM "messages" WHERE "event_key" IS NOT NULL;
  IF n_proj > 0 OR n_link > 0 OR n_evt > 0 THEN
    RAISE EXCEPTION 'rollback refused: % PROJECT conversations, % contract-linked conversations, % event messages would lose their context', n_proj, n_link, n_evt;
  END IF;
END $$;
DROP INDEX IF EXISTS "messages_conversation_id_created_at_id_idx";
DROP INDEX IF EXISTS "messages_event_key_key";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "event_key";
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_contract_id_fkey";
DROP INDEX IF EXISTS "conversations_provider_id_kind_idx";
DROP INDEX IF EXISTS "conversations_client_id_kind_idx";
DROP INDEX IF EXISTS "conversations_contract_id_key";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "contract_id";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "kind";
DROP TYPE IF EXISTS "ConversationKind";
COMMIT;
