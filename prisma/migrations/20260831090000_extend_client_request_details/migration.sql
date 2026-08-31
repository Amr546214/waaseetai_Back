ALTER TABLE "client_requests"
  ADD COLUMN "outputs" TEXT,
  ADD COLUMN "customConditions" TEXT,
  ADD COLUMN "ipRights" TEXT NOT NULL DEFAULT 'client',
  ADD COLUMN "providerPreferences" JSONB,
  ADD COLUMN "allowNegotiation" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "splitMilestones" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "milestones" JSONB;
