-- Additive only. No balances, withdrawals, existing destinations or KYC are changed.
BEGIN;
CREATE TABLE "payment_methods" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" "UserRole" NOT NULL CHECK ("role" IN ('CLIENT', 'PROVIDER', 'AFFILIATE')),
  "kind" TEXT NOT NULL CHECK ("kind" IN ('PAYPAL', 'ALRAJHI')),
  "environment" TEXT NOT NULL CHECK ("environment" IN ('live', 'sandbox')),
  "encryptedDetails" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_methods_bank_not_default" CHECK ("kind" <> 'ALRAJHI' OR "isDefault" = false)
);
CREATE UNIQUE INDEX "payment_methods_userId_role_kind_environment_key" ON "payment_methods"("userId", "role", "kind", "environment");
CREATE UNIQUE INDEX "payment_methods_one_default" ON "payment_methods"("userId", "role", "environment") WHERE "isDefault";

CREATE TABLE "payment_method_authorizations" (
  "stateHash" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sessionId" TEXT NOT NULL,
  "role" "UserRole" NOT NULL CHECK ("role" IN ('CLIENT', 'PROVIDER', 'AFFILIATE')),
  "environment" TEXT NOT NULL CHECK ("environment" IN ('live', 'sandbox')),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "payment_method_authorizations_expiresAt_idx" ON "payment_method_authorizations"("expiresAt");
COMMIT;
