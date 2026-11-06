-- Refuses once any dispute carries a stage / request / key (do not drop recorded case data).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "disputes" WHERE "stageId" IS NOT NULL OR "requestedResolution" IS NOT NULL OR "submissionKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'stage-dispute data exists; rollback refused';
  END IF;
END $$;
DROP INDEX IF EXISTS "disputes_submissionKey_key";
DROP INDEX IF EXISTS "disputes_stageId_idx";
ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_stageId_fkey";
ALTER TABLE "disputes" DROP COLUMN "submissionDigest", DROP COLUMN "submissionKey", DROP COLUMN "requestedResolution", DROP COLUMN "stageId";
