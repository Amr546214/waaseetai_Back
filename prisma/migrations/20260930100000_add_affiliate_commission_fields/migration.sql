-- APPLIED BY HAND on DEV (wasit-pg-dev) on 2026-10-11, in one transaction, after a pg_dump backup of commission_logs + affiliate_profiles.
-- This is the adapted, idempotent version (IF NOT EXISTS), because affiliate_profiles.level already existed on DEV. LIVE: the team applies it.
--
-- Source: P-LG-012 (مسودة مرجعية حاكمة) — Marketing Affiliate/referral
-- system governing draft. This migration adds:
--   1. AffiliateProfile.level — manually-set performance level (1-15), see
--      src/config/affiliate-levels.config.ts for the static
--      level -> commission-percentage table. No automatic promotion logic.
--   2. AffiliateProfile.minimumPayoutAmount default raised to 300 (P-LG-012's
--      stated withdrawal minimum). This ALTER COLUMN ... SET DEFAULT only
--      affects rows inserted AFTER this migration runs — existing rows keep
--      whatever value they already have (Prisma/Postgres column defaults
--      apply at INSERT time only, never retroactively).
--   3. CommissionType.STAGE_RELEASE — the real P-LG-012 qualifying trigger
--      (stage escrow release / settled financial transaction), distinct from
--      the pre-existing NEW_CLIENT_REQUEST/FIRST_PROJECT_COMPLETED/
--      SUBSCRIPTION values which nothing in the codebase currently emits.
--   4. CommissionLog auditability fields (referredUserId, sourceProjectId,
--      sourceStageId, baseAmount, appliedPercentage, level) — durable
--      snapshots taken at creation time, never recomputed later.
--   5. An exactly-once uniqueness constraint so a retried/duplicate
--      commission-creation attempt for the SAME affiliate+referral+type+
--      release-event fails at the DB level, not just in application code.
--
-- CURRENCY NOTE: this migration does NOT change CommissionLog.currency's
-- existing "SAR" schema default. The affiliate commission ENGINE itself
-- (src/services/affiliate-commission.service.ts) explicitly sets
-- currency: 'USD' on every row it writes (matching the real USD-denominated
-- escrow-release trigger) and is gated OFF by default behind
-- AFFILIATE_COMMISSION_ENGINE_ENABLED until a human resolves the USD-vs-SAR
-- policy question — see that file and src/utils/affiliate-commission-engine.util.ts
-- for the full reasoning. This migration only adds columns/constraints; it
-- performs no data backfill and no currency conversion.
--
-- CAVEAT: `ALTER TYPE ... ADD VALUE` cannot run inside the same transaction
-- as other DDL on some older PostgreSQL versions. If this is ever executed
-- for real, confirm the target Postgres version allows this (PG12+ allows
-- ADD VALUE inside a transaction as long as the new value is not used in
-- the same transaction — none of the statements below use STAGE_RELEASE),
-- or split it into its own migration/transaction first.

-- 1 & 2: AffiliateProfile
ALTER TABLE "affiliate_profiles" ADD COLUMN IF NOT EXISTS "level" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "affiliate_profiles" ALTER COLUMN "minimumPayoutAmount" SET DEFAULT 300.0;

-- 3: CommissionType enum
ALTER TYPE "CommissionType" ADD VALUE IF NOT EXISTS 'STAGE_RELEASE';

-- 4: CommissionLog auditability fields
ALTER TABLE "commission_logs" ADD COLUMN IF NOT EXISTS "referredUserId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "commission_logs" ALTER COLUMN "referredUserId" DROP DEFAULT;
ALTER TABLE "commission_logs" ADD COLUMN IF NOT EXISTS "sourceProjectId" TEXT;
ALTER TABLE "commission_logs" ADD COLUMN IF NOT EXISTS "sourceStageId" TEXT;
ALTER TABLE "commission_logs" ADD COLUMN IF NOT EXISTS "baseAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "commission_logs" ALTER COLUMN "baseAmount" DROP DEFAULT;
ALTER TABLE "commission_logs" ADD COLUMN IF NOT EXISTS "appliedPercentage" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "commission_logs" ALTER COLUMN "appliedPercentage" DROP DEFAULT;
ALTER TABLE "commission_logs" ADD COLUMN IF NOT EXISTS "level" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "commission_logs" ALTER COLUMN "level" DROP DEFAULT;

-- 5: exactly-once guard — one commission per affiliate+referral+type per distinct release event (sourceStageId).
CREATE UNIQUE INDEX IF NOT EXISTS "commission_logs_affiliateId_referralId_type_sourceStageId_key"
  ON "commission_logs" ("affiliateId", "referralId", "type", "sourceStageId");
