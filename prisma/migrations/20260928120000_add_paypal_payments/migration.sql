-- PayPal Sandbox wallet-deposit integration: adds a single pending-payment
-- table correlating a WaseetAI user, an internal deposit reference, and the
-- PayPal order/capture IDs, so the authenticated capture endpoint and the
-- webhook can both converge on the same idempotent wallet credit.
--
-- AUTHORED ONLY. Do not apply (no `prisma migrate deploy`/`dev`/`db push`
-- was run as part of authoring this file) until reviewed separately.

CREATE TYPE "PaypalPaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

CREATE TABLE "paypal_payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "paypalOrderId" TEXT NOT NULL,
    "paypalCaptureId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PaypalPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paypal_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "paypal_payments_reference_key" ON "paypal_payments"("reference");
CREATE UNIQUE INDEX "paypal_payments_paypalOrderId_key" ON "paypal_payments"("paypalOrderId");
CREATE UNIQUE INDEX "paypal_payments_paypalCaptureId_key" ON "paypal_payments"("paypalCaptureId");
CREATE INDEX "paypal_payments_userId_createdAt_idx" ON "paypal_payments"("userId", "createdAt");

ALTER TABLE "paypal_payments" ADD CONSTRAINT "paypal_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
