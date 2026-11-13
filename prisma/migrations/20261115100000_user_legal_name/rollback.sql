-- Rollback of 20261115100000_user_legal_name. Drops the column AND the legal names stored in it: take a backup first.
ALTER TABLE "users" DROP COLUMN IF EXISTS "legalName";
