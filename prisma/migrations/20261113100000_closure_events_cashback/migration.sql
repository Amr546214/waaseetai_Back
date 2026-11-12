-- Closure record, financial-event identity for commissions and the client cashback ledger. NOT EXECUTED on any shared database (dev / production).
-- Additive only: two new tables, one nullable column, one partial unique index. No existing row is read, rewritten or backfilled.
CREATE TABLE IF NOT EXISTS "engagement_closures" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "contractId" TEXT,
  "requestId" TEXT,
  "kind" VARCHAR(30) NOT NULL,
  "source" VARCHAR(30) NOT NULL,
  "reason" VARCHAR(500),
  "decidedById" TEXT NOT NULL,
  "cancellationRequestId" TEXT,
  "escrowId" TEXT,
  "heldBefore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "refundToClient" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "releaseToProvider" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "platformCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "providerNet" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "feePolicyVersion" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_closures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "engagement_closures_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "engagement_closures_amounts_nonneg" CHECK ("heldBefore" >= 0 AND "refundToClient" >= 0 AND "releaseToProvider" >= 0 AND "platformCommission" >= 0 AND "providerNet" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_closures_projectId_key" ON "engagement_closures" ("projectId");
CREATE INDEX IF NOT EXISTS "engagement_closures_contractId_idx" ON "engagement_closures" ("contractId");
CREATE INDEX IF NOT EXISTS "engagement_closures_kind_idx" ON "engagement_closures" ("kind");

ALTER TABLE "commission_logs" ADD COLUMN IF NOT EXISTS "sourceEventId" TEXT;
CREATE INDEX IF NOT EXISTS "commission_logs_sourceEventId_idx" ON "commission_logs" ("sourceEventId");
-- exactly-once for commissions on funds released outside a stage approval (a NULL sourceStageId does not collide in the existing unique key)
CREATE UNIQUE INDEX IF NOT EXISTS "commission_logs_event_key" ON "commission_logs" ("affiliateId", "referralId", "type", "sourceEventId") WHERE "sourceEventId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "client_cashback_entries" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eligibleValue" DOUBLE PRECISION NOT NULL,
  "level" INTEGER NOT NULL,
  "ratePercent" DOUBLE PRECISION NOT NULL,
  "ladderSource" VARCHAR(80) NOT NULL,
  "policyCode" VARCHAR(40) NOT NULL,
  "ratingInput" DOUBLE PRECISION NOT NULL,
  "paymentInput" DOUBLE PRECISION NOT NULL,
  "ratingFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "paymentFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "walletReference" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'CREDITED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_cashback_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_cashback_entries_amount_nonneg" CHECK ("amount" >= 0 AND "eligibleValue" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "client_cashback_entries_contractId_key" ON "client_cashback_entries" ("contractId");
CREATE UNIQUE INDEX IF NOT EXISTS "client_cashback_entries_eventKey_key" ON "client_cashback_entries" ("eventKey");
CREATE UNIQUE INDEX IF NOT EXISTS "client_cashback_entries_walletReference_key" ON "client_cashback_entries" ("walletReference");
CREATE INDEX IF NOT EXISTS "client_cashback_entries_userId_createdAt_idx" ON "client_cashback_entries" ("userId", "createdAt");
