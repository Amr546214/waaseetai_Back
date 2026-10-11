-- Rollback for 20261011130000 (drops only the columns it added; they hold nothing else).
ALTER TABLE "escrows" DROP COLUMN IF EXISTS "feePolicyVersion";
ALTER TABLE "escrows" DROP COLUMN IF EXISTS "providerCommissionRateSnapshot";
ALTER TABLE "escrows" DROP COLUMN IF EXISTS "providerCommissionLevelSnapshot";
ALTER TABLE "escrows" DROP COLUMN IF EXISTS "providerCommissionSnapshotAt";
ALTER TABLE "escrows" DROP COLUMN IF EXISTS "platformCommissionAmount";
ALTER TABLE "escrows" DROP COLUMN IF EXISTS "providerNetReleasedAmount";
ALTER TABLE "paypal_payments" DROP COLUMN IF EXISTS "netAmount";
ALTER TABLE "paypal_payments" DROP COLUMN IF EXISTS "feeAmount";
ALTER TABLE "paypal_payments" DROP COLUMN IF EXISTS "feePercent";
