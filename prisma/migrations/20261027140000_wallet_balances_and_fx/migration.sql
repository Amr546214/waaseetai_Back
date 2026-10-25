-- Multi-currency infrastructure (batch C). ADDITIVE ONLY. NOT EXECUTED on any shared environment. No existing balance is renamed, converted or touched: users."walletBalance" stays the USD balance.
-- Rollback: DROP TABLE "fx_conversions"; DROP TABLE "wallet_balances";  (both are empty until a second currency is enabled, which nothing does today)
CREATE TABLE "wallet_balances" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "wallet_balances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_balances_non_negative" CHECK ("balance" >= 0),
  CONSTRAINT "wallet_balances_not_legacy" CHECK ("currency" <> 'USD')
);
CREATE UNIQUE INDEX "wallet_balances_userId_currency_key" ON "wallet_balances"("userId", "currency");
ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "fx_conversions" (
  "id" TEXT NOT NULL,
  "fromCurrency" VARCHAR(3) NOT NULL,
  "toCurrency" VARCHAR(3) NOT NULL,
  "rate" DECIMAL(18,8) NOT NULL,
  "rateSource" TEXT NOT NULL,
  "rateAt" TIMESTAMP(3) NOT NULL,
  "fromAmount" DECIMAL(18,2) NOT NULL,
  "toAmount" DECIMAL(18,2) NOT NULL,
  "feeAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "feeCurrency" VARCHAR(3),
  "roundingMode" TEXT NOT NULL DEFAULT 'HALF_AWAY_FROM_ZERO',
  "referenceType" TEXT NOT NULL,
  "referenceId" TEXT NOT NULL,
  "recordedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fx_conversions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fx_conversions_rate_positive" CHECK ("rate" > 0),
  CONSTRAINT "fx_conversions_distinct" CHECK ("fromCurrency" <> "toCurrency")
);
CREATE INDEX "fx_conversions_referenceType_referenceId_idx" ON "fx_conversions"("referenceType", "referenceId");
