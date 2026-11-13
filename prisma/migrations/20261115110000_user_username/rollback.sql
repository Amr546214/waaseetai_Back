-- Rollback of 20261115110000_user_username. Drops the column and the usernames in it (the display columns firstName/lastName were kept in step, so names shown stay as they are).
ALTER TABLE "users" DROP COLUMN IF EXISTS "username";
