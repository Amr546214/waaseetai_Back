-- Restore schema changes that were present in Prisma but absent from the
-- migration history. Preserve SQL-only indexes and tables from earlier changes.
BEGIN;

DO $$
BEGIN
  IF to_regtype('"UserRole"') IS NULL THEN
    CREATE TYPE "UserRole" AS ENUM ('CLIENT', 'PROVIDER', 'AFFILIATE', 'ADMIN', 'SUPER_ADMIN');
  END IF;
  IF to_regtype('"PayoutAttemptStatus"') IS NULL THEN
    CREATE TYPE "PayoutAttemptStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED');
  END IF;
  IF to_regtype('"PaypalWebhookEventStatus"') IS NULL THEN
    CREATE TYPE "PaypalWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');
  END IF;
END $$;

ALTER TYPE "LogCategory" ADD VALUE IF NOT EXISTS 'SYSTEM_AUDIT';
ALTER TYPE "ModelStatus" ADD VALUE IF NOT EXISTS 'PENDING_SIGNATURE';
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'PENDING_SIGNATURE';
ALTER TYPE "ProposalStatus" ADD VALUE IF NOT EXISTS 'PENDING_SIGNATURE';
ALTER TYPE "ServiceStatus" ADD VALUE IF NOT EXISTS 'PENDING_SIGNATURE';
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'REVERSED';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "activeRole" "UserRole",
  ADD COLUMN IF NOT EXISTS "roles" "UserRole"[],
  ADD COLUMN IF NOT EXISTS "authProvider" TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS "googleId" TEXT,
  ADD COLUMN IF NOT EXISTS "isBanned" BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN "phoneCountryCode" DROP NOT NULL,
  ALTER COLUMN "phoneNumber" DROP NOT NULL,
  ALTER COLUMN "password" DROP NOT NULL;

-- Only fill roles newly introduced in older databases. Match the primary
-- role derivation used by account-management.service.ts.
UPDATE "users" SET "activeRole" = CASE "accountType"::text
  WHEN 'PROVIDER_COMPANY' THEN 'PROVIDER'::"UserRole"
  WHEN 'PROVIDER_INDIVIDUAL' THEN 'PROVIDER'::"UserRole"
  WHEN 'MARKETING_BROKER' THEN 'AFFILIATE'::"UserRole"
  ELSE 'CLIENT'::"UserRole"
END WHERE "activeRole" IS NULL;

UPDATE "users" SET "roles" = CASE "accountType"::text
  WHEN 'PROVIDER_COMPANY' THEN ARRAY['PROVIDER', 'CLIENT']::"UserRole"[]
  WHEN 'PROVIDER_INDIVIDUAL' THEN ARRAY['PROVIDER', 'CLIENT']::"UserRole"[]
  WHEN 'MARKETING_BROKER' THEN ARRAY['AFFILIATE', 'CLIENT']::"UserRole"[]
  ELSE ARRAY['CLIENT']::"UserRole"[]
END WHERE "roles" IS NULL;

ALTER TABLE "users"
  ALTER COLUMN "activeRole" SET DEFAULT 'CLIENT',
  ALTER COLUMN "activeRole" SET NOT NULL,
  ALTER COLUMN "roles" SET DEFAULT ARRAY['CLIENT']::"UserRole"[];
CREATE UNIQUE INDEX IF NOT EXISTS "users_googleId_key" ON "users"("googleId");

ALTER TABLE "provider_profiles"
  ADD COLUMN IF NOT EXISTS "accountHolder" TEXT,
  ADD COLUMN IF NOT EXISTS "accurateAgreed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "backIdUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "bankName" TEXT,
  ADD COLUMN IF NOT EXISTS "certUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "dob" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "frontIdUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "iban" TEXT,
  ADD COLUMN IF NOT EXISTS "idNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "industry" TEXT,
  ADD COLUMN IF NOT EXISTS "isNafathVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isProfileSetupComplete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "kycStatus" "KYCStatus" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "mainSpecialty" TEXT,
  ADD COLUMN IF NOT EXISTS "notes" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentType" TEXT,
  ADD COLUMN IF NOT EXISTS "paypalPayoutEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "privacyAgreed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "setupTestBannedUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "setupTestCheatAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "setupTestScore" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "setupTestStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "subSpecialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "supportingDocsUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "termsAgreed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "accreditation_samples"
  ADD COLUMN IF NOT EXISTS "offersAccepted" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "offersGenerated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rating" DOUBLE PRECISION DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS "reviewsCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "viewsCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "slug" TEXT;
UPDATE "categories" SET "slug" = 'category-' || "id" WHERE "slug" IS NULL;
ALTER TABLE "categories" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "categories_slug_key" ON "categories"("slug");

ALTER TABLE "specialties" ADD COLUMN IF NOT EXISTS "slug" TEXT;
UPDATE "specialties" SET "slug" = 'specialty-' || "id" WHERE "slug" IS NULL;
ALTER TABLE "specialties" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "specialties_slug_key" ON "specialties"("slug");

ALTER TABLE "proof_attachments"
  ADD COLUMN IF NOT EXISTS "watermarkLabel" VARCHAR(50) NOT NULL DEFAULT 'وسيط AI';
ALTER TABLE "work_samples"
  ADD COLUMN IF NOT EXISTS "technologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "watermarkLabel" VARCHAR(50) NOT NULL DEFAULT 'وسيط AI';
ALTER TABLE "service_catalogs" ADD COLUMN IF NOT EXISTS "gallery" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "paypalEmail" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'proposals' AND column_name = 'clientRequestId') THEN
    ALTER TABLE "proposals" ADD COLUMN "clientRequestId" TEXT;
    ALTER TABLE "proposals" ADD CONSTRAINT "proposals_clientRequestId_fkey"
      FOREIGN KEY ("clientRequestId") REFERENCES "client_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
ALTER TABLE "proposals" ALTER COLUMN "projectId" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS "proposals_clientRequestId_status_idx" ON "proposals"("clientRequestId", "status");

CREATE TABLE IF NOT EXISTS "payout_attempts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "withdrawalId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "senderBatchId" TEXT NOT NULL,
  "payoutBatchId" TEXT,
  "payoutItemId" TEXT,
  "status" "PayoutAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "failureReason" TEXT,
  "paypalTerminalStatus" TEXT,
  "rawResponse" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "payout_attempts_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "payout_attempts_senderBatchId_key" ON "payout_attempts"("senderBatchId");
CREATE UNIQUE INDEX IF NOT EXISTS "payout_attempts_payoutItemId_key" ON "payout_attempts"("payoutItemId");
CREATE UNIQUE INDEX IF NOT EXISTS "payout_attempts_withdrawalId_attemptNumber_key" ON "payout_attempts"("withdrawalId", "attemptNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "active_attempt_unique" ON "payout_attempts"("withdrawalId") WHERE ("status" IN ('PENDING', 'PROCESSING'));
CREATE INDEX IF NOT EXISTS "payout_attempts_withdrawalId_status_idx" ON "payout_attempts"("withdrawalId", "status");
CREATE INDEX IF NOT EXISTS "payout_attempts_status_createdAt_idx" ON "payout_attempts"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "paypal_webhook_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "paypalEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "resourceType" TEXT,
  "paypalCreateTime" TIMESTAMP(3),
  "status" "PaypalWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "rawEvent" JSONB,
  "processedAt" TIMESTAMP(3),
  "payoutAttemptId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "paypal_webhook_events_payoutAttemptId_fkey" FOREIGN KEY ("payoutAttemptId") REFERENCES "payout_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
ALTER TABLE "paypal_webhook_events" ADD COLUMN IF NOT EXISTS "paypalCreateTime" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "paypal_webhook_events_paypalEventId_key" ON "paypal_webhook_events"("paypalEventId");
CREATE INDEX IF NOT EXISTS "paypal_webhook_events_payoutAttemptId_idx" ON "paypal_webhook_events"("payoutAttemptId");
CREATE INDEX IF NOT EXISTS "paypal_webhook_events_status_createdAt_idx" ON "paypal_webhook_events"("status", "createdAt");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'context' AND data_type = 'json') THEN
    ALTER TABLE "messages" ALTER COLUMN "context" TYPE JSONB;
  END IF;

  -- Older schemas linked this column to skills. Rebind it on fresh installs
  -- and on databases where all existing references already match specialties.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'service_catalogs'::regclass AND conname = 'service_catalogs_specialtyId_fkey'
      AND (confrelid <> 'specialties'::regclass OR confdeltype <> 'n' OR confupdtype <> 'c')
  ) AND NOT EXISTS (
    SELECT 1 FROM "service_catalogs" AS catalog
    WHERE catalog."specialtyId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "specialties" WHERE id = catalog."specialtyId")
  ) THEN
    ALTER TABLE "service_catalogs" DROP CONSTRAINT "service_catalogs_specialtyId_fkey";
    ALTER TABLE "service_catalogs" ADD CONSTRAINT "service_catalogs_specialtyId_fkey"
      FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
