-- Marketer withdrawal fee snapshot (additive, nullable: NULL = no fee, i.e. providers and every earlier row).
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "feePercent" DOUBLE PRECISION;
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "feeAmount" DOUBLE PRECISION;
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "netAmount" DOUBLE PRECISION;
