-- Adds the real "Project Amendment" (طلبات تعديل المشاريع) domain: a client or
-- provider can request a scope/budget/duration change to an already-active
-- project, awaiting the other party's approval. Purely additive — new enums,
-- one new table, indexes and foreign keys only. No existing table/column is
-- altered, renamed, or dropped, and no data is touched.
--
-- This migration record intentionally records approvals only: responding to
-- an amendment (see ProjectAmendmentService.respondToAmendment) never mutates
-- Contract.price, Escrow, or ProjectStage amounts as a side effect.

CREATE TYPE "AmendmentRequesterRole" AS ENUM ('CLIENT', 'PROVIDER');

CREATE TYPE "AmendmentType" AS ENUM ('SCOPE', 'BUDGET', 'DURATION', 'MIXED');

CREATE TYPE "AmendmentStatus" AS ENUM ('PENDING_OTHER_PARTY', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "project_amendments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedByRole" "AmendmentRequesterRole" NOT NULL,
    "type" "AmendmentType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "budgetDelta" DOUBLE PRECISION,
    "durationDeltaDays" INTEGER,
    "status" "AmendmentStatus" NOT NULL DEFAULT 'PENDING_OTHER_PARTY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    CONSTRAINT "project_amendments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_amendments_clientId_status_idx" ON "project_amendments"("clientId", "status");
CREATE INDEX "project_amendments_providerId_status_idx" ON "project_amendments"("providerId", "status");
CREATE INDEX "project_amendments_contractId_idx" ON "project_amendments"("contractId");

ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
