-- NOT EXECUTED. ROLLBACK for 20261017100000_review_tags. Requires owner approval.
-- SELF-PROTECTING: refuses (and aborts the transaction) when any review already carries tags, so the reviewers' choices are never dropped.
BEGIN;
DO $guard$
DECLARE n integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reviews' AND column_name = 'tags') THEN
    EXECUTE 'SELECT count(*) FROM reviews WHERE cardinality("tags") > 0' INTO n;
  END IF;
  IF n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % review(s) carry tags; the column is never dropped once reviewers'' choices are stored.', n;
  END IF;
END
$guard$;
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "tags";
COMMIT;
