-- Image rollback keeps this additive column: rows already tagged would lose which ledger they belong to. Never drop it automatically.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM "withdrawals" WHERE "source" IS NOT NULL) THEN RAISE EXCEPTION 'tagged withdrawals exist: keep the additive column'; END IF; END $$;
DROP INDEX IF EXISTS "withdrawals_userId_source_status_idx";
ALTER TABLE "withdrawals" DROP COLUMN "source";
DROP TYPE "WithdrawalSource";
