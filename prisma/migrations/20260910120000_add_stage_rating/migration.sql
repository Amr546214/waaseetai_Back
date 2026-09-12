-- AlterTable: add stageId column to reviews table for per-stage rating support
ALTER TABLE "reviews" ADD COLUMN "stageId" TEXT;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "project_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reviews_stageId_idx" ON "reviews"("stageId");
