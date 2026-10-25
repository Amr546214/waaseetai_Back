-- NOT EXECUTED ANYWHERE. Reviewed plan step: turns the two NAMED extra SUPER_ADMIN accounts into ADMIN (staff) accounts. Nothing is deleted, suspended or banned; passwords, profiles, history and every
-- other column are untouched. SUPER_ADMIN authority comes from the account type read at every request, so the change takes effect on the very next request; sessions are revoked as well, so no
-- old session or token survives the conversion (a token whose session row is revoked is refused by authenticate, and an ADMIN holds nothing until placed in the team).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v keep_id=<the SUPER_ADMIN that stays> -v id_a=<account 1> -v id_b=<account 2> -f scripts/convert-super-admin-to-admin.sql
--
-- Run it AFTER the 20261025100000_admin_team_access migration (it writes the audit trail table) and BEFORE the new application is started (the restart drops every open socket).
BEGIN;

-- psql does not substitute variables inside a dollar-quoted block, so the ids are handed to it as session settings
SELECT set_config('conv.keep', :'keep_id', true), set_config('conv.a', :'id_a', true), set_config('conv.b', :'id_b', true);

DO $$
DECLARE kept int; targets int;
BEGIN
  SELECT count(*) INTO kept FROM "users" WHERE "id" = current_setting('conv.keep') AND "accountType" = 'SUPER_ADMIN' AND "status" = 'ACTIVE' AND "isBanned" = false;
  IF kept <> 1 THEN RAISE EXCEPTION 'the SUPER_ADMIN that must stay is not an ACTIVE, un-banned SUPER_ADMIN: nothing changed'; END IF;
  IF current_setting('conv.a') = current_setting('conv.b') THEN RAISE EXCEPTION 'the two ids are the same: nothing changed'; END IF;
  IF current_setting('conv.keep') IN (current_setting('conv.a'), current_setting('conv.b')) THEN RAISE EXCEPTION 'the SUPER_ADMIN that must stay is among the accounts to convert: nothing changed'; END IF;
  SELECT count(*) INTO targets FROM "users" WHERE "id" IN (current_setting('conv.a'), current_setting('conv.b')) AND "accountType" = 'SUPER_ADMIN';
  IF targets <> 2 THEN RAISE EXCEPTION 'expected exactly two SUPER_ADMIN accounts to convert (found %): nothing changed', targets; END IF;
END $$;

-- audit first (before / after of the type), one row per account
INSERT INTO "admin_access_audit" ("id", "at", "actorId", "action", "subjectUserId", "before", "after")
SELECT gen_random_uuid()::text, now(), :'keep_id', 'ACCOUNT_TYPE_CHANGED', u."id",
       jsonb_build_object('accountType', u."accountType", 'roles', u."roles", 'activeRole', u."activeRole"),
       jsonb_build_object('accountType', 'ADMIN', 'roles', (SELECT array_agg(DISTINCT r) FROM unnest(array_append(u."roles", 'ADMIN'::"UserRole")) r), 'activeRole', 'ADMIN')
FROM "users" u WHERE u."id" IN (:'id_a', :'id_b');

-- the conversion: type, roles (existing roles kept, ADMIN added) and the active role. NOTHING else is written.
UPDATE "users"
   SET "accountType" = 'ADMIN',
       "roles" = (SELECT array_agg(DISTINCT r) FROM unnest(array_append("roles", 'ADMIN'::"UserRole")) r),
       "activeRole" = 'ADMIN'
 WHERE "id" IN (:'id_a', :'id_b') AND "accountType" = 'SUPER_ADMIN'
RETURNING "id", "accountType", "roles", "activeRole", "status";

-- no old session keeps working: every session of the two accounts is revoked (rows are kept, not deleted)
UPDATE "user_sessions" SET "revokedAt" = now() WHERE "userId" IN (:'id_a', :'id_b') AND "revokedAt" IS NULL;

COMMIT;
