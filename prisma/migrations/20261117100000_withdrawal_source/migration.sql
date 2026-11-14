-- Each withdrawal now says which ledger it was made against (provider earnings or marketer commissions), so an account that holds BOTH roles has two independent balances.
-- Additive and nullable: no existing row is changed. NULL keeps its historical meaning (provider identity -> provider ledger, otherwise marketer ledger).
CREATE TYPE "WithdrawalSource" AS ENUM ('PROVIDER', 'MARKETER');
ALTER TABLE "withdrawals" ADD COLUMN "source" "WithdrawalSource";
CREATE INDEX "withdrawals_userId_source_status_idx" ON "withdrawals"("userId", "source", "status");
