-- 20-non-prisma.sql — database objects of this schema that Prisma's generated DDL does not contain.
-- Copied verbatim from prisma/migrations/20261023100000_arb_payments/migration.sql (the only migration that adds them); `prisma migrate diff` cannot express them.
-- (The other partial index of the schema, payout_attempts.active_attempt_unique, IS generated: the schema enables the partialIndexes preview feature.)

-- The durable double-click / concurrent-start guarantee: at most ONE open attempt per user. (Prisma cannot express a partial index; it lives here.)
CREATE UNIQUE INDEX "ux_arb_payments_one_open_per_user" ON "arb_payments"("userId")
  WHERE "status" IN ('CREATED','CREATE_UNKNOWN','REDIRECTED','VERIFYING','UNCONFIRMED','AUTH_ONLY');

-- The financial invariant at database level: an attempt can only be marked applied together with its applied time, the wallet transaction it created
-- and the bank transaction id. (Together with wallet_transactions."referenceId" UNIQUE and arb_payments."bankTransId"/"walletTxId" UNIQUE this protects the
-- money record itself, not only the attempt state.)
ALTER TABLE "arb_payments" ADD CONSTRAINT "arb_payments_applied_consistent"
  CHECK ("status" <> 'CAPTURED_APPLIED' OR ("appliedAt" IS NOT NULL AND "walletTxId" IS NOT NULL AND "bankTransId" IS NOT NULL));
