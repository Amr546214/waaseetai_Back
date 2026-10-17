-- NOT EXECUTED. ROLLBACK for 20261016100000_amendment_effective. Requires owner approval.
--
-- SELF-PROTECTING: everything runs in ONE transaction and the first statement REFUSES (raises an exception, which aborts the whole transaction) when ANY
-- trace of an effective amendment exists. After an amendment was applied the audit columns / table are NEVER dropped by this script:
--   * project_amendments.appliedAt IS NOT NULL            (an amendment changed a contract)
--   * a contract_terms_versions row                       (a scope addendum exists)
--   * a project_stages row with amendmentId set           (a stage was added by an amendment)
--   * an AMENDMENT_TOPUP / AMENDMENT_REFUND wallet row    (money moved because of an amendment)
--   * a project_amendments row with a stored funding authorization or applied price/duration values
-- Run it with:  psql -v ON_ERROR_STOP=1 -f rollback.sql   (even without ON_ERROR_STOP the COMMIT after a failed guard is a ROLLBACK, nothing is dropped).
-- Code rollback after an effective amendment: keep the columns, redeploy the previous image only if it reads the changed contract/escrow/stage data correctly
-- (contract price == escrow amount == sum of stage amounts is preserved), or reverse a specific amendment with an opposite amendment through the normal flow.
BEGIN;

DO $guard$
DECLARE
  n_applied integer := 0;
  n_versions integer := 0;
  n_stages integer := 0;
  n_wallet integer := 0;
  n_values integer := 0;
BEGIN
  IF to_regclass('public.project_amendments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_amendments' AND column_name = 'appliedAt') THEN
    EXECUTE 'SELECT count(*) FROM project_amendments WHERE "appliedAt" IS NOT NULL' INTO n_applied;
    EXECUTE 'SELECT count(*) FROM project_amendments WHERE "priceBefore" IS NOT NULL OR "priceAfter" IS NOT NULL OR "durationBefore" IS NOT NULL OR "durationAfter" IS NOT NULL OR "addedStageId" IS NOT NULL OR "fundingAuthorizedAt" IS NOT NULL' INTO n_values;
  END IF;
  IF to_regclass('public.contract_terms_versions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM contract_terms_versions' INTO n_versions;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_stages' AND column_name = 'amendmentId') THEN
    EXECUTE 'SELECT count(*) FROM project_stages WHERE "amendmentId" IS NOT NULL' INTO n_stages;
  END IF;
  SELECT count(*) INTO n_wallet FROM wallet_transactions WHERE type IN ('AMENDMENT_TOPUP', 'AMENDMENT_REFUND');

  IF n_applied > 0 OR n_versions > 0 OR n_stages > 0 OR n_wallet > 0 OR n_values > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: effective amendments exist (applied=%, terms_versions=%, amendment_stages=%, wallet_rows=%, audit_values=%). The audit columns are never dropped after an effective amendment.',
      n_applied, n_versions, n_stages, n_wallet, n_values;
  END IF;
END
$guard$;

DROP TABLE IF EXISTS "contract_terms_versions";
ALTER TABLE "project_stages" DROP COLUMN IF EXISTS "amendmentId";
ALTER TABLE "project_amendments"
  DROP COLUMN IF EXISTS "appliedAt",
  DROP COLUMN IF EXISTS "priceBefore",
  DROP COLUMN IF EXISTS "priceAfter",
  DROP COLUMN IF EXISTS "durationBefore",
  DROP COLUMN IF EXISTS "durationAfter",
  DROP COLUMN IF EXISTS "addedStageId",
  DROP COLUMN IF EXISTS "fundingAuthorizedAt",
  DROP COLUMN IF EXISTS "fundingAuthorizedAmount",
  DROP COLUMN IF EXISTS "fundingAuthorizedTerms";

COMMIT;
