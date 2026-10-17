-- NOT EXECUTED. ROLLBACK for 20261017110000_review_visibility. Requires the lead's authorization.
-- SELF-PROTECTING: runs in one transaction and refuses (raises, so nothing is dropped even without ON_ERROR_STOP) when
--   (a) any review has isPublic = false: dropping the column would silently publish a privacy decision, or
--   (b) any review carries tags: the reviewers' saved choices are never dropped (same rule as the tags rollback).
BEGIN;
DO $guard$
DECLARE hidden integer := 0; tagged integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reviews' AND column_name = 'isPublic') THEN
    EXECUTE 'SELECT count(*) FROM reviews WHERE "isPublic" = false' INTO hidden;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reviews' AND column_name = 'tags') THEN
    EXECUTE 'SELECT count(*) FROM reviews WHERE cardinality("tags") > 0' INTO tagged;
  END IF;
  IF hidden > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % review(s) are unpublished (isPublic = false); dropping the column would publish them.', hidden;
  END IF;
  IF tagged > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % review(s) carry tags; reviewers'' saved choices are never dropped.', tagged;
  END IF;
END
$guard$;
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "isPublic";
COMMIT;
