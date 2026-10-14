-- NOT EXECUTED. Preview only. Requires owner approval.
-- Amendment effective (docs/proposals/amendment-effects-migration-preview.md). Additive only: nullable columns + one new table. No enum change, no data change.
-- Existing rows: every new column is NULL, so old APPROVED amendments stay "recorded only" (appliedAt NULL) and are never re-applied.

ALTER TABLE "project_amendments"
  ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priceBefore" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priceAfter" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "durationBefore" INTEGER,
  ADD COLUMN IF NOT EXISTS "durationAfter" INTEGER,
  ADD COLUMN IF NOT EXISTS "addedStageId" TEXT,
  ADD COLUMN IF NOT EXISTS "fundingAuthorizedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fundingAuthorizedAmount" DOUBLE PRECISION;

ALTER TABLE "project_stages" ADD COLUMN IF NOT EXISTS "amendmentId" TEXT;

CREATE TABLE IF NOT EXISTS "contract_terms_versions" (
  "id" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "addendumText" TEXT NOT NULL,
  "amendmentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contract_terms_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "contract_terms_versions_amendmentId_key" ON "contract_terms_versions"("amendmentId");
CREATE UNIQUE INDEX IF NOT EXISTS "contract_terms_versions_contractId_version_key" ON "contract_terms_versions"("contractId", "version");
ALTER TABLE "contract_terms_versions"
  ADD CONSTRAINT "contract_terms_versions_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
