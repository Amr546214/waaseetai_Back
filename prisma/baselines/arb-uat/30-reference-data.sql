-- 30-reference-data.sql — the only DATA that the migration history inserts into an empty database
-- (prisma/migrations/20260901120000_add_cart_checkout/migration.sql, a 10 % WASEET10 coupon). Every other INSERT/UPDATE in the history is a backfill of rows that an empty database does not have.
-- Remove this file from the run list if the new environment must not carry the coupon; nothing else depends on it.
INSERT INTO "coupons" ("id", "code", "discountType", "discountValue", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000010', 'WASEET10', 'percentage', 10, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
