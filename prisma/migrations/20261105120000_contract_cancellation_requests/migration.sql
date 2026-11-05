-- ADDITIVE ONLY. NOT EXECUTED on dev/prod: the owner applies it after a backup.
CREATE TYPE "CancellationRequestStatus" AS ENUM ('PENDING_OTHER_PARTY', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
CREATE TYPE "CancellationSettlementStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING_ADMIN_DECISION');

CREATE TABLE "contract_cancellation_requests" (
  "id" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "requestedByRole" "AmendmentRequesterRole" NOT NULL,
  "reason" TEXT NOT NULL,
  "note" TEXT,
  "requestKey" TEXT,
  "status" "CancellationRequestStatus" NOT NULL DEFAULT 'PENDING_OTHER_PARTY',
  "settlementStatus" "CancellationSettlementStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
  "respondedById" TEXT,
  "respondedAt" TIMESTAMP(3),
  "responseNote" TEXT,
  "withdrawnAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contract_cancellation_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contract_cancellation_requests_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "contract_cancellation_requests_requestedById_requestKey_key" ON "contract_cancellation_requests"("requestedById", "requestKey");
CREATE INDEX "contract_cancellation_requests_contractId_status_idx" ON "contract_cancellation_requests"("contractId", "status");
CREATE INDEX "contract_cancellation_requests_clientId_idx" ON "contract_cancellation_requests"("clientId");
CREATE INDEX "contract_cancellation_requests_providerId_idx" ON "contract_cancellation_requests"("providerId");
CREATE INDEX "contract_cancellation_requests_status_createdAt_idx" ON "contract_cancellation_requests"("status", "createdAt");
-- At most one open (PENDING) or agreed (ACCEPTED) request per contract, enforced by the database under concurrency.
CREATE UNIQUE INDEX "contract_cancellation_requests_one_open_per_contract" ON "contract_cancellation_requests"("contractId") WHERE "status" IN ('PENDING_OTHER_PARTY', 'ACCEPTED');
-- A request is only ever asked for by one of the contract's two parties.
ALTER TABLE "contract_cancellation_requests" ADD CONSTRAINT "contract_cancellation_requests_requester_is_party" CHECK ("requestedById" IN ("clientId", "providerId"));
