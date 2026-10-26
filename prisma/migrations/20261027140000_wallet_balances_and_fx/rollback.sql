-- ROLLBACK for 20261027140000_wallet_balances_and_fx (not run by Prisma). Safe while no second currency was ever used (both tables are empty). If wallet_balances holds rows, those are real money in another currency: DO NOT drop them - roll the code back instead.
BEGIN;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM wallet_balances WHERE balance <> 0) THEN RAISE EXCEPTION 'wallet_balances holds non-zero balances; refusing to drop real money'; END IF; END $$;
DROP TABLE IF EXISTS "fx_conversions";
DROP TABLE IF EXISTS "wallet_balances";
COMMIT;
