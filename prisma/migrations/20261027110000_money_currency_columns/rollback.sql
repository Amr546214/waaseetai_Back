-- ROLLBACK for 20261027110000_money_currency_columns (not run by Prisma). No amount is touched. Run only if no record was created in a non-USD currency.
BEGIN;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM escrows WHERE currency <> 'USD') OR EXISTS (SELECT 1 FROM contracts WHERE currency <> 'USD') THEN RAISE EXCEPTION 'non-USD records exist; refusing to drop their currency'; END IF; END $$;
ALTER TABLE "projects" DROP COLUMN "currency"; ALTER TABLE "client_requests" DROP COLUMN "currency"; ALTER TABLE "proposals" DROP COLUMN "currency"; ALTER TABLE "project_proposals" DROP COLUMN "currency";
ALTER TABLE "proposal_milestones" DROP COLUMN "currency"; ALTER TABLE "contracts" DROP COLUMN "currency"; ALTER TABLE "project_stages" DROP COLUMN "currency"; ALTER TABLE "escrows" DROP COLUMN "currency";
ALTER TABLE "project_amendments" DROP COLUMN "currency"; ALTER TABLE "service_catalogs" DROP COLUMN "currency"; ALTER TABLE "orders" DROP COLUMN "currency"; ALTER TABLE "coupons" DROP COLUMN "currency";
ALTER TABLE "commission_logs" ALTER COLUMN "currency" SET DEFAULT 'SAR'; ALTER TABLE "withdrawals" ALTER COLUMN "currency" SET DEFAULT 'SAR'; ALTER TABLE "wallet_transactions" ALTER COLUMN "currency" SET DEFAULT 'SAR';
COMMIT;
