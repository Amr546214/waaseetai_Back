-- NOT EXECUTED. Requires the owner's approval. Batch B T1: approval-request review loop + proof uploads.
-- Additive only: no existing row is changed. Idempotent (IF NOT EXISTS / duplicate_object guards).
ALTER TYPE "AccreditationStatus" ADD VALUE IF NOT EXISTS 'NEEDS_COMPLETION';

DO $$ BEGIN
  CREATE TYPE "ProofUploadStatus" AS ENUM ('UPLOADING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "accreditation_samples" ADD COLUMN IF NOT EXISTS "userNote" TEXT;
ALTER TABLE "accreditation_samples" ADD COLUMN IF NOT EXISTS "internalNote" TEXT;
ALTER TABLE "accreditation_samples" ADD COLUMN IF NOT EXISTS "completionFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "accreditation_samples" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "accreditation_samples" ADD COLUMN IF NOT EXISTS "decidedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "accreditation_sample_events" (
  "id" TEXT NOT NULL,
  "sampleId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "userNote" TEXT,
  "internalNote" TEXT,
  "actorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accreditation_sample_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "accreditation_sample_events_sampleId_createdAt_idx" ON "accreditation_sample_events"("sampleId", "createdAt");

CREATE TABLE IF NOT EXISTS "accreditation_proof_uploads" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "providerSpecialtyId" TEXT NOT NULL,
  "sampleId" TEXT,
  "kind" "ProofFileType" NOT NULL DEFAULT 'WORK_SAMPLE',
  "privateRef" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
  "bytes" INTEGER NOT NULL DEFAULT 0,
  "status" "ProofUploadStatus" NOT NULL DEFAULT 'COMPLETED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "accreditation_proof_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "accreditation_proof_uploads_userId_providerSpecialtyId_stat_idx" ON "accreditation_proof_uploads"("userId", "providerSpecialtyId", "status");
CREATE INDEX IF NOT EXISTS "accreditation_proof_uploads_sampleId_idx" ON "accreditation_proof_uploads"("sampleId");

DO $$ BEGIN
  ALTER TABLE "accreditation_sample_events" ADD CONSTRAINT "accreditation_sample_events_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "accreditation_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "accreditation_proof_uploads" ADD CONSTRAINT "accreditation_proof_uploads_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "accreditation_proof_uploads" ADD CONSTRAINT "accreditation_proof_uploads_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "accreditation_samples"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
