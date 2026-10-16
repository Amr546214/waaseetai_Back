-- NOT EXECUTED. Rollback of 20261019020000_chat_digest. Self-protecting: refuses while the digest has real history (rows), because dropping it would let a re-enable mail again
-- inside a 15-minute window. Turn CHAT_DIGEST_EMAIL_ENABLED off first; to discard the history deliberately, run the two DELETEs by hand and then this file.
DO $$
BEGIN
  IF to_regclass('chat_digest_state') IS NOT NULL AND EXISTS (SELECT 1 FROM "chat_digest_state") THEN
    RAISE EXCEPTION 'chat_digest_state holds digest history; refusing to drop (delete the rows deliberately first)';
  END IF;
  IF to_regclass('chat_digest_activation') IS NOT NULL AND EXISTS (SELECT 1 FROM "chat_digest_activation") THEN
    RAISE EXCEPTION 'chat_digest_activation holds the activation time; refusing to drop (delete the row deliberately first)';
  END IF;
END $$;
DROP TABLE IF EXISTS "chat_digest_state";
DROP TABLE IF EXISTS "chat_digest_activation";
