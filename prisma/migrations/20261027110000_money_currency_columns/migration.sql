-- Phase A of the configurable base currency (design: admin-team/system-settings/CURRENCY-TRANSITION-DESIGN.md). ADDITIVE ONLY. NOT EXECUTED on any shared environment until the plan is approved.
-- 1) every money record carries its own currency. Existing rows become 'USD' because that is the real, documented currency of everything stored so far (the platform has been USD-only).
-- 2) the three tables that already had a currency column keep every stored value; only the DEFAULT for rows written WITHOUT a currency changes from the stale 'SAR' to 'USD' (the code always writes 'USD' explicitly today).
-- Rollback: ALTER TABLE <t> DROP COLUMN "currency" for the twelve added columns; ALTER ... SET DEFAULT 'SAR' for the three defaults. No amount is touched either way.

ALTER TABLE "projects" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "client_requests" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "proposals" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "project_proposals" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "proposal_milestones" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "contracts" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "project_stages" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "escrows" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "project_amendments" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "service_catalogs" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "orders" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "coupons" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE "commission_logs" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "withdrawals" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "wallet_transactions" ALTER COLUMN "currency" SET DEFAULT 'USD';
