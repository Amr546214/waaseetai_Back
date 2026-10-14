-- NOT EXECUTED. ROLLBACK for 20261016100000_amendment_effective. Requires owner approval.
-- Safe only BEFORE any amendment was applied; after that, dropping the columns loses the before/after audit values (the contract, escrow and stage rows keep their changed amounts).
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
