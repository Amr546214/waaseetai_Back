CREATE TYPE "ProjectStageStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUBMITTED', 'REVISION_REQUESTED', 'APPROVED');
CREATE TYPE "StageDeliveryStatus" AS ENUM ('SUBMITTED', 'REVISION_REQUESTED', 'APPROVED');

ALTER TABLE "escrows" ADD COLUMN "releasedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "project_stages" (
  "id" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "stepOrder" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "days" INTEGER NOT NULL,
  "percentage" DOUBLE PRECISION NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "status" "ProjectStageStatus" NOT NULL DEFAULT 'PENDING',
  "startedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_stages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stage_deliveries" (
  "id" TEXT NOT NULL,
  "stageId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "files" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "StageDeliveryStatus" NOT NULL DEFAULT 'SUBMITTED',
  "reviewNote" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stage_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_stages_contractId_stepOrder_key" ON "project_stages"("contractId", "stepOrder");
CREATE INDEX "project_stages_contractId_status_idx" ON "project_stages"("contractId", "status");
CREATE INDEX "stage_deliveries_stageId_submittedAt_idx" ON "stage_deliveries"("stageId", "submittedAt");
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_deliveries" ADD CONSTRAINT "stage_deliveries_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
