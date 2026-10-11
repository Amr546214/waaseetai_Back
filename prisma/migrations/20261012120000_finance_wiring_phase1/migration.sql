-- Finance wiring phase 1 (additive, nullable / defaulted, no data change).
-- Applied on DEV only, after a pg_dump backup. LIVE is applied by the team. Rollback: rollback.sql (drops only these columns).

-- Escrow: fee policy v2 snapshot + commission ledger totals. NULL "feePolicyVersion" marks every existing (legacy) escrow: it is never recalculated.
ALTER TABLE "escrows" ADD COLUMN IF NOT EXISTS "feePolicyVersion" INTEGER;
ALTER TABLE "escrows" ADD COLUMN IF NOT EXISTS "providerCommissionRateSnapshot" DOUBLE PRECISION;
ALTER TABLE "escrows" ADD COLUMN IF NOT EXISTS "providerCommissionLevelSnapshot" INTEGER;
ALTER TABLE "escrows" ADD COLUMN IF NOT EXISTS "providerCommissionSnapshotAt" TIMESTAMP(3);
ALTER TABLE "escrows" ADD COLUMN IF NOT EXISTS "platformCommissionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "escrows" ADD COLUMN IF NOT EXISTS "providerNetReleasedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- PayPal deposits: net credit / fee / percent. NULL "netAmount" = an order created before the fee (the whole captured amount is credited).
ALTER TABLE "paypal_payments" ADD COLUMN IF NOT EXISTS "netAmount" DECIMAL(12,2);
ALTER TABLE "paypal_payments" ADD COLUMN IF NOT EXISTS "feeAmount" DECIMAL(12,2);
ALTER TABLE "paypal_payments" ADD COLUMN IF NOT EXISTS "feePercent" DOUBLE PRECISION;
