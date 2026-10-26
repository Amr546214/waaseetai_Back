-- ROLLBACK for 20261027110000_money_currency_columns (not run by Prisma). No amount is touched. Run only if no record was created in a non-USD currency.
BEGIN;
DO $$
DECLARE t text; n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','client_requests','proposals','project_proposals','proposal_milestones','contracts','project_stages','escrows','project_amendments','service_catalogs','orders','coupons'] LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I WHERE currency <> ''USD''', t) INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'refusing to drop the currency column: % row(s) of % are not USD. After a non-USD operation exists there is no way back to USD-only code or schema.', n, t; END IF;
  END LOOP;
END $$;
ALTER TABLE "projects" DROP COLUMN "currency"; ALTER TABLE "client_requests" DROP COLUMN "currency"; ALTER TABLE "proposals" DROP COLUMN "currency"; ALTER TABLE "project_proposals" DROP COLUMN "currency";
ALTER TABLE "proposal_milestones" DROP COLUMN "currency"; ALTER TABLE "contracts" DROP COLUMN "currency"; ALTER TABLE "project_stages" DROP COLUMN "currency"; ALTER TABLE "escrows" DROP COLUMN "currency";
ALTER TABLE "project_amendments" DROP COLUMN "currency"; ALTER TABLE "service_catalogs" DROP COLUMN "currency"; ALTER TABLE "orders" DROP COLUMN "currency"; ALTER TABLE "coupons" DROP COLUMN "currency";
ALTER TABLE "commission_logs" ALTER COLUMN "currency" SET DEFAULT 'SAR'; ALTER TABLE "withdrawals" ALTER COLUMN "currency" SET DEFAULT 'SAR'; ALTER TABLE "wallet_transactions" ALTER COLUMN "currency" SET DEFAULT 'SAR';
COMMIT;
