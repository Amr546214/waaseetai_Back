-- Versioned financial terms (fee policy). ADDITIVE ONLY. NOT EXECUTED on any shared environment until the plan is approved.
-- Version 1 is the BASELINE: exactly the values that are in force today (provider / client / marketer ladders from levels.config, deposit fee, marketer withdrawal fee table, minimum marketer payout 300,
-- no provider minimum). Seeding it changes NO current value and NO existing operation: records created before this migration carry feePolicyId NULL, which the code reads as "baseline version 1".
-- Rollback: DROP the four added columns and the table (nothing else references them).

CREATE TABLE "fee_policy_versions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "note" VARCHAR(300),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,

    CONSTRAINT "fee_policy_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fee_policy_versions_version_key" ON "fee_policy_versions"("version");
CREATE INDEX "fee_policy_versions_effectiveFrom_idx" ON "fee_policy_versions"("effectiveFrom");

ALTER TABLE "escrows" ADD COLUMN "feePolicyId" TEXT;
ALTER TABLE "paypal_payments" ADD COLUMN "feePolicyId" TEXT;
ALTER TABLE "withdrawals" ADD COLUMN "feePolicyId" TEXT;
ALTER TABLE "withdrawals" ADD COLUMN "minimumApplied" DOUBLE PRECISION;

INSERT INTO "fee_policy_versions" ("id","version","effectiveFrom","payload","note","createdAt")
VALUES ('00000000-0000-4000-8000-000000000001', 1, TIMESTAMP '2000-01-01 00:00:00', '{"providerCommissionByLevel":[12.75,12.42,12.1,11.77,11.45,11.12,10.8,10.47,10.15,9.82,9.5,9.17,8.85,8.52,8.15],"clientCashbackByLevel":[1,1.5,2,2.5,2.75,3,3.25,3.5,3.75,4,4.2,4.4,4.6,4.8,5],"marketerCommissionByLevel":[1,1.2,1.5,2,2.25,2.5,2.75,3,3.2,3.4,3.6,3.8,4,4.3,4.5],"depositFeePercent":{"mada":4.25,"visa_mastercard":5.5,"paypal":7,"international_transfer":7.5,"other":8.5},"marketerWithdrawalFeePercent":{"bank_transfer":8.25,"paypal":7.75,"usdt":4},"minMarketerPayout":300,"minProviderPayout":0}'::jsonb, 'baseline: the values in force before fee policies were managed (unchanged)', CURRENT_TIMESTAMP);
