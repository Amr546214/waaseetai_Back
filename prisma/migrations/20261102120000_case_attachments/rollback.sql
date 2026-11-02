-- Only for an unused rollout. Operational rollback keeps tables/files intact.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM case_attachments)
     OR EXISTS (SELECT 1 FROM support_tickets WHERE "submissionKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'Attachment/submission records exist; keep schema and fix forward';
  END IF;
END $$;
DROP TABLE case_attachments;
ALTER TABLE support_tickets DROP COLUMN "submissionKey", DROP COLUMN "submissionDigest";
COMMIT;
