-- NOT EXECUTED. ROLLBACK for 20261018010000_approval_request_loop. Requires the owner's approval.
-- SELF-PROTECTING: one transaction; it RAISES (nothing is dropped) when
--   (a) any approval request is in NEEDS_COMPLETION (the enum value cannot be removed while used and the provider would lose the "complete your data" state),
--   (b) any review-history event or admin note exists (history is never dropped silently),
--   (c) any proof upload row exists (the tie between a document and its request would be lost).
BEGIN;
DO $guard$
DECLARE needs integer := 0; ev integer := 0; notes integer := 0; up integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'accreditation_samples') THEN
    EXECUTE 'SELECT count(*) FROM accreditation_samples WHERE status::text = ''NEEDS_COMPLETION''' INTO needs;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accreditation_samples' AND column_name = 'userNote') THEN
      EXECUTE 'SELECT count(*) FROM accreditation_samples WHERE "userNote" IS NOT NULL OR "internalNote" IS NOT NULL' INTO notes;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'accreditation_sample_events') THEN
    EXECUTE 'SELECT count(*) FROM accreditation_sample_events' INTO ev;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'accreditation_proof_uploads') THEN
    EXECUTE 'SELECT count(*) FROM accreditation_proof_uploads' INTO up;
  END IF;
  IF needs > 0 THEN RAISE EXCEPTION 'ROLLBACK REFUSED: % request(s) are in NEEDS_COMPLETION.', needs; END IF;
  IF ev > 0 THEN RAISE EXCEPTION 'ROLLBACK REFUSED: % review-history event(s) exist.', ev; END IF;
  IF notes > 0 THEN RAISE EXCEPTION 'ROLLBACK REFUSED: % request(s) carry admin notes.', notes; END IF;
  IF up > 0 THEN RAISE EXCEPTION 'ROLLBACK REFUSED: % proof upload row(s) exist.', up; END IF;
END
$guard$;
DROP TABLE IF EXISTS "accreditation_proof_uploads";
DROP TABLE IF EXISTS "accreditation_sample_events";
ALTER TABLE "accreditation_samples" DROP COLUMN IF EXISTS "userNote", DROP COLUMN IF EXISTS "internalNote", DROP COLUMN IF EXISTS "completionFields", DROP COLUMN IF EXISTS "revision", DROP COLUMN IF EXISTS "decidedAt";
DROP TYPE IF EXISTS "ProofUploadStatus";
-- The enum value 'NEEDS_COMPLETION' stays (PostgreSQL cannot drop an enum value); it is unused after the guard above.
COMMIT;
