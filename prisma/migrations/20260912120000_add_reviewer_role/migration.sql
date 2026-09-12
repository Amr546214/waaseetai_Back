-- AlterTable: add reviewerRole column to reviews table to distinguish rating direction
-- Existing reviews default to 'CLIENT' (all prior final reviews were created by the client flow)
ALTER TABLE "reviews" ADD COLUMN "reviewerRole" TEXT NOT NULL DEFAULT 'CLIENT';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reviews_reviewerRole_idx" ON "reviews"("reviewerRole");
