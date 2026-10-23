-- ARB / Neoleap bank-hosted card payments (wallet deposit). PREPARED FOR REVIEW — NOT EXECUTED on any database.
-- Additive only: one enum, one table, indexes. No existing table is altered; no data is touched.

CREATE TYPE "ArbPaymentStatus" AS ENUM ('CREATED','CREATE_UNKNOWN','CREATE_REJECTED','REDIRECTED','VERIFYING','UNCONFIRMED','CANCELLED','EXPIRED','AUTH_ONLY','DECLINED','CAPTURED_APPLIED');

CREATE TABLE "arb_payments" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "trackId" TEXT NOT NULL,
  "status" "ArbPaymentStatus" NOT NULL DEFAULT 'CREATED',
  "netUsd" DECIMAL(12,2) NOT NULL,
  "feeUsd" DECIMAL(12,2) NOT NULL,
  "feePercent" DOUBLE PRECISION NOT NULL,
  "grossUsd" DECIMAL(12,2) NOT NULL,
  "fxSarPerUsd" DECIMAL(12,6) NOT NULL,
  "amountSar" DECIMAL(12,2) NOT NULL,
  "currencyCode" TEXT NOT NULL DEFAULT '682',
  "bankPaymentId" TEXT,
  "bankTransId" TEXT,
  "bankRef" TEXT,
  "bankResult" TEXT,
  "bankAuthCode" TEXT,
  "bankCardType" TEXT,
  "paymentPageUrl" TEXT,
  "customerIp" TEXT,
  "inquiryCount" INTEGER NOT NULL DEFAULT 0,
  "lastInquiryAt" TIMESTAMP(3),
  "bankFinalAt" TIMESTAMP(3),
  "replacesId" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "walletTxId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "arb_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "arb_payments_trackId_key" ON "arb_payments"("trackId");
CREATE UNIQUE INDEX "arb_payments_bankPaymentId_key" ON "arb_payments"("bankPaymentId");
CREATE UNIQUE INDEX "arb_payments_bankTransId_key" ON "arb_payments"("bankTransId");
CREATE UNIQUE INDEX "arb_payments_walletTxId_key" ON "arb_payments"("walletTxId");
CREATE INDEX "arb_payments_userId_createdAt_idx" ON "arb_payments"("userId","createdAt");
CREATE INDEX "arb_payments_status_updatedAt_idx" ON "arb_payments"("status","updatedAt");

ALTER TABLE "arb_payments" ADD CONSTRAINT "arb_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The durable double-click / concurrent-start guarantee: at most ONE open attempt per user. (Prisma cannot express a partial index; it lives here.)
CREATE UNIQUE INDEX "ux_arb_payments_one_open_per_user" ON "arb_payments"("userId")
  WHERE "status" IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED');

-- The financial invariant at database level: an attempt can only be marked applied together with its applied time, the wallet transaction it created
-- and the bank transaction id. (Together with wallet_transactions."referenceId" UNIQUE and arb_payments."bankTransId"/"walletTxId" UNIQUE this protects the
-- money record itself, not only the attempt state.)
ALTER TABLE "arb_payments" ADD CONSTRAINT "arb_payments_applied_consistent"
  CHECK ("status" <> 'CAPTURED_APPLIED' OR ("appliedAt" IS NOT NULL AND "walletTxId" IS NOT NULL AND "bankTransId" IS NOT NULL));
