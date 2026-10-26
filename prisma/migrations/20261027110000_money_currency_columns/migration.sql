-- Phase A of the configurable base currency (design: admin-team/system-settings/CURRENCY-TRANSITION-DESIGN.md). ADDITIVE ONLY. NOT EXECUTED on any shared environment until the plan is approved.
-- 1) every money record carries its own currency. The twelve new columns default to 'USD' ONLY IF THE DATA PROVES IT (see the guard below): the platform has been USD/PayPal-only since 2026-09-28
--    (Moyasar, the only SAR rail, credited wallets from 2026-08-31 and was disabled then), and every creation path writes USD. Evidence: scripts/currency-evidence-probe.sql (read-only) + git history.
-- 2) the three ledger tables that already had a currency column keep EVERY stored value (nothing is relabelled here); only the DEFAULT for rows written WITHOUT a currency changes from the stale 'SAR' to 'USD'.
--    A 'SAR' label on a row that no SAR rail produced is a stale-default LABEL, not a SAR amount; correcting those labels needs the separate, approved script scripts/currency-label-correction.sql.
-- Rollback: ALTER TABLE <t> DROP COLUMN "currency" for the twelve added columns; ALTER ... SET DEFAULT 'SAR' for the three defaults. No amount is touched either way.

-- GUARD: refuse to stamp USD on history that contains a real SAR amount. If this aborts, run the probe, decide per account, and stamp by evidence instead of by default.
DO $$
DECLARE n integer;
BEGIN
  IF to_regclass('wallet_transactions') IS NOT NULL THEN
    SELECT COUNT(*) INTO n FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%';
    IF n > 0 THEN
      RAISE EXCEPTION 'currency phase A aborted: % wallet transaction(s) came from the SAR rail (Moyasar). Existing money rows cannot be stamped USD by default; run scripts/currency-evidence-probe.sql and decide per account.', n;
    END IF;
  END IF;
END $$;

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
