-- ROLLBACK for 20261027150000_site_identity. NOT EXECUTED anywhere; not run by Prisma. Apply by hand only if the release is reverted.
-- Effect: the three tables and every custom identity asset in them are removed; the site falls back to the built-in default identity (which is what it showed before the migration).
-- The old BE image ignores these tables, so the schema may also simply be kept. Before dropping, take a dump so custom assets can be restored later:
--   pg_dump --data-only --table=site_identity_assets --table=site_identity_state --table=site_identity_manifest ...
BEGIN;
DROP TABLE IF EXISTS "site_identity_state";
DROP TABLE IF EXISTS "site_identity_manifest";
DROP TABLE IF EXISTS "site_identity_assets";
COMMIT;
