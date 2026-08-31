-- CreateEnum
CREATE TYPE "AccreditationStatus_new" AS ENUM ('PENDING_AI_AUDIT', 'AI_VERIFIED', 'REJECTED', 'MANUAL_REVIEW');

-- AlterTable provider_accreditation_submissions status column
ALTER TABLE "provider_accreditation_submissions" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "provider_accreditation_submissions" 
  ALTER COLUMN "status" TYPE "AccreditationStatus_new" 
  USING (
    CASE "status"::text
      WHEN 'PENDING_AI_REVIEW' THEN 'PENDING_AI_AUDIT'::"AccreditationStatus_new"
      WHEN 'PASSED' THEN 'AI_VERIFIED'::"AccreditationStatus_new"
      WHEN 'NEEDS_MANUAL_REVIEW' THEN 'MANUAL_REVIEW'::"AccreditationStatus_new"
      WHEN 'DRAFT' THEN 'PENDING_AI_AUDIT'::"AccreditationStatus_new"
      WHEN 'REJECTED' THEN 'REJECTED'::"AccreditationStatus_new"
      ELSE 'PENDING_AI_AUDIT'::"AccreditationStatus_new"
    END
  );

ALTER TYPE "AccreditationStatus" RENAME TO "AccreditationStatus_old";
ALTER TYPE "AccreditationStatus_new" RENAME TO "AccreditationStatus";
DROP TYPE "AccreditationStatus_old";

ALTER TABLE "provider_accreditation_submissions" ALTER COLUMN "status" SET DEFAULT 'PENDING_AI_AUDIT';

-- CreateTable accreditation_samples
CREATE TABLE "accreditation_samples" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "projectUrl" TEXT,
    "githubUrl" TEXT,
    "technologiesUsed" TEXT[],
    "attachments" TEXT[],
    "status" "AccreditationStatus" NOT NULL DEFAULT 'PENDING_AI_AUDIT',
    "aiScore" DOUBLE PRECISION,
    "aiQualityRating" TEXT,
    "aiFeedbackAr" TEXT,
    "aiStrengths" TEXT[],
    "aiRecommendations" TEXT[],
    "aiAuditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accreditation_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accreditation_samples_providerProfileId_idx" ON "accreditation_samples"("providerProfileId");
CREATE INDEX "accreditation_samples_providerSpecialtyId_idx" ON "accreditation_samples"("providerSpecialtyId");

-- AddForeignKey
ALTER TABLE "accreditation_samples" ADD CONSTRAINT "accreditation_samples_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accreditation_samples" ADD CONSTRAINT "accreditation_samples_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
