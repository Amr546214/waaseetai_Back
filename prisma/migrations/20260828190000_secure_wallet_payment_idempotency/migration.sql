ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "walletBalance" DECIMAL(12,2) NOT NULL DEFAULT 0.00;

CREATE TABLE IF NOT EXISTS "wallet_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "paymentMethod" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "wallet_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "wallet_transactions_userId_createdAt_idx"
ON "wallet_transactions"("userId", "createdAt");

-- A Moyasar payment may credit at most one wallet, even under concurrent callbacks.
-- The migration intentionally fails on historical duplicates so they can be audited.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_referenceId_key"
ON "wallet_transactions"("referenceId");
