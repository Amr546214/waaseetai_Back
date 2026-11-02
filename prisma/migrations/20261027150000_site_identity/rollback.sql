-- ROLLBACK for 20261027150000_site_identity. NOT EXECUTED anywhere; not run by Prisma.
--
-- !! DO NOT RUN THIS AFTER THE FEATURE WAS USED !!  Operational rollback of a release = swap the code containers only (the previous BE image ignores these tables). The identity / asset / history
-- tables STAY: they hold the owner's published logos, tokens and the full version history. This file exists only to undo an EMPTY, never-used migration (e.g. a failed rehearsal).
-- Guard: the script RAISES (and, being one transaction, drops nothing) when ANY site_identity_* table contains a row. To really discard used data an operator must first take a pg_dump of the three tables
-- and then remove the rows deliberately (a separate, explicit decision) - this script will never do it for you.
BEGIN;
DO $guard$
DECLARE
  t text;
  n bigint;
  total bigint := 0;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'site\_identity\_%' LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    total := total + n;
    IF n > 0 THEN
      RAISE EXCEPTION 'rollback.sql refused: table % has % row(s). The site identity feature was used; do NOT drop its tables. Roll back by swapping the code containers only (the tables stay).', t, n;
    END IF;
  END LOOP;
END
$guard$;
DROP TABLE IF EXISTS "site_identity_state";
DROP TABLE IF EXISTS "site_identity_manifest";
DROP TABLE IF EXISTS "site_identity_assets";
COMMIT;
