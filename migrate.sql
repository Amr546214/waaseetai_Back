-- AlterEnum
BEGIN;
CREATE TYPE "AccreditationStatus_new" AS ENUM ('DRAFT', 'PENDING_AI_REVIEW', 'PASSED', 'NEEDS_MANUAL_REVIEW', 'REJECTED');
ALTER TABLE "provider_accreditation_submissions" ALTER COLUMN "status" TYPE "AccreditationStatus_new" USING ("status"::text::"AccreditationStatus_new");
ALTER TYPE "AccreditationStatus" RENAME TO "AccreditationStatus_old";
ALTER TYPE "AccreditationStatus_new" RENAME TO "AccreditationStatus";
DROP TYPE "public"."AccreditationStatus_old";
COMMIT;

-- CreateTable
CREATE TABLE "provider_accreditation_submissions" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "status" "AccreditationStatus" NOT NULL DEFAULT 'PENDING_AI_REVIEW',
    "overallAiScore" DOUBLE PRECISION,
    "aiDecisionSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_accreditation_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_accreditation_proofs" (
    "id" TEXT NOT NULL,
    "accreditationSubmissionId" TEXT NOT NULL,
    "fileType" "ProofFileType" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER,
    "aiAuthenticityScore" DOUBLE PRECISION,
    "aiDetectedQualityScore" DOUBLE PRECISION,
    "aiTechnicalAnalysis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_accreditation_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_accreditation_audit_logs" (
    "id" TEXT NOT NULL,
    "accreditationSubmissionId" TEXT NOT NULL,
    "promptTokensUsed" INTEGER,
    "completionTokensUsed" INTEGER,
    "rawAiResponse" JSONB NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_accreditation_audit_logs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "provider_accreditation_submissions" ADD CONSTRAINT "provider_accreditation_submissions_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accreditation_submissions" ADD CONSTRAINT "provider_accreditation_submissions_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accreditation_proofs" ADD CONSTRAINT "provider_accreditation_proofs_accreditationSubmissionId_fkey" FOREIGN KEY ("accreditationSubmissionId") REFERENCES "provider_accreditation_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accreditation_audit_logs" ADD CONSTRAINT "provider_accreditation_audit_logs_accreditationSubmissionI_fkey" FOREIGN KEY ("accreditationSubmissionId") REFERENCES "provider_accreditation_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

