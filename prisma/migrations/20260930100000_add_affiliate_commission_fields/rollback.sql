-- Rollback of 20260930100000_add_affiliate_commission_fields (adapted). DEV/LIVE: take a backup first.
-- The STAGE_RELEASE enum value is left (Postgres cannot drop an enum value) and affiliate_profiles.level is left (it pre-existed on DEV).
BEGIN;
DROP INDEX IF EXISTS "commission_logs_affiliateId_referralId_type_sourceStageId_key";
ALTER TABLE "commission_logs" DROP COLUMN IF EXISTS "level", DROP COLUMN IF EXISTS "appliedPercentage",
  DROP COLUMN IF EXISTS "baseAmount", DROP COLUMN IF EXISTS "sourceStageId",
  DROP COLUMN IF EXISTS "sourceProjectId", DROP COLUMN IF EXISTS "referredUserId";
ALTER TABLE "affiliate_profiles" ALTER COLUMN "minimumPayoutAmount" SET DEFAULT 100.0;
COMMIT;
