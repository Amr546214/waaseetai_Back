-- ROLLBACK for 20261027120000_fee_policy_versions (not run by Prisma; apply by hand only if the release is reverted).
-- Safe while no scheduled version has taken effect: old code ignores these columns and reads the constants. After a scheduled version
-- is effective, dropping loses which policy each operation was created under, so prefer rolling the code back and keeping the schema.
BEGIN;
ALTER TABLE "withdrawals" DROP COLUMN IF EXISTS "minimumApplied", DROP COLUMN IF EXISTS "feePolicyId";
ALTER TABLE "paypal_payments" DROP COLUMN IF EXISTS "feePolicyId";
ALTER TABLE "escrows" DROP COLUMN IF EXISTS "feePolicyId";
DROP TABLE IF EXISTS "fee_policy_versions";
COMMIT;
