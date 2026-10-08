-- AlterTable (NOT EXECUTED - applied by the team on the server)
-- Additive only: six new columns on client_profiles, all nullable / defaulted, no data touched.
ALTER TABLE "client_profiles"
  ADD COLUMN "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "portfolioUrl" TEXT,
  ADD COLUMN "linkedinUrl" TEXT,
  ADD COLUMN "personalWebsiteUrl" TEXT,
  ADD COLUMN "interfaceLanguage" TEXT,
  ADD COLUMN "timezone" TEXT;
