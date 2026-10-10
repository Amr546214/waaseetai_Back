-- Rollback for 20261011120000 (drops only the two columns it added).
ALTER TABLE "affiliate_profiles" DROP COLUMN IF EXISTS "kycRejectionReason";
ALTER TABLE "affiliate_profiles" DROP COLUMN IF EXISTS "kycReviewedAt";
