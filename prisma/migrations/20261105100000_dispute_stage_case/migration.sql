-- Case 2 (stage dispute). Additive only: four nullable columns + indexes on "disputes". Existing rows and behaviour are untouched.
-- NOT EXECUTED on any shared environment (dev/prod): apply after a backup.
ALTER TABLE "disputes"
  ADD COLUMN "stageId" TEXT,
  ADD COLUMN "requestedResolution" TEXT,
  ADD COLUMN "submissionKey" TEXT,
  ADD COLUMN "submissionDigest" TEXT;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "project_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "disputes_stageId_idx" ON "disputes"("stageId");
CREATE UNIQUE INDEX "disputes_submissionKey_key" ON "disputes"("submissionKey");
