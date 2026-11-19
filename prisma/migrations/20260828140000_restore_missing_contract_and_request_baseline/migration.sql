-- These objects predate the migrations that first alter them.
-- Live databases that already have the baseline keep their existing objects.
DO $$
BEGIN
  IF to_regtype('"ContractStatus"') IS NULL THEN
    CREATE TYPE "ContractStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'DISPUTED');
  END IF;
  IF to_regtype('"BudgetType"') IS NULL THEN
    CREATE TYPE "BudgetType" AS ENUM ('FIXED', 'RANGE', 'HOURLY');
  END IF;
  IF to_regtype('"ProviderTypePreference"') IS NULL THEN
    CREATE TYPE "ProviderTypePreference" AS ENUM ('INDIVIDUAL', 'COMPANY', 'ACCREDITED_ONLY', 'ANY');
  END IF;
  IF to_regtype('"RequestStatus"') IS NULL THEN
    CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "contracts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "offerId" TEXT,
  "price" DOUBLE PRECISION NOT NULL,
  "durationDays" INTEGER NOT NULL,
  "phasesCount" INTEGER NOT NULL DEFAULT 1,
  "terms" JSONB,
  "status" "ContractStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "signedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contracts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "contracts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "contracts_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "contracts_projectId_key" ON "contracts"("projectId");

CREATE TABLE IF NOT EXISTS "client_requests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientProfileId" TEXT NOT NULL,
  "specialtyId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "subSpecialties" TEXT[],
  "requiredSkills" TEXT[],
  "budgetType" "BudgetType" NOT NULL DEFAULT 'FIXED',
  "minBudget" DOUBLE PRECISION,
  "maxBudget" DOUBLE PRECISION,
  "expectedDurationDays" INTEGER,
  "preferredProviderType" "ProviderTypePreference" NOT NULL DEFAULT 'ANY',
  "requiresNda" BOOLEAN NOT NULL DEFAULT false,
  "attachments" TEXT[],
  "aiAnalyzedSummary" TEXT,
  "aiComplexityRating" TEXT,
  "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
  "proposalsCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_requests_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "client_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "client_requests_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "client_requests_clientProfileId_idx" ON "client_requests"("clientProfileId");
CREATE INDEX IF NOT EXISTS "client_requests_specialtyId_idx" ON "client_requests"("specialtyId");
CREATE INDEX IF NOT EXISTS "client_requests_status_idx" ON "client_requests"("status");
