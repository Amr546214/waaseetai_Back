-- AlterTable: persist the marketer KYC review outcome (additive, nullable, no data change).
-- Applied on DEV only after a pg_dump backup; LIVE is applied by the team. Rollback: DROP COLUMN both (they hold no other data).
ALTER TABLE "affiliate_profiles" ADD COLUMN IF NOT EXISTS "kycRejectionReason" TEXT;
ALTER TABLE "affiliate_profiles" ADD COLUMN IF NOT EXISTS "kycReviewedAt" TIMESTAMP(3);
